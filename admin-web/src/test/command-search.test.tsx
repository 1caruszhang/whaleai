import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listAdminAccountChatUsage,
  listAdminAccountLedger,
  listAdminAccountPermits,
  listAdminAccountPublishOrders,
  listAdminAccountProviderUsage,
  listAdminAccounts,
  type AdminAccount,
  type AdminAccountListResult,
} from '@/lib/accounts';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/routes/routes';

/**
 * Cmd+K 全局搜索（票 51 次 seam，Vitest + RTL）：mock API 层，只测外部
 * 行为——⌘K/Ctrl+K 打开面板、Esc 关闭、输入即走既有 GET /admin/accounts?q=
 * （pageSize=10）、命中列表展示手机号/用户名/状态、Enter/点击跳转详情页。
 * 详情页跳转目标复用票 49 的 API 层 mock（跳转后渲染真实详情页）。
 */
vi.mock('@/lib/accounts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/accounts')>();
  return {
    ...actual,
    listAdminAccounts: vi.fn(),
    // 票 49：跳转目标详情页的数据源一并 mock。
    listAdminAccountLedger: vi.fn(),
    listAdminAccountPermits: vi.fn(),
    listAdminAccountPublishOrders: vi.fn(),
    listAdminAccountProviderUsage: vi.fn(),
    listAdminAccountChatUsage: vi.fn(),
  };
});

const mockedList = vi.mocked(listAdminAccounts);
const mockedDetailLedger = vi.mocked(listAdminAccountLedger);
const mockedDetailPermits = vi.mocked(listAdminAccountPermits);
const mockedDetailOrders = vi.mocked(listAdminAccountPublishOrders);
const mockedDetailProviderUsage = vi.mocked(listAdminAccountProviderUsage);
const mockedDetailChatUsage = vi.mocked(listAdminAccountChatUsage);

const TOKEN_KEY = 'xiaojing-admin-token';

const ACCOUNT_HIT: AdminAccount = {
  id: 'acc-1',
  phone: '13800000001',
  displayName: '张三文化',
  status: 'active',
  mustChangePassword: false,
  balance: { total: 1500, frozen: 200, available: 1300 },
  chatQuota: { totalPoints: 100, usedMilli: 500 },
  brands: [{ workspaceId: 'ws-1', name: '鲸杉示范品牌' }],
  lastActiveAt: '2026-09-28T10:30:00.000Z',
  createdAt: '2026-09-01T08:00:00.000Z',
};

/** 旧账号：无用户名、已停用（命中列表「—」与状态徽章断言）。 */
const ACCOUNT_LEGACY: AdminAccount = {
  id: 'acc-2',
  phone: '13800000002',
  displayName: '',
  status: 'disabled',
  mustChangePassword: false,
  balance: { total: 0, frozen: 0, available: 0 },
  chatQuota: { totalPoints: 100, usedMilli: 100000 },
  brands: [],
  lastActiveAt: null,
  createdAt: '2026-08-15T08:00:00.000Z',
};

function listResult(accounts: AdminAccount[]): AdminAccountListResult {
  return { accounts, total: accounts.length, page: 1, pageSize: 10 };
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter basename="/admin" initialEntries={['/admin/accounts']}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedList.mockReset();
  mockedDetailLedger.mockReset();
  mockedDetailPermits.mockReset();
  mockedDetailOrders.mockReset();
  mockedDetailProviderUsage.mockReset();
  mockedDetailChatUsage.mockReset();
  window.localStorage.setItem(TOKEN_KEY, 'test-admin-token');
  // 票 49：详情跳转目标的默认数据源（空明细 + 余额三口径）。
  mockedDetailLedger.mockResolvedValue({
    account: {
      id: 'acc-1',
      phone: '13800000001',
      status: 'active',
      mustChangePassword: false,
      points: 1500,
      displayName: '张三文化',
    },
    balance: { total: 1500, frozen: 200, available: 1300 },
    entries: [],
  });
  mockedDetailPermits.mockResolvedValue({ permits: [] });
  mockedDetailOrders.mockResolvedValue({ orders: [] });
  mockedDetailProviderUsage.mockResolvedValue({ records: [] });
  mockedDetailChatUsage.mockResolvedValue({
    account: {
      id: 'acc-1',
      phone: '13800000001',
      status: 'active',
      mustChangePassword: false,
      points: 1500,
      displayName: '张三文化',
    },
    quotaUsedMilli: 0,
    records: [],
  });
});

describe('Cmd+K 全局搜索（票 51）', () => {
  it('⌘K 打开、Esc 关闭、再按 ⌘K 切换', async () => {
    mockedList.mockResolvedValue(listResult([]));
    renderApp();

    const user = userEvent.setup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // ⌘K 打开：面板出现，空查询不发面板请求（只有列表页自身的加载调用）。
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('全局搜索账号')).toBeInTheDocument();
    expect(mockedList).toHaveBeenLastCalledWith({ q: '', page: 1, pageSize: 25, sort: 'created' });

    // 再按 ⌘K 关闭。
    await user.keyboard('{Meta>}k{/Meta}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Ctrl+K（Windows）同样打开；Esc 关闭。
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }, 15000);

  it('输入即走 GET /admin/accounts?q= 并命中手机号/用户名，Enter 跳转详情', async () => {
    mockedList.mockResolvedValue(listResult([ACCOUNT_HIT, ACCOUNT_LEGACY]));
    renderApp();
    await screen.findByText('13800000001'); // 列表页已就绪（当前路由 /accounts）

    const user = userEvent.setup();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(screen.getByLabelText('全局搜索账号'), '138');

    // 每个输入片段都走既有搜索接口（q 包含匹配、pageSize=10）。
    await vi.waitFor(() =>
      expect(mockedList).toHaveBeenLastCalledWith({ q: '138', page: 1, pageSize: 10, sort: 'created' }),
    );
    const listbox = await screen.findByRole('listbox', { name: '搜索结果' });
    expect(listbox).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '跳转 13800000001 张三文化' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '跳转 13800000002' })).toBeInTheDocument();

    // 高亮第一项，Enter 跳转账号详情页（票 49 详情页渲染）。
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: '账号详情' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }, 15000);

  it('点击命中项跳转详情；无命中给出空态', async () => {
    // 按关键词返回结果：面板与列表页共用同一 API 层，q=张三 命中、其余空。
    mockedList.mockImplementation(async ({ q }) =>
      q === '张三' ? listResult([ACCOUNT_HIT]) : listResult([]),
    );
    renderApp();
    await screen.findByText('暂无账号');

    const user = userEvent.setup();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(screen.getByLabelText('全局搜索账号'), '张三');
    const option = await screen.findByRole('option', { name: '跳转 13800000001 张三文化' });
    await user.click(option);
    expect(await screen.findByRole('heading', { name: '账号详情' })).toBeInTheDocument();

    // 无命中：空态提示，不渲染任何选项。
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(screen.getByLabelText('全局搜索账号'), '不存在的关键词');
    expect(await screen.findByText('无匹配账号')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  }, 15000);
});
