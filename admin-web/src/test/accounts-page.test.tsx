import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adjustAdminAccount,
  createAdminAccount,
  listAdminAccounts,
  setAdminAccountStatus,
  topupAdminAccount,
  type AdminAccount,
  type AdminAccountListResult,
} from '@/lib/accounts';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/routes/routes';

/**
 * 账号列表页（票 47 次 seam，Vitest + RTL）：mock API 层，只测外部行为——
 * 9 列渲染、旧账号用户名「—」、搜索/分页/排序驱动的查询参数、建号对话框
 * 校验（手机号格式/密码 ≥8 位/用户名 ≤64）、行操作下拉（停用·启用/充值/
 * 调点接既有端点）。URL 查询参数用 LocationProbe 读 useSearchParams 断言。
 */
vi.mock('@/lib/accounts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/accounts')>();
  return {
    ...actual,
    listAdminAccounts: vi.fn(),
    createAdminAccount: vi.fn(),
    setAdminAccountStatus: vi.fn(),
    topupAdminAccount: vi.fn(),
    adjustAdminAccount: vi.fn(),
  };
});

const mockedList = vi.mocked(listAdminAccounts);
const mockedCreate = vi.mocked(createAdminAccount);
const mockedStatus = vi.mocked(setAdminAccountStatus);
const mockedTopup = vi.mocked(topupAdminAccount);
const mockedAdjust = vi.mocked(adjustAdminAccount);

const TOKEN_KEY = 'xiaojing-admin-token';

const ACCOUNT_ACTIVE: AdminAccount = {
  id: 'acc-1',
  phone: '13800000001',
  displayName: '张三文化',
  status: 'active',
  mustChangePassword: true,
  balance: { total: 1500, frozen: 200, available: 1300 },
  chatQuota: { totalPoints: 100, usedMilli: 500 },
  brands: [{ workspaceId: 'ws-1', name: '鲸杉示范品牌' }],
  lastActiveAt: '2026-09-28T10:30:00.000Z',
  createdAt: '2026-09-01T08:00:00.000Z',
};

/** 旧账号：无用户名、已停用、从未登录、对话额度用尽。 */
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

function listResult(
  accounts: AdminAccount[],
  overrides: Partial<AdminAccountListResult> = {},
): AdminAccountListResult {
  return { accounts, total: accounts.length, page: 1, pageSize: 25, ...overrides };
}

/** 把当前 URL 查询参数投影到 DOM，供断言。 */
function LocationProbe() {
  const [searchParams] = useSearchParams();
  return <div data-testid="location-probe">{searchParams.toString()}</div>;
}

function renderApp(initialPath = '/admin/accounts') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter basename="/admin" initialEntries={[initialPath]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function rowOf(phone: string): HTMLElement {
  const cell = screen.getByText(phone);
  const row = cell.closest('tr');
  if (!row) throw new Error(`row for ${phone} not found`);
  return row;
}

beforeEach(() => {
  mockedList.mockReset();
  mockedCreate.mockReset();
  mockedStatus.mockReset();
  mockedTopup.mockReset();
  mockedAdjust.mockReset();
  window.localStorage.setItem(TOKEN_KEY, 'test-admin-token');
});

describe('账号列表页（票 47）', () => {
  it('渲染全部 9 列与行数据：旧账号用户名显示「—」', async () => {
    mockedList.mockResolvedValue(listResult([ACCOUNT_ACTIVE, ACCOUNT_LEGACY]));
    renderApp();

    for (const header of [
      '手机号',
      '用户名',
      '状态',
      '余额（可用/冻结）',
      '对话额度',
      '品牌集',
      '最近活跃',
      '建号时间',
      '操作',
    ]) {
      expect(await screen.findByRole('columnheader', { name: header })).toBeInTheDocument();
    }

    await screen.findByText('13800000001');
    const activeRow = rowOf('13800000001');
    expect(within(activeRow).getByText('待改密')).toBeInTheDocument();
    expect(within(activeRow).getByText('张三文化')).toBeInTheDocument();
    expect(within(activeRow).getByText('正常')).toBeInTheDocument();
    expect(within(activeRow).getByText('1300 / 200')).toBeInTheDocument();
    expect(within(activeRow).getByText('99.5 点')).toBeInTheDocument();
    expect(within(activeRow).getByText('鲸杉示范品牌')).toBeInTheDocument();

    const legacyRow = rowOf('13800000002');
    // 「—」是旧账号空态的共用占位（用户名/品牌集/最近活跃三列都渲染），
    // 必须收窄到用户名列（data-testid），不能用 getByText 裸查。
    expect(within(legacyRow).getByTestId('display-name')).toHaveTextContent('—');
    expect(within(legacyRow).getByText('已停用')).toBeInTheDocument();
    expect(within(legacyRow).getByText('0 / 0')).toBeInTheDocument();
    expect(within(legacyRow).getByText('已用尽')).toBeInTheDocument();

    // 初始加载使用默认查询参数。
    expect(mockedList).toHaveBeenCalledWith({ q: '', page: 1, pageSize: 25, sort: 'created' });
  });

  it('搜索驱动 q 查询参数并回第 1 页', async () => {
    mockedList.mockResolvedValue(listResult([]));
    renderApp();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('搜索账号'), '张三');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    expect(mockedList).toHaveBeenLastCalledWith({ q: '张三', page: 1, pageSize: 25, sort: 'created' });
    expect(screen.getByTestId('location-probe').textContent).toContain('q=%E5%BC%A0%E4%B8%89');
    expect(screen.getByTestId('location-probe').textContent).not.toContain('page=');
  });

  it('排序与每页切换驱动 sort/pageSize 查询参数', async () => {
    mockedList.mockResolvedValue(listResult([]));
    renderApp();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '排序：建号时间' }));
    await user.click(await screen.findByRole('menuitemradio', { name: '余额' }));
    expect(mockedList).toHaveBeenLastCalledWith({ q: '', page: 1, pageSize: 25, sort: 'balance' });
    expect(screen.getByTestId('location-probe').textContent).toContain('sort=balance');

    await user.click(screen.getByRole('button', { name: '每页 25 条' }));
    await user.click(await screen.findByRole('menuitemradio', { name: '50 条/页' }));
    expect(mockedList).toHaveBeenLastCalledWith({ q: '', page: 1, pageSize: 50, sort: 'balance' });
    expect(screen.getByTestId('location-probe').textContent).toContain('pageSize=50');
  });

  it('分页驱动 page 查询参数，边界禁用', async () => {
    mockedList.mockResolvedValue(listResult([ACCOUNT_ACTIVE], { total: 30 }));
    renderApp();

    expect(await screen.findByText('共 30 条 · 第 1 / 2 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(mockedList).toHaveBeenLastCalledWith({ q: '', page: 2, pageSize: 25, sort: 'created' });
    expect(screen.getByTestId('location-probe').textContent).toContain('page=2');
  });

  it('建号对话框校验：手机号格式、密码 ≥8 位、用户名 ≤64，通过后提交并关闭', async () => {
    mockedList.mockResolvedValue(listResult([]));
    mockedCreate.mockResolvedValue({
      account: {
        id: 'new-acc',
        phone: '13811112222',
        status: 'active',
        mustChangePassword: true,
        points: 500,
        displayName: '李四科技',
      },
    });
    renderApp();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '开通账号' }));
    const dialog = await screen.findByRole('dialog');

    // 形态校验失败：不发起请求。
    await user.type(within(dialog).getByLabelText('手机号'), '123');
    await user.type(within(dialog).getByLabelText(/初始密码/), 'short');
    await user.click(within(dialog).getByRole('button', { name: '开通账号' }));
    expect(await within(dialog).findByText('手机号格式不正确')).toBeInTheDocument();
    expect(within(dialog).getByText('初始密码至少 8 位')).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 用户名超长 64：拒绝。
    await user.clear(within(dialog).getByLabelText('手机号'));
    await user.type(within(dialog).getByLabelText('手机号'), '13811112222');
    await user.clear(within(dialog).getByLabelText(/初始密码/));
    await user.type(within(dialog).getByLabelText(/初始密码/), 'initial-pass-1');
    await user.type(within(dialog).getByLabelText(/用户名/), 'x'.repeat(65));
    await user.click(within(dialog).getByRole('button', { name: '开通账号' }));
    expect(await within(dialog).findByText('用户名最长 64 字符')).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 全部合法：提交（用户名 trim 后携带），成功后对话框关闭。
    await user.clear(within(dialog).getByLabelText(/用户名/));
    await user.type(within(dialog).getByLabelText(/用户名/), '  李四科技  ');
    await user.click(within(dialog).getByRole('button', { name: '开通账号' }));
    // react-query v5 调 mutationFn 会附第二个实参 {client, meta, mutationKey}，
    // toHaveBeenCalledWith 全参比对会因此失配；只断言首个实参（variables）。
    await vi.waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      phone: '13811112222',
      initialPassword: 'initial-pass-1',
      displayName: '李四科技',
    });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('行操作下拉：详情跳转、停用/启用切换、充值/调点接既有端点', async () => {
    mockedList.mockResolvedValue(listResult([ACCOUNT_ACTIVE, ACCOUNT_LEGACY]));
    mockedStatus.mockResolvedValue({ account: { id: 'acc-1', status: 'disabled' } });
    mockedTopup.mockResolvedValue({ account: {}, balance: {} });
    mockedAdjust.mockResolvedValue({ account: {}, balance: {} });
    renderApp();

    await screen.findByText('13800000001');
    const user = userEvent.setup();

    // 停用：状态端点收到 disabled；对已停用行则发 active（启用）。
    await user.click(screen.getByRole('button', { name: '操作 13800000001' }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));
    await vi.waitFor(() => expect(mockedStatus).toHaveBeenCalledWith('acc-1', 'disabled'));

    await user.click(screen.getByRole('button', { name: '操作 13800000002' }));
    await user.click(await screen.findByRole('menuitem', { name: '启用' }));
    await vi.waitFor(() => expect(mockedStatus).toHaveBeenCalledWith('acc-2', 'active'));

    // 充值：金额粒度校验 + 1 元 = 10 点换算，备注与金额同落 note。
    await user.click(screen.getByRole('button', { name: '操作 13800000001' }));
    await user.click(await screen.findByRole('menuitem', { name: '充值' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/充值金额/), '10.55');
    await user.type(within(dialog).getByLabelText(/来源备注/), '对公转账');
    await user.click(within(dialog).getByRole('button', { name: '确认入账' }));
    expect(await within(dialog).findByText('充值金额最小粒度为 0.1 元（1 元 = 10 点）。')).toBeInTheDocument();
    expect(mockedTopup).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(/充值金额/));
    await user.type(within(dialog).getByLabelText(/充值金额/), '100');
    await user.click(within(dialog).getByRole('button', { name: '确认入账' }));
    await vi.waitFor(() =>
      expect(mockedTopup).toHaveBeenCalledWith('acc-1', 1000, '充值 ¥100.00：对公转账'),
    );

    // 调点：负数 + 必填备注。
    await user.click(screen.getByRole('button', { name: '操作 13800000001' }));
    await user.click(await screen.findByRole('menuitem', { name: '调点' }));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/调整点数/), '-50');
    await user.type(within(dialog).getByLabelText(/备注/), '内测活动补偿');
    await user.click(within(dialog).getByRole('button', { name: '确认调整' }));
    await vi.waitFor(() =>
      expect(mockedAdjust).toHaveBeenCalledWith('acc-1', -50, '内测活动补偿'),
    );

    // 详情：跳转到详情占位页。
    await user.click(screen.getByRole('button', { name: '操作 13800000001' }));
    await user.click(await screen.findByRole('menuitem', { name: '详情' }));
    expect(await screen.findByRole('heading', { name: '账号详情' })).toBeInTheDocument();
    expect(screen.getByText('账号 acc-1')).toBeInTheDocument();
  });
});
