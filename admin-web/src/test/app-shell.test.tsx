import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteProgress } from '@/components/route-progress';
import { Skeleton } from '@/components/ui/skeleton';
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
 *
 * 票 #60 T-A 起同文件扩展壳与主题断言：侧栏折叠（icon-only + tooltip +
 * transition-[width]）、页头元素（面包屑/搜索框/主题开关/用户菜单）、搜索框
 * 唤起 Cmd+K 面板（结果区 faded-bottom）、主题切换动画类（双图标 scale/rotate
 * 交叉淡入 + theme-transition）、Skeleton 渲染、路由进度条（location.key 扫描）。
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
const SIDEBAR_COLLAPSED_KEY = 'xiaojing-admin-sidebar-collapsed';

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

describe('壳与主题（票 #60 T-A）', () => {
  it('侧栏可折叠：折叠按钮切换 icon-only 态（transition-[width] 过渡、title tooltip、文本 sr-only）', async () => {
    const user = userEvent.setup();
    renderApp();

    const aside = document.getElementById('app-sidebar')!;
    expect(aside).toHaveClass('w-60', 'transition-[width]', 'duration-200', 'ease-linear');

    const dashboardLink = await screen.findByRole('link', { name: '仪表盘' });
    expect(dashboardLink).not.toHaveAttribute('title');

    await user.click(screen.getByRole('button', { name: '折叠侧栏' }));
    expect(aside).toHaveClass('w-14');
    expect(aside).not.toHaveClass('w-60');
    // icon-only：链接仍以标签为可访问名（sr-only 文本），title 提供 tooltip。
    expect(dashboardLink).toHaveAttribute('title', '仪表盘');
    expect(within(dashboardLink).getByText('仪表盘')).toHaveClass('sr-only');
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');

    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(aside).toHaveClass('w-60');
    expect(within(dashboardLink).getByText('仪表盘')).not.toHaveClass('sr-only');
    expect(dashboardLink).not.toHaveAttribute('title');
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
  });

  it('折叠态持久化：重进壳恢复 icon-only 侧栏', async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    renderApp();

    const aside = document.getElementById('app-sidebar')!;
    expect(aside).toHaveClass('w-14');
    expect(await screen.findByRole('button', { name: '展开侧栏' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '仪表盘' })).toHaveAttribute('title', '仪表盘');
  });

  it('页头元素：面包屑页面标题、搜索框样式与快捷键、主题开关、用户菜单', async () => {
    renderApp();

    const breadcrumb = await screen.findByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumb).getByRole('link', { name: '运营台' })).toHaveAttribute('href', '/admin');
    expect(within(breadcrumb).getByText('仪表盘')).toHaveAttribute('aria-current', 'page');

    const search = screen.getByRole('button', { name: '打开全局搜索' });
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');

    expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '账户菜单' })).toBeInTheDocument();
  });

  it('账号详情路由：面包屑含可点击的「账号」层级与「账号详情」当前页', async () => {
    renderApp('/admin/accounts/acc-1');

    const breadcrumb = await screen.findByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumb).getByRole('link', { name: '账号' })).toHaveAttribute(
      'href',
      '/admin/accounts',
    );
    expect(within(breadcrumb).getByText('账号详情')).toHaveAttribute('aria-current', 'page');
  });

  it('页头搜索框点击唤起 Cmd+K 面板（结果区带 faded-bottom 遮罩工具类）', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开全局搜索' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('全局搜索账号')).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: '搜索结果' })).toHaveClass('faded-bottom');
  });

  it('主题切换：日/月双图标 scale/rotate 交叉淡入类 + theme-transition 过渡类', async () => {
    const user = userEvent.setup();
    renderApp();

    const toggle = screen.getByRole('button', { name: '切换主题' });
    // 双图标同层叠放：Sun 常规态（dark 下 scale-0/-rotate-90）、Moon 深色态（dark 下
    // scale-100/rotate-0）——浅色显示日、深色显示月，交叉淡入靠 dark 变体类翻转。
    expect(toggle.querySelector('[class*="dark:scale-0"]')).toBeInTheDocument();
    expect(toggle.querySelector('[class*="dark:-rotate-90"]')).toBeInTheDocument();
    expect(toggle.querySelector('[class*="dark:scale-100"]')).toBeInTheDocument();
    expect(toggle.querySelector('[class*="dark:rotate-0"]')).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('theme-transition');

    await user.click(toggle);
    await user.click(await screen.findByRole('menuitem', { name: '深色' }));
    expect(document.documentElement).toHaveClass('dark');
    // 非瞬时翻转：切换时补 theme-transition 过渡类，播完后自行移除。
    expect(document.documentElement).toHaveClass('theme-transition');
    await vi.waitFor(() => expect(document.documentElement).not.toHaveClass('theme-transition'));
  });

  it('Skeleton 骨架屏：animate-pulse 渲染（data-slot 与默认样式类）', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-32" />);

    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton).toHaveAttribute('data-slot', 'skeleton');
    expect(skeleton).toHaveClass('animate-pulse', 'rounded-md', 'bg-accent', 'h-4', 'w-32');
  });

  it('路由进度条：导航提交后扫描一次并自行移除（location.key 驱动）', async () => {
    const { rerender } = render(<RouteProgress locationKey="key-1" />);
    expect(screen.queryByTestId('route-progress')).not.toBeInTheDocument();

    rerender(<RouteProgress locationKey="key-2" />);
    expect(screen.getByTestId('route-progress')).toHaveClass('route-progress');
    await vi.waitFor(() => expect(screen.queryByTestId('route-progress')).not.toBeInTheDocument());
  });

  it('壳内切页触发进度条扫描：点击导航项后进度条出现并自行移除', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.queryByTestId('route-progress')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('link', { name: '账号' }));
    expect(screen.getByTestId('route-progress')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByTestId('route-progress')).not.toBeInTheDocument());
  });
});
