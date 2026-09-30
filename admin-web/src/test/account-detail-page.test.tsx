import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adjustAdminAccount,
  listAdminAccountChatUsage,
  listAdminAccountLedger,
  listAdminAccountPermits,
  listAdminAccountPublishOrders,
  listAdminAccountProviderUsage,
  setAdminAccountDisplayName,
  topupAdminAccount,
  type AdminAccountLedger,
  type AdminChatUsageRecord,
  type AdminLedgerAccount,
  type AdminPermit,
  type AdminProviderUsageRecord,
  type AdminPublishOrder,
} from '@/lib/accounts';
import { ApiError } from '@/lib/api';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/routes/routes';

/**
 * 账号详情页（票 49 次 seam，Vitest + RTL）：mock API 层，只测外部行为——
 * 八个数据块渲染（余额三口径 total/available/frozen、点数流水、permit 计费、
 * 发布订单、Provider 计量、对话计量）、用户名编辑（设置/清空/≤64 校验）、
 * 充值/调点复用列表页对话框（0.1 元粒度、调点备注必填，接既有端点）。
 * 数据源 limit 与 SSR 对账页同口径（流水 200、其余 50）。
 *
 * 票 #62 T-C 扩展：新增页头/余额卡组/明细块加载骨架屏（替代「加载中…」
 * 文字）与余额统计卡图标块/数值样式等视觉断言；既有语义断言全部保留。
 */
vi.mock('@/lib/accounts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/accounts')>();
  return {
    ...actual,
    listAdminAccountLedger: vi.fn(),
    listAdminAccountPermits: vi.fn(),
    listAdminAccountPublishOrders: vi.fn(),
    listAdminAccountProviderUsage: vi.fn(),
    listAdminAccountChatUsage: vi.fn(),
    setAdminAccountDisplayName: vi.fn(),
    topupAdminAccount: vi.fn(),
    adjustAdminAccount: vi.fn(),
  };
});

const mockedLedger = vi.mocked(listAdminAccountLedger);
const mockedPermits = vi.mocked(listAdminAccountPermits);
const mockedOrders = vi.mocked(listAdminAccountPublishOrders);
const mockedProviderUsage = vi.mocked(listAdminAccountProviderUsage);
const mockedChatUsage = vi.mocked(listAdminAccountChatUsage);
const mockedSetDisplayName = vi.mocked(setAdminAccountDisplayName);
const mockedTopup = vi.mocked(topupAdminAccount);
const mockedAdjust = vi.mocked(adjustAdminAccount);

const TOKEN_KEY = 'xiaojing-admin-token';

const ACCOUNT: AdminLedgerAccount = {
  id: 'acc-1',
  phone: '13800000001',
  status: 'active',
  mustChangePassword: false,
  points: 1500,
  displayName: '张三文化',
};

const LEDGER: AdminAccountLedger = {
  account: ACCOUNT,
  balance: { total: 1500, frozen: 200, available: 1300 },
  entries: [
    {
      id: 'le-1',
      delta: -20,
      balanceAfter: 1480,
      kind: 'consume',
      note: 'material_import unit 0',
      createdAt: '2026-09-29T10:00:00.000Z',
    },
    {
      id: 'le-2',
      delta: 1000,
      balanceAfter: 1500,
      kind: 'topup',
      note: '充值 ¥100.00：对公转账',
      createdAt: '2026-09-29T09:00:00.000Z',
    },
    {
      id: 'le-3',
      delta: 500,
      balanceAfter: 500,
      kind: 'grant',
      note: '开通赠送',
      createdAt: '2026-09-01T08:00:00.000Z',
    },
  ],
};

const PERMITS: AdminPermit[] = [
  {
    permitId: 'pm-open-001',
    operation: 'material_import',
    units: 3,
    unitPrice: 20,
    basePrice: 0,
    totalPoints: 60,
    status: 'open',
    frozenPoints: 40,
    consumedPoints: 20,
    refundedPoints: 0,
    unitsSucceeded: 1,
    unitsFailed: 0,
    unitsUnreported: 2,
    createdAt: '2026-09-29T10:30:00.000Z',
    settledAt: null,
  },
  {
    permitId: 'pm-settled-001',
    operation: 'article_generation',
    units: 2,
    unitPrice: 20,
    basePrice: 0,
    totalPoints: 40,
    status: 'settled',
    frozenPoints: 0,
    consumedPoints: 40,
    refundedPoints: 0,
    unitsSucceeded: 2,
    unitsFailed: 0,
    unitsUnreported: 0,
    createdAt: '2026-09-28T10:00:00.000Z',
    settledAt: '2026-09-28T10:01:00.000Z',
  },
];

const ORDERS: AdminPublishOrder[] = [
  {
    sn: 'sn-20260929-001',
    executionId: 'exec-1',
    itemId: 'item-1',
    kind: 'media',
    resourceId: 101,
    title: '稿件A',
    contentUrl: 'https://example.com/a.html',
    mediaPriceCents: 8800,
    points: 1408,
    perArticleMaxPoints: 160000000,
    executionMaxPoints: 160000000,
    placementStatus: 'pending',
    ledgerStatus: 'frozen',
    partnerSn: null,
    status: 1,
    url: null,
    publishedAt: null,
    closedObservedAt: null,
    createdAt: '2026-09-29T11:00:00.000Z',
    updatedAt: '2026-09-29T11:00:00.000Z',
  },
  {
    sn: 'sn-20260928-001',
    executionId: 'exec-2',
    itemId: 'item-2',
    kind: 'we-media',
    resourceId: 202,
    title: '稿件B',
    contentUrl: 'https://example.com/b.html',
    mediaPriceCents: 5000,
    points: 800,
    perArticleMaxPoints: 160000000,
    executionMaxPoints: 160000000,
    placementStatus: 'placed',
    ledgerStatus: 'settled',
    partnerSn: '99999999999999999999999926',
    status: 4,
    url: 'https://published.example.com/b',
    publishedAt: '2026-09-28T12:00:00.000Z',
    closedObservedAt: null,
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T12:00:00.000Z',
  },
];

const PROVIDER_RECORDS: AdminProviderUsageRecord[] = [
  {
    id: 'pu-1',
    provider: 'ark',
    route: 'ark.chat_completions',
    inputTokens: 1200,
    outputTokens: 300,
    createdAt: '2026-09-29T12:00:00.000Z',
  },
  {
    id: 'pu-2',
    provider: 'oss',
    route: 'oss.put_html',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-09-28T12:00:00.000Z',
  },
];

const CHAT_RECORD: AdminChatUsageRecord = {
  id: 'cu-1',
  model: 'deepseek-chat',
  inputTokens: 800,
  cacheReadTokens: 200,
  cacheCreationTokens: 0,
  outputTokens: 100,
  pointsMilli: 12,
  createdAt: '2026-09-29T13:00:00.000Z',
};

function renderApp(initialPath = '/admin/accounts/acc-1') {
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
  mockedLedger.mockReset();
  mockedPermits.mockReset();
  mockedOrders.mockReset();
  mockedProviderUsage.mockReset();
  mockedChatUsage.mockReset();
  mockedSetDisplayName.mockReset();
  mockedTopup.mockReset();
  mockedAdjust.mockReset();
  window.localStorage.setItem(TOKEN_KEY, 'test-admin-token');
  mockedLedger.mockResolvedValue(LEDGER);
  mockedPermits.mockResolvedValue({ permits: PERMITS });
  mockedOrders.mockResolvedValue({ orders: ORDERS });
  mockedProviderUsage.mockResolvedValue({ records: PROVIDER_RECORDS });
  mockedChatUsage.mockResolvedValue({
    account: ACCOUNT,
    quotaUsedMilli: 500,
    records: [CHAT_RECORD],
  });
});

describe('账号详情页（票 49）', () => {
  it('渲染八个数据块与余额三口径，数据源 limit 与 SSR 对账页同口径', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { name: '账号详情' })).toBeInTheDocument();
    expect(await screen.findByText('13800000001')).toBeInTheDocument();
    expect(screen.getByText('正常')).toBeInTheDocument();

    // 余额三口径（总/可用/冻结）：data-testid 收窄到数值块。
    expect(screen.getByTestId('balance-total')).toHaveTextContent('1500 点');
    expect(screen.getByTestId('balance-available')).toHaveTextContent('1300 点');
    expect(screen.getByTestId('balance-frozen')).toHaveTextContent('200 点');

    // 八个数据块标题。
    for (const title of [
      '余额总览',
      '用户名',
      '充值 / 调点',
      '点数流水',
      '计费操作（permit）',
      '发布订单',
      'Provider 计量（对账用）',
      '对话计量（隐藏额度口径，千分之一点）',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }

    // 点数流水：kind 中文标签、正负号、备注。「开通赠送/充值」在 kind 标签
    // 与备注/充值按钮多处出现，用 getAllByText 断言存在性。
    expect(screen.getAllByText('开通赠送').length).toBeGreaterThan(0);
    expect(screen.getAllByText('充值').length).toBeGreaterThan(0);
    expect(screen.getByText('扣点')).toBeInTheDocument();
    expect(screen.getByText('+1000')).toBeInTheDocument();
    expect(screen.getByText('-20')).toBeInTheDocument();
    expect(screen.getByText('充值 ¥100.00：对公转账')).toBeInTheDocument();

    // permit 计费：操作/状态中文/已扣已退。
    expect(screen.getByText('material_import')).toBeInTheDocument();
    expect(screen.getByText('article_generation')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('已结清')).toBeInTheDocument();
    expect(screen.getByText('20 / 0')).toBeInTheDocument();
    expect(screen.getByText('40 / 0')).toBeInTheDocument();

    // 发布订单：sn、类型中文、下单/账本中文、上游状态、链接。
    expect(screen.getByText('sn-20260929-001')).toBeInTheDocument();
    expect(screen.getByText('媒体')).toBeInTheDocument();
    expect(screen.getByText('自媒体')).toBeInTheDocument();
    expect(screen.getByText('1408')).toBeInTheDocument();
    expect(screen.getByText('待下单')).toBeInTheDocument();
    expect(screen.getByText('已受理')).toBeInTheDocument();
    // 「冻结」同时是余额总览标签与订单账本状态，getAllByText 断言存在性。
    expect(screen.getAllByText('冻结').length).toBeGreaterThan(0);
    expect(screen.getByText('已结转')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '链接' })).toHaveAttribute(
      'href',
      'https://published.example.com/b',
    );

    // Provider 计量与对话计量。
    expect(screen.getByText('ark.chat_completions')).toBeInTheDocument();
    expect(screen.getByText('oss.put_html')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/本周期累计 500 千分点/)).toBeInTheDocument();

    // 数据源调用：流水 200（SSR 同口径），其余三个新接口默认 50。
    expect(mockedLedger).toHaveBeenCalledWith('acc-1', 200);
    expect(mockedPermits).toHaveBeenCalledWith('acc-1', 50);
    expect(mockedOrders).toHaveBeenCalledWith('acc-1', 50);
    expect(mockedProviderUsage).toHaveBeenCalledWith('acc-1', 50);
    expect(mockedChatUsage).toHaveBeenCalledWith('acc-1', 50);
  });

  // 稳定性护栏：全量并行 + 高负载下 userEvent 交互超 5s 默认限，加长超时。
  it('充值：最小粒度 0.1 元校验、1 元 = 10 点换算、成功后刷新流水', async () => {
    mockedTopup.mockResolvedValue({ account: {}, balance: {} });
    renderApp();

    await screen.findByText('13800000001');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '充值' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/充值金额/), '10.55');
    await user.type(within(dialog).getByLabelText(/来源备注/), '对公转账');
    await user.click(within(dialog).getByRole('button', { name: '确认入账' }));
    expect(
      await within(dialog).findByText('充值金额最小粒度为 0.1 元（1 元 = 10 点）。'),
    ).toBeInTheDocument();
    expect(mockedTopup).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText(/充值金额/));
    await user.type(within(dialog).getByLabelText(/充值金额/), '100');
    await user.click(within(dialog).getByRole('button', { name: '确认入账' }));
    await vi.waitFor(() =>
      expect(mockedTopup).toHaveBeenCalledWith('acc-1', 1000, '充值 ¥100.00：对公转账'),
    );
    // 成功后失效主查询 → 流水重新拉取。
    await vi.waitFor(() => expect(mockedLedger.mock.calls.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }, 15000);

  it('调点：备注必填，负数 + 备注接既有端点', async () => {
    mockedAdjust.mockResolvedValue({ account: {}, balance: {} });
    renderApp();

    await screen.findByText('13800000001');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '调点' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/调整点数/), '-50');
    await user.click(within(dialog).getByRole('button', { name: '确认调整' }));
    expect(await within(dialog).findByText('调点必须带备注。')).toBeInTheDocument();
    expect(mockedAdjust).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/备注/), '内测活动补偿');
    await user.click(within(dialog).getByRole('button', { name: '确认调整' }));
    await vi.waitFor(() => expect(mockedAdjust).toHaveBeenCalledWith('acc-1', -50, '内测活动补偿'));
    await vi.waitFor(() => expect(mockedLedger.mock.calls.length).toBeGreaterThan(1));
  }, 15000);

  it('用户名编辑：65 字符拒绝、保存 trim 后提交、清空发 null', async () => {
    mockedSetDisplayName.mockResolvedValue({ account: { ...ACCOUNT, displayName: '李四科技' } });
    renderApp();

    const input = await screen.findByLabelText(/用户名（最长 64 字符/);
    expect(input).toHaveValue('张三文化');
    const user = userEvent.setup();

    // 65 字符拒绝且不发起请求。
    await user.clear(input);
    await user.type(input, 'x'.repeat(65));
    await user.click(screen.getByRole('button', { name: '保存用户名' }));
    expect(await screen.findByText('用户名最长 64 字符')).toBeInTheDocument();
    expect(mockedSetDisplayName).not.toHaveBeenCalled();

    // 合法：trim 后提交设置。
    await user.clear(input);
    await user.type(input, '  李四科技  ');
    await user.click(screen.getByRole('button', { name: '保存用户名' }));
    await vi.waitFor(() => expect(mockedSetDisplayName).toHaveBeenCalledWith('acc-1', '李四科技'));

    // 清空：直接发 null（后端落空串）。
    await user.click(screen.getByRole('button', { name: '清空用户名' }));
    await vi.waitFor(() => expect(mockedSetDisplayName).toHaveBeenCalledWith('acc-1', null));
    await vi.waitFor(() => expect(mockedLedger.mock.calls.length).toBeGreaterThan(1));
  }, 15000);

  it('空用户名保存被引导去清空，不发起请求', async () => {
    renderApp();

    const input = await screen.findByLabelText(/用户名（最长 64 字符/);
    const user = userEvent.setup();
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: '保存用户名' }));
    expect(
      await screen.findByText('用户名不能为空；要清除用户名请点「清空用户名」。'),
    ).toBeInTheDocument();
    expect(mockedSetDisplayName).not.toHaveBeenCalled();
  }, 15000);

  it('主数据源失败显示服务端错误文案', async () => {
    mockedLedger.mockRejectedValue(new ApiError(404, 'account_not_found', '账号不存在。'));
    renderApp();

    // 头部与点数流水卡各渲染一个错误态，都带服务端文案。
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toHaveTextContent('账号不存在。');
  });

  // 票 #62 T-C：加载态页头/余额卡组/点数流水块渲染骨架屏，数据到达后骨架退场。
  it('加载中显示页头/余额卡组/流水块骨架屏，无「加载中」文字', async () => {
    let resolveLedger!: (value: AdminAccountLedger) => void;
    mockedLedger.mockReturnValue(new Promise(resolve => (resolveLedger = resolve)));
    renderApp();

    expect(screen.getByTestId('detail-header-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('balance-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('加载中')).not.toBeInTheDocument();

    resolveLedger(LEDGER);
    expect(await screen.findByText('13800000001')).toBeInTheDocument();
    expect(screen.getByTestId('balance-total')).toHaveTextContent('1500 点');
    expect(screen.queryByTestId('detail-header-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('balance-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ledger-skeleton')).not.toBeInTheDocument();
  });

  // 票 #62 T-C：余额三口径统计卡视觉——圆角 border 块 + 图标色块 + 大数值，
  // 卡片带入场动画与 hover 阴影；数值 data-testid 与文案口径不变。
  it('余额总览卡组统计卡样式：图标块 + 数值 + 圆角边框与入场动画', async () => {
    renderApp();

    expect(await screen.findByText('13800000001')).toBeInTheDocument();
    for (const testId of ['balance-total', 'balance-available', 'balance-frozen']) {
      const card = screen.getByTestId(`${testId}-card`);
      expect(card).toHaveClass('rounded-lg');
      expect(card).toHaveClass('border');
      expect(card.querySelector('svg')).not.toBeNull();
      expect(screen.getByTestId(testId)).toHaveClass('tabular-nums');
    }
    const balanceCard = screen.getByText('余额总览').closest('[data-slot="card"]');
    expect(balanceCard).toHaveClass('animate-in');
    expect(balanceCard).toHaveClass('hover:shadow-md');
  });
});
