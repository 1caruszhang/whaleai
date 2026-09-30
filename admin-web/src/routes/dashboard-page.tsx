import { useQuery } from '@tanstack/react-query';
import {
  CreditCardIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UsersIcon,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getAdminMediaPool,
  getAdminStatsOverview,
  yuanFromCents,
  type AdminMediaPool,
} from '@/lib/dashboard';

/**
 * 仪表盘首页（票 48）：总览卡（账号总数/活跃/停用、余额总计与冻结、今日
 * 充值、今日扣点）+ 近 30 天按日充值/扣点折线图（Recharts）+ 媒介池余额卡。
 * 媒介池上游失败走降级文案（degraded 标记），不阻断页面其余部分；低余额
 * 出预存提醒。两个查询互相独立——统计失败不影响媒介池卡展示。
 */

const STATS_QUERY_KEY = ['admin-stats-overview'] as const;
const MEDIA_POOL_QUERY_KEY = ['admin-media-pool'] as const;

function formatPoints(points: number): string {
  return points.toLocaleString('zh-CN');
}

/** 序列日期 YYYY-MM-DD → MM-DD（X 轴刻度）。 */
function tickDate(date: string): string {
  return date.slice(5);
}

function OverviewStatCard({
  icon: Icon,
  label,
  value,
  description,
}: {
  icon: typeof UsersIcon;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        <Icon className="text-muted-foreground size-4" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <CardDescription>{description}</CardDescription>
      </CardContent>
    </Card>
  );
}

function MediaPoolCard({ mediaPool }: { mediaPool: AdminMediaPool | undefined }) {
  if (!mediaPool) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>超级媒介资金池</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">加载中…</CardContent>
      </Card>
    );
  }
  if (mediaPool.degraded || mediaPool.balanceCents === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>超级媒介资金池</CardTitle>
          <CardDescription>资金池预警与预存入口</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。
        </CardContent>
      </Card>
    );
  }
  const low = mediaPool.lowBalance ?? mediaPool.balanceCents < mediaPool.lowBalanceCents;
  return (
    <Card>
      <CardHeader>
        <CardTitle>超级媒介资金池</CardTitle>
        <CardDescription>资金池预警与预存入口</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="text-2xl font-bold">
          当前余额：<span className="text-primary">¥{yuanFromCents(mediaPool.balanceCents)}</span>
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">仪表盘</h1>
        <p className="text-muted-foreground text-sm">整体经营状态总览</p>
      </div>

      {statsQuery.isError ? (
        <Card>
          <CardContent className="text-destructive flex h-24 items-center justify-center text-sm">
            统计加载失败，请稍后刷新重试。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewStatCard
            icon={UsersIcon}
            label="账号总数"
            value={stats ? formatPoints(stats.accounts.total) : '…'}
            description={
              stats
                ? `活跃 ${formatPoints(stats.accounts.active)} · 停用 ${formatPoints(stats.accounts.disabled)}`
                : '加载中'
            }
          />
          <OverviewStatCard
            icon={CreditCardIcon}
            label="余额（点）"
            value={stats ? formatPoints(stats.balance.total) : '…'}
            description={
              stats
                ? `可用 ${formatPoints(stats.balance.available)} · 冻结 ${formatPoints(stats.balance.frozen)}`
                : '加载中'
            }
          />
          <OverviewStatCard
            icon={TrendingUpIcon}
            label="今日充值（点）"
            value={stats ? formatPoints(stats.today.topup) : '…'}
            description="北京时间日界"
          />
          <OverviewStatCard
            icon={TrendingDownIcon}
            label="今日扣点（点）"
            value={stats ? formatPoints(stats.today.consume) : '…'}
            description="北京时间日界"
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>近 30 天充值 / 扣点趋势</CardTitle>
          <CardDescription>按日序列（北京时间，空窗日补零）</CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          {statsQuery.isError ? (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              趋势数据加载失败
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tickFormatter={tickDate} tick={{ fontSize: 12 }} />
                <YAxis width={48} tick={{ fontSize: 12 }} />
                <Tooltip formatter={value => formatPoints(Number(value ?? 0))} />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="topup"
                  name="充值"
                  stroke="var(--chart-2)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="consume"
                  name="扣点"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {mediaPoolQuery.isError && !mediaPoolQuery.data ? (
        <Card>
          <CardHeader>
            <CardTitle>超级媒介资金池</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。
          </CardContent>
        </Card>
      ) : (
        <MediaPoolCard mediaPool={mediaPoolQuery.data} />
      )}
    </div>
  );
}
