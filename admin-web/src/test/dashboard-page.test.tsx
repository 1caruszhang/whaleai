import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAdminMediaPool,
  getAdminStatsOverview,
  type AdminMediaPool,
  type AdminStatsOverview,
} from '@/lib/dashboard';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/routes/routes';

/**
 * 仪表盘首页（票 48 次 seam，Vitest + RTL）：mock API 层，只测外部行为——
 * 总览卡数值、近 30 天折线图（两条序列接线断言）、媒介池卡的低余额
 * 预存提醒与上游失败降级文案（降级不阻断页面其余部分）、统计失败的错误态。
 * recharts 整体 mock：图表渲染是库职责，本页契约是数据序列与线名接线；
 * 同时避免 jsdom 下真实 SVG 渲染拖慢整包测试（本机并行 worker 争抢）。
 *
 * 票 #61 T-B 扩展：加载态骨架屏（替代「加载中/…」文字）、降级卡样式、
 * 卡片入场淡入与错峰延迟等视觉断言；既有语义断言全部保留。
 */
vi.mock('@/lib/dashboard', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/dashboard')>();
  return {
    ...actual,
    getAdminStatsOverview: vi.fn(),
    getAdminMediaPool: vi.fn(),
  };
});

vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  /** 图表容器用 <svg> 包裹：页面里的 defs/linearGradient 等 SVG 子元素在
   *  jsdom 下走 SVG 命名空间，避免 React 大小写告警污染测试输出。 */
  const Svg = ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>;
  /** 折线序列：把 name 投到 DOM 供接线断言。 */
  const Series = ({ name }: { name?: string }) => (
    <span data-testid={`chart-series-${name ?? ''}`}>{name ?? ''}</span>
  );
  return {
    ResponsiveContainer: Passthrough,
    LineChart: Svg,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
    Area: () => null,
    Line: Series,
  };
});

const mockedStats = vi.mocked(getAdminStatsOverview);
const mockedMediaPool = vi.mocked(getAdminMediaPool);

const TOKEN_KEY = 'xiaojing-admin-token';

const STATS: AdminStatsOverview = {
  accounts: { total: 3, active: 2, disabled: 1 },
  balance: { total: 1500, frozen: 200, available: 1300 },
  today: { topup: 1400, consume: 150 },
  dailySeries: [
    { date: '2026-09-28', topup: 0, consume: 0 },
    { date: '2026-09-29', topup: 300, consume: 0 },
    { date: '2026-09-30', topup: 1400, consume: 150 },
  ],
};

const MEDIA_POOL_OK: AdminMediaPool = {
  degraded: false,
  balanceCents: 128000,
  lowBalanceCents: 50000,
  lowBalance: false,
};

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter basename="/admin" initialEntries={['/admin/']}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedStats.mockReset();
  mockedMediaPool.mockReset();
  window.localStorage.setItem(TOKEN_KEY, 'test-admin-token');
});

describe('仪表盘首页（票 48）', () => {
  it('渲染总览卡数值与近 30 天折线图图例', async () => {
    mockedStats.mockResolvedValue(STATS);
    mockedMediaPool.mockResolvedValue(MEDIA_POOL_OK);
    renderDashboard();

    expect(await screen.findByText('活跃 2 · 停用 1')).toBeInTheDocument();
    expect(screen.getByText('账号总数')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('余额（点）')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('可用 1,300 · 冻结 200')).toBeInTheDocument();
    expect(screen.getByText('今日充值（点）')).toBeInTheDocument();
    expect(screen.getByText('1,400')).toBeInTheDocument();
    expect(screen.getByText('今日扣点（点）')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();

    // 折线图：卡片标题 + 两条序列接线（充值/扣点）。
    expect(screen.getByText('近 30 天充值 / 扣点趋势')).toBeInTheDocument();
    expect(screen.getByTestId('chart-series-充值')).toHaveTextContent('充值');
    expect(screen.getByTestId('chart-series-扣点')).toHaveTextContent('扣点');
  });

  it('媒介池低于阈值时出预存提醒文案', async () => {
    mockedStats.mockResolvedValue(STATS);
    mockedMediaPool.mockResolvedValue({
      degraded: false,
      balanceCents: 32050,
      lowBalanceCents: 50000,
      lowBalance: true,
    });
    renderDashboard();

    expect(await screen.findByText('¥320.50')).toBeInTheDocument();
    expect(screen.getByText('超级媒介资金池')).toBeInTheDocument();
    expect(
      screen.getByText('媒介池余额低于 ¥500.00，请及时预存资金池。'),
    ).toBeInTheDocument();
  });

  it('媒介池上游失败显示降级文案且不阻断页面其余部分', async () => {
    mockedStats.mockResolvedValue(STATS);
    mockedMediaPool.mockResolvedValue({ degraded: true, lowBalanceCents: 50000 });
    renderDashboard();

    expect(
      await screen.findByText('余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。'),
    ).toBeInTheDocument();
    // 总览卡与趋势图照常渲染。
    expect(screen.getByText('账号总数')).toBeInTheDocument();
    expect(screen.getByText('活跃 2 · 停用 1')).toBeInTheDocument();
    expect(screen.getByText('近 30 天充值 / 扣点趋势')).toBeInTheDocument();
  });

  it('统计接口失败显示错误态，媒介池卡不受影响', async () => {
    mockedStats.mockRejectedValue(new Error('boom'));
    mockedMediaPool.mockResolvedValue(MEDIA_POOL_OK);
    renderDashboard();

    expect(await screen.findByText('统计加载失败，请稍后刷新重试。')).toBeInTheDocument();
    expect(screen.getByText('趋势数据加载失败')).toBeInTheDocument();
    expect(await screen.findByText('¥1280.00')).toBeInTheDocument();
  });

  it('加载中四卡与折线图渲染骨架屏（无「加载中/…」文字）', async () => {
    mockedStats.mockReturnValue(new Promise<AdminStatsOverview>(() => {}));
    mockedMediaPool.mockReturnValue(new Promise<AdminMediaPool>(() => {}));
    const { container } = renderDashboard();

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });
    // 折线图骨架占位与统计卡标题同屏；旧「…/加载中」文字全部退场。
    expect(screen.getByTestId('chart-skeleton')).toBeInTheDocument();
    expect(screen.getByText('账号总数')).toBeInTheDocument();
    expect(screen.queryByText('加载中')).not.toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });

  it('媒介池降级卡保留降级样式：卡头描述 + 降级文案 + 入场动画', async () => {
    mockedStats.mockResolvedValue(STATS);
    mockedMediaPool.mockResolvedValue({ degraded: true, lowBalanceCents: 50000 });
    const { container } = renderDashboard();

    expect(
      await screen.findByText('余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。'),
    ).toBeInTheDocument();
    expect(screen.getByText('资金池预警与预存入口')).toBeInTheDocument();
    const cards = [...container.querySelectorAll('[data-slot="card"]')];
    expect(cards.some(card => card.className.includes('animate-in'))).toBe(true);
  });

  it('卡片入场动画：淡入类 + 错峰 animation-delay', async () => {
    mockedStats.mockResolvedValue(STATS);
    mockedMediaPool.mockResolvedValue(MEDIA_POOL_OK);
    const { container } = renderDashboard();

    expect(await screen.findByText('活跃 2 · 停用 1')).toBeInTheDocument();
    const animated = [...container.querySelectorAll('[data-slot="card"]')].filter(card =>
      card.className.includes('animate-in'),
    );
    expect(animated.length).toBeGreaterThanOrEqual(6);
    const delays = animated
      .map(card => (card as HTMLElement).style.animationDelay)
      .filter(delay => delay !== '');
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});
