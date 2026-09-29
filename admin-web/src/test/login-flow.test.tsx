import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, loginAdmin } from '@/lib/api';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/routes/routes';

/**
 * 登录闭环（票 46 次 seam，Vitest + RTL）：mock API 层，只测外部行为——
 * 未登录访问任意 /admin 路由 → 登录页；错误密码有错误提示；登录成功进入
 * 受保护壳；退出登录清 token 回登录页。声明式 MemoryRouter 与生产
 * BrowserRouter 同模式（均走 history 导航，不构造 data-router Request）。
 */
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, loginAdmin: vi.fn() };
});

const mockedLogin = vi.mocked(loginAdmin);
const TOKEN_KEY = 'xiaojing-admin-token';

function renderApp(initialPath = '/admin/login') {
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

async function fillAndSubmit(password: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('运营密码'), password);
  await user.click(screen.getByRole('button', { name: '登录' }));
}

beforeEach(() => {
  mockedLogin.mockReset();
});

describe('登录闭环（票 46）', () => {
  it('未登录访问任意受保护路由 → 登录页', () => {
    renderApp('/admin/accounts');
    expect(screen.getByRole('heading', { name: '运营登录' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '账号' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('错误密码有错误提示、不落 token、留在登录页', async () => {
    mockedLogin.mockRejectedValue(new ApiError(401, 'invalid_credentials', '运营密码不正确。'));
    renderApp('/admin/login');
    await fillAndSubmit('wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('运营密码不正确。');
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole('heading', { name: '运营登录' })).toBeInTheDocument();
    expect(mockedLogin).toHaveBeenCalledWith('wrong-password', expect.anything());
  });

  it('登录成功 → 运营 JWT 落 localStorage 并进入受保护壳（仪表盘）', async () => {
    mockedLogin.mockResolvedValue({
      adminToken: 'test-admin-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    renderApp('/admin/login');
    await fillAndSubmit('correct-password');
    expect(await screen.findByRole('heading', { name: '仪表盘' })).toBeInTheDocument();
    expect(screen.getByText('账号')).toBeInTheDocument(); // 侧边栏导航
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('test-admin-token');
  });

  it('登录成功后回到原目标路径（深链）', async () => {
    mockedLogin.mockResolvedValue({
      adminToken: 'test-admin-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    renderApp('/admin/accounts');
    await fillAndSubmit('correct-password');
    expect(await screen.findByRole('heading', { name: '账号' })).toBeInTheDocument();
  });

  it('退出登录清除 token 并回登录页', async () => {
    window.localStorage.setItem(TOKEN_KEY, 'existing-token');
    renderApp('/admin/');
    expect(await screen.findByRole('heading', { name: '仪表盘' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '账户菜单' }));
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }));

    expect(await screen.findByRole('heading', { name: '运营登录' })).toBeInTheDocument();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
