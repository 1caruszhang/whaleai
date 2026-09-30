import { useQuery } from '@tanstack/react-query';
import {
  CreditCardIcon,
  RefreshCwIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAdminMediaPool,
  getAdminStatsOverview,
  yuanFromCents,
  type AdminMediaPool,
} from '@/lib/dashboard';
import { cn } from '@/lib/utils';

/**
 * 仪表盘首页（票 48）：总览卡（账号总数/活跃/停用、余额总计与冻结、今日
 * 充值、今日扣点）+ 近 30 天按日充值/扣点折线图（Recharts）+ 媒介池余额卡。
 * 媒介池上游失败走降级文案（degraded 标记），不阻断页面其余部分；低余额
 * 出预存提醒。两个查询互相独立——统计失败不影响媒介池卡展示。
 *
 * 票 #61 T-B 视觉对齐 shadcn-admin dashboard：页头（标题 + 描述 + 右侧
 * 刷新操作，刷新即重取既有两个 query，不改数据流）；统计卡圆角色块图标 +
 * 数值 + 描述、hover 阴影；折线图卡补渐变面积、卡式 tooltip；媒介池卡对齐
 * Recent Sales 卡样式（降级文案与低余额提醒原样保留）。加载态全部换成
 * ui/skeleton，卡片入场淡入 + 错峰延迟，功能与数据流零改动。
 */

const STATS_QUERY_KEY = ['admin-stats-overview'] as const;
const MEDIA_POOL_QUERY_KEY = ['admin-media-pool'] as const;

/** 卡片入场动画：淡入 + 上浮（tw-animate-css），fill-mode-both 保证错峰延迟期间不可见。 */
const CARD_ENTRANCE = 'animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500';

function formatPoints(points: number): string {
  return points.toLocaleString('zh-CN');
}

/** 序列日期 YYYY-MM-DD → MM-DD（X 轴刻度）。 */
function tickDate(date: string): string {
  return date.slice(5);
}

/** 折线图 tooltip：卡式浮层（对齐 shadcn-admin chart tooltip），按序列列点值。 */
function TrendChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || payload === undefined || payload.length === 0) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border p-2 text-xs shadow-md">
      <div className="text-muted-foreground mb-1 font-medium">{String(label ?? '')}</div>
      {payload.map(entry => (
        <div key={String(entry.dataKey)} className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span>{String(entry.name ?? '')}</span>
          <span className="ml-auto pl-4 font-medium tabular-nums">
            {formatPoints(Number(entry.value ?? 0))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 折线图加载骨架：柱状占位 + 基线，替换裸文字加载态。 */
function TrendChartSkeleton() {
  return (
    <div data-testid="chart-skeleton" className="flex h-full w-full flex-col gap-3">
      <div className="flex h-full items-end gap-2">
        {[45, 70, 55, 85, 60, 90, 75].map((height, index) => (
          <Skeleton key={index} className="w-full" style={{ height: `${height}%` }} />
        ))}
      </div>
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

function OverviewStatCard({
  icon: Icon,
  label,
  value,
  description,
  loading,
  index,
}: {
  icon: typeof UsersIcon;
  label: string;
  value: string;
  description: string;
  loading: boolean;
  /** 网格内序号：入场动画按序错峰。 */
  index: number;
}) {
  return (
    <Card
      className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md')}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        <CardAction>
          <span className="bg-background text-primary dark:bg-input/30 border-input dark:border-input inline-flex size-9 items-center justify-center rounded-lg border shadow-xs">
            <Icon className="size-4" />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-4 w-36" />
          </div>
        ) : (
          <>
            <div className="text-2xl font-bold">{value}</div>
            <p className="text-muted-foreground text-xs">{description}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MediaPoolCard({
  mediaPool,
  loading,
}: {
  mediaPool: AdminMediaPool | undefined;
  loading: boolean;
}) {
  const header = (
    <CardHeader>
      <CardTitle>超级媒介资金池</CardTitle>
      <CardDescription>资金池预警与预存入口</CardDescription>
    </CardHeader>
  );

  if (loading) {
    return (
      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md lg:col-span-3')}
        style={{ animationDelay: '300ms' }}
      >
        {header}
        <CardContent className="flex items-center gap-4">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="h-8 w-28" />
        </CardContent>
      </Card>
    );
  }

  if (
    mediaPool === undefined ||
    mediaPool.degraded ||
    mediaPool.balanceCents === undefined
  ) {
    return (
      <Card
        className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md lg:col-span-3')}
        style={{ animationDelay: '300ms' }}
      >
        {header}
        <CardContent className="text-muted-foreground text-sm">
          余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。
        </CardContent>
      </Card>
    );
  }

  const low = mediaPool.lowBalance ?? mediaPool.balanceCents < mediaPool.lowBalanceCents;
  return (
    <Card
      className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md lg:col-span-3')}
      style={{ animationDelay: '300ms' }}
    >
      {header}
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <WalletIcon className="size-4" />
          </span>
          <div className="flex-1 space-y-1">
            <div className="text-sm leading-none font-medium">媒介池可用余额</div>
            <div className="text-muted-foreground text-sm">
              低于 ¥{yuanFromCents(mediaPool.lowBalanceCents)} 自动预警
            </div>
          </div>
          <div className="text-primary text-2xl font-bold tabular-nums">
            ¥{yuanFromCents(mediaPool.balanceCents)}
          </div>
        </div>
        {low && (
          <p className="text-destructive text-sm font-medium">
            媒介池余额低于 ¥{yuanFromCents(mediaPool.lowBalanceCents)}，请及时预存资金池。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const statsQuery = useQuery({
    queryKey: STATS_QUERY_KEY,
    queryFn: getAdminStatsOverview,
  });
  const mediaPoolQuery = useQuery({
    queryKey: MEDIA_POOL_QUERY_KEY,
    queryFn: getAdminMediaPool,
  });

  const stats = statsQuery.data;
  const series = stats?.dailySeries ?? [];
  const refreshing = statsQuery.isFetching || mediaPoolQuery.isFetching;

  const handleRefresh = (): void => {
    void statsQuery.refetch();
    void mediaPoolQuery.refetch();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">仪表盘</h1>
          <p className="text-muted-foreground text-sm">整体经营状态总览</p>
        </div>
        <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {statsQuery.isError ? (
        <Card>
          <CardContent className="text-destructive flex h-24 items-center justify-center text-sm">
            统计加载失败，请稍后刷新重试。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <OverviewStatCard
            icon={UsersIcon}
            label="账号总数"
            value={stats ? formatPoints(stats.accounts.total) : ''}
            description={
              stats
                ? `活跃 ${formatPoints(stats.accounts.active)} · 停用 ${formatPoints(stats.accounts.disabled)}`
                : ''
            }
            loading={statsQuery.isPending}
            index={0}
          />
          <OverviewStatCard
            icon={CreditCardIcon}
            label="余额（点）"
            value={stats ? formatPoints(stats.balance.total) : ''}
            description={
              stats
                ? `可用 ${formatPoints(stats.balance.available)} · 冻结 ${formatPoints(stats.balance.frozen)}`
                : ''
            }
            loading={statsQuery.isPending}
            index={1}
          />
          <OverviewStatCard
            icon={TrendingUpIcon}
            label="今日充值（点）"
            value={stats ? formatPoints(stats.today.topup) : ''}
            description="北京时间日界"
            loading={statsQuery.isPending}
            index={2}
          />
          <OverviewStatCard
            icon={TrendingDownIcon}
            label="今日扣点（点）"
            value={stats ? formatPoints(stats.today.consume) : ''}
            description="北京时间日界"
            loading={statsQuery.isPending}
            index={3}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-7">
        <Card
          className={cn(CARD_ENTRANCE, 'transition-shadow hover:shadow-md lg:col-span-4')}
          style={{ animationDelay: '240ms' }}
        >
          <CardHeader>
            <CardTitle>近 30 天充值 / 扣点趋势</CardTitle>
            <CardDescription>按日序列（北京时间，空窗日补零）</CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            {statsQuery.isError ? (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                趋势数据加载失败
              </div>
            ) : statsQuery.isPending ? (
              <TrendChartSkeleton />
            ) : (
              <div className="animate-in fade-in-0 fill-mode-both duration-500 h-full w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="trend-fill-topup" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="trend-fill-consume" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={tickDate}
                      tick={{ fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis width={48} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <Tooltip content={props => <TrendChartTooltip {...props} />} />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="topup"
                      fill="url(#trend-fill-topup)"
                      stroke="none"
                      legendType="none"
                      tooltipType="none"
                    />
                    <Area
                      type="monotone"
                      dataKey="consume"
                      fill="url(#trend-fill-consume)"
                      stroke="none"
                      legendType="none"
                      tooltipType="none"
                    />
                    <Line
                      type="monotone"
                      dataKey="topup"
                      name="充值"
                      stroke="var(--chart-2)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="consume"
                      name="扣点"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <MediaPoolCard mediaPool={mediaPoolQuery.data} loading={mediaPoolQuery.isPending} />
      </div>
    </div>
  );
}
