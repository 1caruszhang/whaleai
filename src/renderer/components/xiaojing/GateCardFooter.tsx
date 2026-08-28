import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

interface GateCardFooterProps {
  /** 页脚左侧极短说明：按风险分级填写——只有需要提示后果边界（付费、
   * 不可逆、确认后流向）的卡才放，普通操作留空。 */
  note?: ReactNode;
  /** 右下角主操作区：确认按钮，或确认后原位替换的成功态。 */
  children: ReactNode;
}

/**
 * 闸门卡统一页脚：确认键固定在卡片右下角；长列表在卡内滚动（上方容器
 * max-h + overflow），页脚始终可见可达。旧的通栏大按钮与「这是系统维护
 * 的确认卡片…」样板句按风险分级裁剪——普通操作零废话，只有花钱/不可逆
 * 的卡在左侧保留一枚极短提示（GD 反馈：频繁免责声明显得不专业）。
 */
export default function GateCardFooter({ note, children }: GateCardFooterProps) {
  return (
    <div
      data-gate-card-footer
      className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--line-subtle)] pt-2"
    >
      <p className="min-w-0 flex-1 text-xs leading-4 text-[var(--ink-subtle)]">{note}</p>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** 确认后的页脚原位成功态。 */
export function GateCardSuccess({ children }: { children: ReactNode }) {
  return (
    <span
      data-gate-card-success
      className="flex items-center gap-1.5 text-xs font-medium text-[var(--success)]"
    >
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </span>
  );
}
