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
 * 侧栏导航（票 #58，Vitest + RTL）：mock API 层，只测外部行为——「偏好名单」
 * 导航项以普通 <a> 渲染，href 指向保留的后端 SSR 页 /admin/preference-channels
 * （带 /admin basename 前缀，不是 SPA 路由）；SPA 自有的仪表盘/账号导航项
 * 不受影响。路由表内没有偏好名单的 SPA 路由：以该路径进入时走兜底 * 重定向
 * 回仪表盘（证明该 URL 由服务端承接）。recharts 整体 mock 同仪表盘页测试。
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
  /** 折线序列：把 name 投到 DOM 供接线断言（本文件只渲染不细断言）。 */
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

function renderApp(initialPath = '/admin/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter basename="/admin" initialEntries={[initialPath]}>
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
  mockedStats.mockResolvedValue(STATS);
  mockedMediaPool.mockResolvedValue(MEDIA_POOL_OK);
});

describe('侧栏导航（票 #58）', () => {
  it('渲染「偏好名单」导航项：普通 <a>，href 指向 /admin/preference-channels（SSR 页）', async () => {
    renderApp();

    const link = await screen.findByRole('link', { name: '偏好名单' });
    expect(link.tagName).toBe('A');
    // 后端 SSR 页 URL 带 /admin basename 前缀——不是 SPA 路由（路由表无此路径）。
    expect(link).toHaveAttribute('href', '/admin/preference-channels');
    // 会话衔接：SPA 登录写下的 xiaojing_admin cookie 被 SSR 页直接复用，侧栏不重复登录。
    expect(link).toBeVisible();
  });

  it('SPA 自有导航项不受影响：仪表盘/账号仍走 react-router 相对路由', async () => {
    renderApp();

    expect(await screen.findByRole('link', { name: '仪表盘' })).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('link', { name: '账号' })).toHaveAttribute('href', '/admin/accounts');
  });

  it('偏好名单路径不是 SPA 路由：SPA 内直接进入该 URL 走兜底重定向回仪表盘', async () => {
    // 路由表（routes.tsx）没有 /preference-channels 条目：SPA 不拥有该 URL，
    // 证明侧栏 href 指向的必是服务端承接的 SSR 页而非前端路由。
    renderApp('/admin/preference-channels');

    expect(await screen.findByRole('heading', { name: '仪表盘' })).toBeInTheDocument();
  });
});
