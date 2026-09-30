import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
  /** 折线序列：把 name 投到 DOM 供接线断言。 */
  const Series = ({ name }: { name?: string }) => (
    <span data-testid={`chart-series-${name ?? ''}`}>{name ?? ''}</span>
  );
  return {
    ResponsiveContainer: Passthrough,
    LineChart: Passthrough,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
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
  render(
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
});
