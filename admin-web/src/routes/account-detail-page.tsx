import { ArrowLeftIcon } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';

/**
 * 账号详情占位（票 47）：行操作下拉「详情」的落点。T3（票 48）接入
 * GET /admin/accounts/:accountId 的余额总览/充值/调点/点数流水/permit
 * 计费等卡片视图后替换本页。
 */
export function AccountDetailPage() {
  const { accountId } = useParams();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/accounts"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeftIcon className="size-4" /> 返回账号列表
        </Link>
        <h1 className="text-2xl font-semibold">账号详情</h1>
        <p className="text-muted-foreground text-sm">账号 {accountId}</p>
      </div>
      <Card>
        <CardContent className="text-muted-foreground flex h-64 items-center justify-center text-sm">
          详情视图（余额总览/充值/调点/点数流水等）将在后续票接入
        </CardContent>
      </Card>
    </div>
  );
}
