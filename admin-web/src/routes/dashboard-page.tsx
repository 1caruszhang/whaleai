import { CreditCardIcon, TrendingDownIcon, TrendingUpIcon, UsersIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 仪表盘占位（票 46 骨架）：总览卡与近 30 天趋势在后续票接入
 * GET /admin/stats/overview 后填充；本票不新增 JSON API，只立壳。
 */
const placeholderStats = [
  { key: 'total', label: '账号总数', icon: UsersIcon },
  { key: 'balance', label: '总余额（点）', icon: CreditCardIcon },
  { key: 'topup', label: '今日充值（点）', icon: TrendingUpIcon },
  { key: 'consume', label: '今日扣点（点）', icon: TrendingDownIcon },
];

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">仪表盘</h1>
        <p className="text-muted-foreground text-sm">整体经营状态总览</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {placeholderStats.map(stat => (
          <Card key={stat.key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {stat.label}
              </CardTitle>
              <stat.icon className="text-muted-foreground size-4" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">—</div>
              <CardDescription>数据接入将在后续票完成</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>近 30 天充值 / 扣点趋势</CardTitle>
          <CardDescription>折线图在统计接口接入后呈现</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          骨架占位：趋势视图待接入
        </CardContent>
      </Card>
    </div>
  );
}
