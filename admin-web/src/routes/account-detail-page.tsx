import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CreditCardIcon,
  LockIcon,
  SlidersHorizontalIcon,
  UnlockIcon,
  WalletIcon,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminApiErrorMessage } from '@/lib/api';
import {
  ledgerKindLabel,
  listAdminAccountChatUsage,
  listAdminAccountLedger,
  listAdminAccountPermits,
  listAdminAccountPublishOrders,
  listAdminAccountProviderUsage,
  permitStatusLabel,
  setAdminAccountDisplayName,
  type AdminLedgerAccount,
} from '@/lib/accounts';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AdjustDialog, TopupDialog } from '@/routes/account-dialogs';

/**
 * 账号详情页（票 49，替换票 47 占位）：以卡片组织八个数据块——余额总览
 * （总/可用/冻结，冻结 = 进行中订单与 permit 预扣，口径来自 ledger 端点的
 * balanceSnapshot）、充值/调点（复用列表页对话框组件，接既有 ledger 端点）、
 * 点数流水（ledger 端点，limit=200 与 SSR 对账页同口径）、permit 计费、
 * 发布订单、Provider 计量、对话计量（三个新 JSON 接口，limit=50），另加
 * 用户名可编辑（设置/清空接新 display-name 端点，≤64 字符）。
 *
 * 主数据源是 GET /admin/accounts/:accountId/ledger（账号投影含 displayName
 * + 余额三口径 + 流水）；写操作成功后失效该查询即刷新余额与流水。全部
 * 请求走 lib/api adminFetch（Bearer + 401 闭环）。
 *
 * 票 #62 T-C 视觉对齐 shadcn-admin 详情卡布局：页头（返回 + 标题 + 右侧
 * 账号身份）；余额总览卡组改圆角色块图标 + 数值 + 标签的统计卡（对齐
 * T-B 统计卡手法）；各区块卡片补入场淡入错峰与 hover 阴影；页头/余额/
 * 明细块加载态全部换 ui/skeleton（替代「加载中…」文字）。功能与数据流
 * 零改动，八块标题与余额三口径 data-testid 原样保留。
 */

const LEDGER_LIMIT = 200; // 与 SSR 对账页同口径
const DETAIL_LIMIT = 50; // 三个新列表接口默认 50

const ORDER_KIND_LABELS: Record<string, string> = { media: '媒体', 'we-media': '自媒体' };
const PLACEMENT_LABELS: Record<string, string> = {
  pending: '待下单',
  placed: '已受理',
  failed: '下单失败',
};
const LEDGER_STATUS_LABELS: Record<string, string> = {
  frozen: '冻结',
  settled: '已结转',
  refunded: '已退点',
};

/** 卡片入场动画：淡入 + 上浮（与 T-B 同款手法），按区块错峰。 */
const CARD_ENTRANCE = 'animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500';

/** 明细卡通用加载/错误门：加载态渲染 ui/skeleton 骨架（替代「加载中…」
 *  文字），错误态文案与列表页一致；只测外部行为。 */
function QueryGate({
  isLoading,
  isError,
  error,
  fallback,
  skeletonTestId,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  fallback: string;
  /** 加载骨架容器 testid：新视觉断言按明细块收窄。 */
  skeletonTestId: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <div data-testid={skeletonTestId} className="space-y-3 py-2">
        <div className="flex gap-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-4 w-16" />
          ))}
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-destructive py-8 text-center text-sm">
        {adminApiErrorMessage(error, fallback)}
      </p>
    );
  }
  return children;
}

function EmptyRow({ columns, hint }: { columns: number; hint: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="text-muted-foreground h-20 text-center">
        {hint}
      </TableCell>
    </TableRow>
  );
}

/** 点数变动：正数带 + 号，正绿负红（与 SSR 对账页 pos/neg 口径一致）。 */
function DeltaCell({ delta }: { delta: number }) {
  const sign = delta > 0 ? '+' : '';
  return (
    <span className={delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
      {sign}
      {delta}
    </span>
  );
}

/** 用户名编辑（设置/清空接 display-name 端点）：页面校验 ≤64、空串引导点清空。 */
function DisplayNameEditor({
  account,
  onSaved,
}: {
  account: AdminLedgerAccount;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(account.displayName);
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');

  // 保存成功 → 父组件失效主查询 → 新投影回填输入框。
  useEffect(() => {
    setDraft(account.displayName);
  }, [account.displayName]);

  const mutation = useMutation({
    mutationFn: (displayName: string | null) => setAdminAccountDisplayName(account.id, displayName),
    onSuccess: () => {
      setFieldError('');
      setSubmitError('');
      onSaved();
    },
    onError: error => {
      setSubmitError(adminApiErrorMessage(error, '用户名保存失败，请稍后重试。'));
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError('');
    const trimmed = draft.trim();
    if (trimmed === '') {
      setFieldError('用户名不能为空；要清除用户名请点「清空用户名」。');
      return;
    }
    if (Array.from(trimmed).length > 64) {
      setFieldError('用户名最长 64 字符');
      return;
    }
    setFieldError('');
    mutation.mutate(trimmed);
  }

  function onClear() {
    setFieldError('');
    setSubmitError('');
    mutation.mutate(null);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <div className="grid flex-1 gap-2">
        <Label htmlFor="display-name">用户名（最长 64 字符，不参与登录）</Label>
        <Input
          id="display-name"
          aria-invalid={fieldError !== ''}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <FieldError message={fieldError} />
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '保存中…' : '保存用户名'}
      </Button>
      <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClear}>
        清空用户名
      </Button>
      {submitError !== '' && (
        <p role="alert" className="text-destructive text-sm">
          {submitError}
        </p>
      )}
    </form>
  );
}

function FieldError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

/** 余额三口径数据块：总/可用/冻结（冻结口径由后端 balanceSnapshot 权威）。
 *  统计卡对齐 T-B 手法：圆角色块图标 + 标签 + 大数值，hover 微阴影。 */
function BalanceOverview({
  total,
  available,
  frozen,
}: {
  total: number;
  available: number;
  frozen: number;
}) {
  const stats: { label: string; value: number; testId: string; icon: typeof WalletIcon }[] = [
    { label: '总余额', value: total, testId: 'balance-total', icon: WalletIcon },
    { label: '可用', value: available, testId: 'balance-available', icon: UnlockIcon },
    { label: '冻结', value: frozen, testId: 'balance-frozen', icon: LockIcon },
  ];
  return (
    <Card className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}>
      <CardHeader>
        <CardTitle>余额总览</CardTitle>
        <CardDescription>
          1 元 = 10 点；冻结 = 进行中的计费操作（permit）与发布订单预扣
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {stats.map(({ label, value, testId, icon: Icon }) => (
          <div
            key={testId}
            data-testid={`${testId}-card`}
            className="flex items-center gap-3 rounded-lg border p-4"
          >
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Icon className="size-4" />
            </span>
            <div className="space-y-1">
              <p className="text-muted-foreground text-sm">{label}</p>
              <p className="text-2xl font-bold tabular-nums" data-testid={testId}>
                {value} 点
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** 余额卡组加载骨架：标题占位 + 三块统计卡占位。 */
function BalanceOverviewSkeleton() {
  return (
    <Card className={CARD_ENTRANCE}>
      <CardHeader>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-72" />
      </CardHeader>
      <CardContent data-testid="balance-skeleton" className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map(index => (
          <div key={index} className="flex items-center gap-3 rounded-lg border p-4">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-7 w-20" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function AccountDetailPage() {
  const { accountId = '' } = useParams();
  const queryClient = useQueryClient();
  const [topupOpen, setTopupOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const ledgerQuery = useQuery({
    queryKey: ['admin-account-ledger', accountId],
    queryFn: () => listAdminAccountLedger(accountId, LEDGER_LIMIT),
    enabled: accountId !== '',
  });
  const permitsQuery = useQuery({
    queryKey: ['admin-account-permits', accountId],
    queryFn: () => listAdminAccountPermits(accountId, DETAIL_LIMIT),
    enabled: accountId !== '',
  });
  const ordersQuery = useQuery({
    queryKey: ['admin-account-orders', accountId],
    queryFn: () => listAdminAccountPublishOrders(accountId, DETAIL_LIMIT),
    enabled: accountId !== '',
  });
  const providerUsageQuery = useQuery({
    queryKey: ['admin-account-provider-usage', accountId],
    queryFn: () => listAdminAccountProviderUsage(accountId, DETAIL_LIMIT),
    enabled: accountId !== '',
  });
  const chatUsageQuery = useQuery({
    queryKey: ['admin-account-chat-usage', accountId],
    queryFn: () => listAdminAccountChatUsage(accountId, DETAIL_LIMIT),
    enabled: accountId !== '',
  });

  function refreshLedger() {
    void queryClient.invalidateQueries({ queryKey: ['admin-account-ledger', accountId] });
  }

  const account = ledgerQuery.data?.account;
  const balance = ledgerQuery.data?.balance;
  const entries = ledgerQuery.data?.entries ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <Link
            to="/accounts"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeftIcon className="size-4" /> 返回账号列表
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">账号详情</h1>
          {ledgerQuery.isLoading && (
            <div data-testid="detail-header-skeleton" className="flex items-center gap-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-14 rounded-md" />
            </div>
          )}
          {ledgerQuery.isError && (
            <p role="alert" className="text-destructive text-sm">
              {adminApiErrorMessage(ledgerQuery.error, '账号详情加载失败，请稍后重试。')}
            </p>
          )}
        </div>
        {account && (
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">{account.phone}</p>
            {account.status === 'active' ? (
              <Badge variant="success">正常</Badge>
            ) : (
              <Badge variant="destructive">已停用</Badge>
            )}
          </div>
        )}
      </div>

      {ledgerQuery.isLoading ? (
        <BalanceOverviewSkeleton />
      ) : (
        account &&
        balance && (
          <BalanceOverview total={balance.total} available={balance.available} frozen={balance.frozen} />
        )
      )}

      {account && (
        <>
          <Card
            className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
            style={{ animationDelay: '60ms' }}
          >
            <CardHeader>
              <CardTitle>用户名</CardTitle>
              <CardDescription>客户改名后列表保持准确；设置/清空即时生效。</CardDescription>
            </CardHeader>
            <CardContent>
              <DisplayNameEditor account={account} onSaved={refreshLedger} />
            </CardContent>
          </Card>

          <Card
            className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
            style={{ animationDelay: '120ms' }}
          >
            <CardHeader>
              <CardTitle>充值 / 调点</CardTitle>
              <CardDescription>
                充值最小粒度 0.1 元（1 元 = 10 点）；调点必须带备注，负数只动可用余额。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={() => setTopupOpen(true)}>
                <CreditCardIcon /> 充值
              </Button>
              <Button variant="outline" onClick={() => setAdjustOpen(true)}>
                <SlidersHorizontalIcon /> 调点
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
        style={{ animationDelay: '180ms' }}
      >
        <CardHeader>
          <CardTitle>点数流水</CardTitle>
          <CardDescription>最新 {LEDGER_LIMIT} 笔（最新在前）</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryGate
            isLoading={ledgerQuery.isLoading}
            isError={ledgerQuery.isError}
            error={ledgerQuery.error}
            fallback="点数流水加载失败，请稍后重试。"
            skeletonTestId="ledger-skeleton"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>变动</TableHead>
                  <TableHead>余额</TableHead>
                  <TableHead>备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 ? (
                  <EmptyRow columns={5} hint="暂无流水" />
                ) : (
                  entries.map(entry => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
                      <TableCell>{ledgerKindLabel(entry.kind)}</TableCell>
                      <TableCell>
                        <DeltaCell delta={entry.delta} />
                      </TableCell>
                      <TableCell>{entry.balanceAfter}</TableCell>
                      <TableCell className="max-w-md truncate" title={entry.note}>
                        {entry.note}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </QueryGate>
        </CardContent>
      </Card>

      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
        style={{ animationDelay: '240ms' }}
      >
        <CardHeader>
          <CardTitle>计费操作（permit）</CardTitle>
          <CardDescription>进行中与已结清的计费操作，最新在前</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryGate
            isLoading={permitsQuery.isLoading}
            isError={permitsQuery.isError}
            error={permitsQuery.error}
            fallback="计费操作加载失败，请稍后重试。"
            skeletonTestId="permits-skeleton"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>单位</TableHead>
                  <TableHead>单价</TableHead>
                  <TableHead>总额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>已扣 / 已退</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(permitsQuery.data?.permits ?? []).length === 0 ? (
                  <EmptyRow columns={7} hint="暂无计费操作" />
                ) : (
                  (permitsQuery.data?.permits ?? []).map(permit => (
                    <TableRow key={permit.permitId}>
                      <TableCell>{formatDateTime(permit.createdAt)}</TableCell>
                      <TableCell>{permit.operation}</TableCell>
                      <TableCell>{permit.units}</TableCell>
                      <TableCell>
                        {permit.unitPrice}
                        {permit.basePrice > 0 ? ` + 基础 ${permit.basePrice}` : ''}
                      </TableCell>
                      <TableCell>{permit.totalPoints}</TableCell>
                      <TableCell>{permitStatusLabel(permit.status)}</TableCell>
                      <TableCell>
                        {permit.consumedPoints} / {permit.refundedPoints}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </QueryGate>
        </CardContent>
      </Card>

      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
        style={{ animationDelay: '300ms' }}
      >
        <CardHeader>
          <CardTitle>发布订单</CardTitle>
          <CardDescription>订单预扣/结转/退点状态，最新在前</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryGate
            isLoading={ordersQuery.isLoading}
            isError={ordersQuery.isError}
            error={ordersQuery.error}
            fallback="发布订单加载失败，请稍后重试。"
            skeletonTestId="orders-skeleton"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>sn</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>点数</TableHead>
                  <TableHead>下单</TableHead>
                  <TableHead>账本</TableHead>
                  <TableHead>上游状态</TableHead>
                  <TableHead>链接</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(ordersQuery.data?.orders ?? []).length === 0 ? (
                  <EmptyRow columns={8} hint="暂无发布订单" />
                ) : (
                  (ordersQuery.data?.orders ?? []).map(order => (
                    <TableRow key={order.sn}>
                      <TableCell className="max-w-40 truncate" title={order.sn}>
                        {order.sn}
                      </TableCell>
                      <TableCell>{ORDER_KIND_LABELS[order.kind] ?? order.kind}</TableCell>
                      <TableCell>{order.points}</TableCell>
                      <TableCell>{PLACEMENT_LABELS[order.placementStatus] ?? order.placementStatus}</TableCell>
                      <TableCell>{LEDGER_STATUS_LABELS[order.ledgerStatus] ?? order.ledgerStatus}</TableCell>
                      <TableCell>{order.status === null ? '—' : order.status}</TableCell>
                      <TableCell>
                        {order.url === null ? (
                          '—'
                        ) : (
                          <a href={order.url} target="_blank" rel="noreferrer noopener">
                            链接
                          </a>
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(order.createdAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </QueryGate>
        </CardContent>
      </Card>

      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
        style={{ animationDelay: '360ms' }}
      >
        <CardHeader>
          <CardTitle>Provider 计量（对账用）</CardTitle>
          <CardDescription>网关代理的每次 Provider 请求计量，最新在前</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryGate
            isLoading={providerUsageQuery.isLoading}
            isError={providerUsageQuery.isError}
            error={providerUsageQuery.error}
            fallback="Provider 计量加载失败，请稍后重试。"
            skeletonTestId="provider-skeleton"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>路由</TableHead>
                  <TableHead>输入 token</TableHead>
                  <TableHead>输出 token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(providerUsageQuery.data?.records ?? []).length === 0 ? (
                  <EmptyRow columns={5} hint="暂无计量记录" />
                ) : (
                  (providerUsageQuery.data?.records ?? []).map(record => (
                    <TableRow key={record.id}>
                      <TableCell>{formatDateTime(record.createdAt)}</TableCell>
                      <TableCell>{record.provider}</TableCell>
                      <TableCell>{record.route}</TableCell>
                      <TableCell>{record.inputTokens}</TableCell>
                      <TableCell>{record.outputTokens}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </QueryGate>
        </CardContent>
      </Card>

      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
        style={{ animationDelay: '420ms' }}
      >
        <CardHeader>
          <CardTitle>对话计量（隐藏额度口径，千分之一点）</CardTitle>
          <CardDescription>
            本周期累计 {chatUsageQuery.data?.quotaUsedMilli ?? 0} 千分点；每请求折点最新在前
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryGate
            isLoading={chatUsageQuery.isLoading}
            isError={chatUsageQuery.isError}
            error={chatUsageQuery.error}
            fallback="对话计量加载失败，请稍后重试。"
            skeletonTestId="chat-skeleton"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>输入</TableHead>
                  <TableHead>缓存读</TableHead>
                  <TableHead>输出</TableHead>
                  <TableHead>折点（千分点）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(chatUsageQuery.data?.records ?? []).length === 0 ? (
                  <EmptyRow columns={6} hint="暂无对话计量" />
                ) : (
                  (chatUsageQuery.data?.records ?? []).map(record => (
                    <TableRow key={record.id}>
                      <TableCell>{formatDateTime(record.createdAt)}</TableCell>
                      <TableCell>{record.model}</TableCell>
                      <TableCell>{record.inputTokens}</TableCell>
                      <TableCell>{record.cacheReadTokens}</TableCell>
                      <TableCell>{record.outputTokens}</TableCell>
                      <TableCell>{record.pointsMilli}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </QueryGate>
        </CardContent>
      </Card>

      {account && (
        <>
          <TopupDialog
            account={{ id: account.id, phone: account.phone }}
            open={topupOpen}
            onOpenChange={setTopupOpen}
            onDone={() => {
              refreshLedger();
              setTopupOpen(false);
            }}
          />
          <AdjustDialog
            account={{ id: account.id, phone: account.phone }}
            open={adjustOpen}
            onOpenChange={setAdjustOpen}
            onDone={() => {
              refreshLedger();
              setAdjustOpen(false);
            }}
          />
        </>
      )}
    </div>
  );
}
