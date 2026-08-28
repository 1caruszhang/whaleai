import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountState } from '@/api/accountClient';
import {
  accountRefresh,
  accountLogout,
  fetchAccountState,
} from '@/api/accountClient';
import AccountProvider from './AccountProvider';
import { useAccountApi, useAccountReady, useAccountState } from './AccountContext';

vi.mock('@/api/accountClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/accountClient')>()),
  fetchAccountState: vi.fn(),
  accountLogin: vi.fn(),
  accountChangePassword: vi.fn(),
  accountRefresh: vi.fn(),
  accountLogout: vi.fn(),
}));

const mockedFetchState = vi.mocked(fetchAccountState);
const mockedRefresh = vi.mocked(accountRefresh);
const mockedLogout = vi.mocked(accountLogout);

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    loggedIn: true,
    phone: '13800001234',
    points: 10,
    status: 'active',
    mustChangePassword: false,
    agreementAccepted: true,
    offlineGrace: { within: true, lastServerContactAt: 1, deadlineAt: 2 },
    ...overrides,
  };
}

/** 探针：暴露 Provider 的投影与 requireBalance 守卫结果。 */
function Probe({ onRequire }: { onRequire: (allowed: boolean) => void }) {
  const ready = useAccountReady();
  const state = useAccountState();
  const api = useAccountApi();
  if (!ready) return <p data-testid="probe-loading">loading</p>;
  return (
    <div>
      <span data-testid="probe-points">{state.points ?? 'none'}</span>
      <button type="button" onClick={() => onRequire(api.requireBalance(25))}>
        require-25
      </button>
    </div>
  );
}

describe('AccountProvider（票 06 账号投影与余额守卫）', () => {
  beforeEach(() => {
    // resetAllMocks 连实现一起清：clearAllMocks 只清调用记录，其他用例
    // mockResolvedValue 的投影（如静默刷新的 480 点）会泄漏进本用例，
    // 把余额守卫的断言翻转成偶发失败（shuffle/负载下可复现）。
    vi.resetAllMocks();
  });

  it('挂载后加载 Rust 投影，余额不足时弹窗数字正确', async () => {
    mockedFetchState.mockResolvedValue(account({ points: 10 }));
    const results: boolean[] = [];
    render(
      <AccountProvider>
        <Probe onRequire={(ok) => results.push(ok)} />
      </AccountProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('probe-points').textContent).toBe('10'));
    // 冲刷 passive effects：requireBalance 经 stateRef 读取投影，ref 在
    // effect 内同步；等 DOM 出现「10」与 ref 完成同步之间理论上有窗口。
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'require-25' }));
    // 守卫返回 false，弹窗如实展示「需 25 点 / 当前 10 点」。
    expect(results).toEqual([false]);
    expect(await screen.findByRole('alertdialog', { name: '点数余额不足' })).toBeTruthy();
    expect(screen.getByText('本次操作需 25 点，当前余额 10 点。')).toBeTruthy();
    expect(screen.getByText(/请充值后重试：通过对公账户转账并联系运营确认入账。/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // 余额充足（或发起低价操作）时不弹窗。
    fireEvent.click(screen.getByRole('button', { name: 'require-25' }));
    // requireBalance(25) 仍不足：这里验证守卫可重复触发同一弹窗。
    expect(await screen.findByRole('alertdialog', { name: '点数余额不足' })).toBeTruthy();
    expect(results).toEqual([false, false]);
  });

  it('初始读取失败回落到未登录投影而不是卡在启动屏', async () => {
    mockedFetchState.mockRejectedValue(new Error('backend offline'));
    render(
      <AccountProvider>
        <Probe onRequire={() => undefined} />
      </AccountProvider>,
    );
    // ready 翻转后探针脱离 loading；静默刷新失败（未 mock）不破坏投影。
    await waitFor(() => expect(screen.queryByTestId('probe-loading')).toBeNull());
    expect(screen.getByTestId('probe-points').textContent).toBe('none');
  });

  it('退出登录调用 Rust owner 并更新投影', async () => {
    // 宽限外的投影：静默余额刷新门（offlineGrace.within）保持关闭。刷新
    // effect 的挂载可能晚于登出点击（passive effects 冲刷时序），若本用例
    // 的 mock 刷新返回登录态投影，会把登出后的状态又翻回 logged-in。
    const outsideGrace = account({
      offlineGrace: { within: false, lastServerContactAt: 1, deadlineAt: 2 },
    });
    mockedFetchState.mockResolvedValue(outsideGrace);
    mockedRefresh.mockResolvedValue(outsideGrace);
    mockedLogout.mockResolvedValue(
      account({
        loggedIn: false,
        phone: null,
        points: null,
        offlineGrace: { within: false, lastServerContactAt: null, deadlineAt: null },
      }),
    );
    function LogoutProbe() {
      const state = useAccountState();
      const api = useAccountApi();
      return (
        <button type="button" onClick={() => void api.logout()}>
          logout-{state.loggedIn ? 'in' : 'out'}
        </button>
      );
    }
    render(
      <AccountProvider>
        <LogoutProbe />
      </AccountProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'logout-in' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'logout-in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'logout-out' })).toBeTruthy());
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it('进入已登录态后做一次静默余额刷新', async () => {
    mockedFetchState.mockResolvedValue(account({ points: 10 }));
    mockedRefresh.mockResolvedValue(account({ points: 480 }));
    render(
      <AccountProvider>
        <Probe onRequire={() => undefined} />
      </AccountProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe-points').textContent).toBe('480'));
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
  });
});
