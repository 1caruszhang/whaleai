import { UsersIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 账号列表占位（票 46 骨架）：搜索/分页/排序/详情与行内操作在后续票接入
 * GET /admin/accounts（#45 接口扩展）后填充。
 */
export function AccountsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">账号</h1>
        <p className="text-muted-foreground text-sm">开通、停用与对账管理</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>账号列表</CardTitle>
          <CardDescription>搜索 / 分页 / 排序将在后续票接入</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3 text-sm">
          <UsersIcon className="size-8" />
          <span>骨架占位：账号列表待接入</span>
        </CardContent>
      </Card>
    </div>
  );
}
