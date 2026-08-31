import { useMemo, useState } from "react";
import { Maximize2 } from "lucide-react";

import Markdown from "../Markdown";
import { normalizeUnicodeBulletsToMarkdown } from "../../../shared/geo/articleGeneration";
import ArticleFullscreenPreview from "./ArticleFullscreenPreview";
import {
  useMaterialImageResolver,
  useMaterialImages,
} from "./useMaterialImages";

/**
 * 文章正文渲染预览（ADR-0008 Decision 6）：批准卡与工作台批准稿共用的
 * 渲染态。正文按 markdown 渲染；`material-image://` 占位符经材料内容取回
 * 接口换本地 blob 显示——预览不依赖 OSS 发布，占位符是否入图在批准前
 * 即可验收。
 *
 * 版式（2026-08-31 用户裁决）：内容栏居中（最大约 42em）+ 两侧留白，
 * 正文左对齐；右上角提供全屏 HTML 预览入口（独立内嵌 CSS 的完整 HTML
 * 文档，所见即所得并支持导出）。
 */
export default function ArticleBodyPreview({
  body,
  workspaceId,
  title,
  className,
}: {
  body: string;
  workspaceId: string;
  /** 全屏预览标题栏展示用；缺省取正文 H1。 */
  title?: string;
  className?: string;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  // 展示层归一（幂等）：存量正文的行首圆点/✅ 未经过生成期归一，这里
  // 补一次，保证逐行列表渲染；新生成的正文已是标准列表，不受影响。
  const normalizedBody = useMemo(
    () => normalizeUnicodeBulletsToMarkdown(body),
    [body],
  );
  const entries = useMaterialImages(body, workspaceId);
  const resolveMaterialImage = useMaterialImageResolver(entries);

  return (
    <div className={className} data-article-body-preview>
      <div className="relative">
        <button
          type="button"
          aria-label="全屏预览文章"
          title="全屏 HTML 预览"
          onClick={() => setFullscreen(true)}
          className="absolute -top-1 right-0 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        {/* 阅读容器：内容栏居中 + 两侧留白，正文左对齐。 */}
        <div className="mx-auto w-full max-w-[42em] px-1">
          <Markdown raw resolveMaterialImage={resolveMaterialImage}>
            {normalizedBody}
          </Markdown>
        </div>
      </div>
      {fullscreen && (
        <ArticleFullscreenPreview
          body={body}
          title={title}
          entries={entries}
          onClose={() => setFullscreen(false)}
        />
      )}
    </div>
  );
}
