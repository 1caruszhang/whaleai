import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardCopy, Download, X } from "lucide-react";

import { copyPlainText } from "@/utils/clipboard";

import { renderArticleHtmlDocument } from "./articlePreviewDocument";
import {
  readyImageDataUrls,
  readyImageUrls,
  type MaterialImageEntry,
} from "./useMaterialImages";

/**
 * 全屏 HTML 文章预览（2026-08-31 用户裁决 C）：正文渲染为独立完整 HTML
 * 文档（内嵌 ARTICLE_PREVIEW_CSS），iframe 隔离展示；导出/复制与预览共用
 * 同一文档生成器。图片寻址按用途区分：iframe 预览内嵌会话期 blob: URL，
 * 导出/复制内嵌 data: URL——blob: 离开会话即失效，导出件必须自带图片
 * 字节才能在会话外打开不裂图。版式与卡内轻量预览一致：内容栏居中、
 * 正文左对齐。Esc 关闭。
 *
 * 图片 entries 由父组件（ArticleBodyPreview）取一次下传——全屏与卡内
 * 共用同一份取回结果与 blob 注册表，不重复取数。
 */
export default function ArticleFullscreenPreview({
  body,
  title,
  entries,
  onClose,
}: {
  body: string;
  title?: string;
  entries: ReadonlyMap<string, MaterialImageEntry>;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "done" | "failed">(
    "idle",
  );

  const documentHtml = useMemo(
    () => renderArticleHtmlDocument(body, readyImageUrls(entries), title),
    [body, entries, title],
  );
  const fileTitle = useMemo(
    () => (title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || "文章").replace(
      /[\\/:*?"<>|]/g,
      "_",
    ),
    [body, title],
  );

  // react_stability_rules 规则 3：父组件内联 onClose 每次渲染新引用，
  // 经 ref 读取，Esc 监听 effect 依赖保持为空不重挂。
  const onCloseRef = useRef(onClose);
  const timersRef = useRef<number[]>([]);
  useEffect(() => {
    onCloseRef.current = onClose;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    const timers = timersRef.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
    };
  }, [onClose]);

  // 规则 4：状态复位/revoke 定时器全部登记，组件卸载时统一清理。
  const schedule = (action: () => void, delayMs: number) => {
    timersRef.current.push(window.setTimeout(action, delayMs));
  };

  const buildExportHtml = async () =>
    renderArticleHtmlDocument(body, await readyImageDataUrls(entries), title);

  const copyHtml = async () => {
    try {
      await copyPlainText(await buildExportHtml());
      setCopied(true);
      schedule(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const downloadHtml = async () => {
    try {
      const blob = new Blob([await buildExportHtml()], {
        type: "text/html;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileTitle}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      schedule(() => URL.revokeObjectURL(url), 5000);
      setDownloadState("done");
      schedule(() => setDownloadState("idle"), 1500);
    } catch {
      setDownloadState("failed");
      schedule(() => setDownloadState("idle"), 2000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[var(--paper)]"
      role="dialog"
      aria-label="文章全屏预览"
      data-article-fullscreen-preview
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
          {title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || "文章预览"}
        </p>
        <button
          type="button"
          onClick={() => void copyHtml()}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[var(--success)]" />
          ) : (
            <ClipboardCopy className="h-3.5 w-3.5" />
          )}
          {copied ? "已复制" : "复制 HTML"}
        </button>
        <button
          type="button"
          onClick={() => void downloadHtml()}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)]"
        >
          <Download className="h-3.5 w-3.5" />
          {downloadState === "done"
            ? "已开始下载"
            : downloadState === "failed"
              ? "下载失败，可复制 HTML"
              : "下载 .html"}
        </button>
        <button
          type="button"
          aria-label="关闭全屏预览"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <iframe
        title="文章 HTML 预览"
        srcDoc={documentHtml}
        className="min-h-0 w-full flex-1 border-0"
        sandbox="allow-same-origin"
      />
    </div>
  );
}
