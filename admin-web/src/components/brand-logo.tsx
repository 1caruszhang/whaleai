import { cn } from '@/lib/utils';

/** 鲸杉geo 运营台品牌标：渐变方块「鲸」字 + 名称（登录页与侧边栏共用）。 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="from-primary to-chart-4 flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-sm font-bold text-primary-foreground">
        鲸
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-base font-semibold">鲸杉geo · 运营台</span>
        <span className="text-muted-foreground text-xs">Ops Console</span>
      </div>
    </div>
  );
}
