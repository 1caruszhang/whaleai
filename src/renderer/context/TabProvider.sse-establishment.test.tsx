/**
 * TabProvider — SSE 订阅建立回归。
 *
 * 症状（2026-08-16 统一日志 unified-2026-08-16.log）：新建聊天 Tab 挂载后，
 * `start_sse_proxy` 至多成功一次、随即被 stop，此后任何 Tab/会话/窗口重载
 * 都再无订阅建立；`isConnected` 永远 false，`sendBlocked` 常驻，用户无法发送
 * 任何消息（全程没有一条 POST /chat/send）。
 *
 * 根因假设：App/MemoizedTabContent 每次渲染都向 TabProvider 传新的内联回调，
 * 而 TabProvider 的 `onGeneratingChange`/`onUnreadChange` effect 依赖回调
 * 身份并回写 App 的 tabs state（`.map` 恒返回新数组）→ 自激重渲染循环 →
 * SSE effect 每轮被拆掉，connectTauri 在 9 次 listen 完成前被取消。
 *
 * 本测试复刻该回调管线并验证：
 *  1. 挂载的聊天 Tab 能调用到 `start_sse_proxy`（SSE 订阅建立）；
 *  2. 最终 proxy 状态不是 stop（停掉后无重建 = Tab 永久静音）；
 *  3. 父组件渲染次数有界（不进入自激循环）。
 */
import { render } from '@testing-library/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const commands: Array<{ cmd: string; key?: string }> = [];
    // 与真实 Tauri IPC 同量级的往返延迟（listen/start 各 ~2ms）。
    // 即时 resolve 的 mock 会让 connect 在下一轮清理前完成，掩盖竞态。
    const ipcDelay = () => new Promise<void>((resolve) => { setTimeout(resolve, 2); });
    return {
        commands,
        ipcDelay,
        listenImpl: vi.fn(async (eventName: string) => {
            await ipcDelay();
            return () => { void eventName; };
        }),
        invokeImpl: vi.fn(async (cmd: string, args?: { connectionKey?: string }) => {
            await ipcDelay();
            commands.push({ cmd, key: args?.connectionKey });
            return undefined;
        }),
    };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listenImpl }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invokeImpl }));
vi.mock('@/utils/browserMock', () => ({
    isTauriEnvironment: () => true,
    isBrowserDevMode: () => false,
    mockGetServerUrl: () => 'http://127.0.0.1:3000',
}));
vi.mock('@/api/tauriClient', () => ({
    sessionSidecarFetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, session: { messages: [] } }),
    })),
}));

import TabProvider from './TabProvider';

interface HarnessTab { id: string; isGenerating: boolean; hasUnread: boolean }

/** 循环熔断：渲染超过该次数即认定自激循环并停止回写，防止测试进程 OOM。 */
const RENDER_FUSE = 40;
// effect 内计数、渲染期只读（react-hooks 规则禁止渲染期写 ref/外部对象）。
const harnessStats = { renders: 0 };

/**
 * 复刻 App.tsx + MemoizedTabContent 的回调管线：内联回调每次渲染重建，
 * updateTab 用 `.map` 生成全新数组（与 App 的 setTabs 语义一致）。
 */
function Harness({ children }: { children?: ReactNode }) {
    // 熔断后停止回写、置为非激活，只用于让存在循环时测试可收敛。
    const tripped = harnessStats.renders > RENDER_FUSE;
    const [, setTabsState] = useState<HarnessTab[]>([{ id: 'tab-1', isGenerating: false, hasUnread: false }]);
    useEffect(() => { harnessStats.renders += 1; });

    const setTabs = useCallback((update: (current: HarnessTab[]) => HarnessTab[]) => {
        setTabsState((current) => update(current));
    }, []);
    const updateTab = useCallback((tabId: string, patch: Partial<HarnessTab>) => {
        if (harnessStats.renders > RENDER_FUSE) return;
        setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
    }, [setTabs]);
    const claim = useCallback(() => () => {}, []);

    return (
        <TabProvider
            tabId="tab-1"
            workspacePath="/workspace/brand-a"
            sessionId="session-1"
            sessionTitle="brand-a"
            isActive={!tripped}
            onGeneratingChange={(value) => updateTab('tab-1', { isGenerating: value })}
            onTitleChange={() => { /* inline, unstable by design */ }}
            onUnreadChange={(value) => updateTab('tab-1', { hasUnread: value })}
            claimSessionOpeningTransition={claim}
        >
            {children ?? <div>chat surface</div>}
        </TabProvider>
    );
}

describe('TabProvider SSE 订阅建立', () => {
    beforeEach(() => {
        mocks.commands.length = 0;
        mocks.invokeImpl.mockClear();
        mocks.listenImpl.mockClear();
        harnessStats.renders = 0;
    });

    it('挂载聊天 Tab 后建立并维持 SSE proxy 订阅（用户可发送消息的前提）', async () => {
        render(<Harness />);
        await new Promise((resolve) => { setTimeout(resolve, 300); });

        const starts = mocks.commands.filter((entry) => entry.cmd === 'start_sse_proxy');
        const stops = mocks.commands.filter((entry) => entry.cmd === 'stop_sse_proxy');
        const lastProxyCommand = mocks.commands
            .filter((entry) => entry.cmd === 'start_sse_proxy' || entry.cmd === 'stop_sse_proxy')
            .at(-1)?.cmd;

        // 循环证据：静置 300ms 后渲染次数必须远低于熔断阈值。
        expect(harnessStats.renders).toBeLessThan(RENDER_FUSE);
        // 症状断言：SSE 订阅至少建立一次…
        expect(starts.length).toBeGreaterThanOrEqual(1);
        // …且最终状态不是被停掉（停掉后无重建 = Tab 永久静音、无法发送）。
        expect(lastProxyCommand).toBe('start_sse_proxy');
        expect(stops.length).toBeLessThanOrEqual(starts.length - 1);
    });
});
