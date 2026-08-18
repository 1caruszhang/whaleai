import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Markdown from "@/components/Markdown";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import type { ComplianceDoc } from "./complianceDocs";

/**
 * 合规文件只读查看器（票 11）：首登勾选链接与「设置 → 个人信息」入口共用。
 * 全文走现有 Markdown 只读栈（raw 模式跳过聊天流式预处理），只展示、
 * 不提供任何编辑或确认入口；确认语义仍在登录门的勾选本身。
 */
export default function ComplianceDocViewer({
  doc,
  onClose,
}: {
  doc: ComplianceDoc;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[220] p-6">
      <div
        role="dialog"
        aria-label={doc.title}
        data-compliance-doc={doc.id}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            {doc.title}
          </h2>
          <button
            type="button"
            aria-label={t("account.close")}
            onClick={onClose}
            className="p-1 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 text-sm">
          <Markdown raw>{doc.content}</Markdown>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
