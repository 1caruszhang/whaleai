import xiaojingLogo from '@/assets/xiaojing-logo.png';
import { cn } from '@/lib/utils';

/**
 * 鲸杉geo 运营台品牌标（登录页与侧边栏共用）：主应用品牌图 + 名称。
 *
 * 图片资产 src/assets/xiaojing-logo.png 是主应用品牌图
 * src/renderer/assets/brand/xiaojing-logo.png 的副本（复制而非移动，主应用
 * 仍使用原文件）。改动任何一端的图片后，须同时更新两处资产，否则两端
 * 品牌图会分叉。
 */
export function BrandLogo({
  className,
  collapsed = false,
}: {
  className?: string;
  /** 侧栏折叠态：只留品牌图，隐藏名称文字（AppShell 折叠时传入）。 */
  collapsed?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <img src={xiaojingLogo} alt="鲸杉geo" className="size-8 shrink-0 rounded-lg" />
      {!collapsed && (
        <div className="flex flex-col leading-tight">
          <span className="text-base font-semibold">鲸杉geo · 运营台</span>
          <span className="text-muted-foreground text-xs">Ops Console</span>
        </div>
      )}
    </div>
  );
}
