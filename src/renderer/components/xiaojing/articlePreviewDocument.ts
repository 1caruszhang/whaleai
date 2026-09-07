import { MATERIAL_IMAGE_URI_SCHEME } from "../../../shared/geo/materialImagePlaceholder";
import { normalizeUnicodeBulletsToMarkdown } from "../../../shared/geo/articleGeneration";

/**
 * 文章独立 HTML 预览文档（2026-08-31 用户裁决 C）：全屏预览与导出共用
 * 同一个生成器，保证「预览 = 导出」——正文结构与 CSS 字节完全相同，仅图片
 * 寻址按用途区分：iframe 预览传会话期 blob: URL，导出/复制传 data: URL
 * （blob: 离开会话即失效，导出件内嵌图片字节才自包含）。
 * 文档不依赖应用主题/外部资源：CSS 全量内嵌（ARTICLE_PREVIEW_CSS），
 * 图片 URL 由调用方经 useMaterialImages 取回后传入。
 *
 * 转换器只覆盖文章正文的受控语法（H1/H2/H3、标准列表、加粗、
 * material-image 图片、段落）——正文在 parseGeneratedArticleBody 已归一，
 * 这里不做宽松 Markdown 解析，未知语法按纯文本安全转义输出。
 */

export const ARTICLE_PREVIEW_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f7f6f3; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: #26241f;
  line-height: 1.85;
  font-size: 16px;
}
.article {
  max-width: 42em;
  margin: 0 auto;
  padding: 40px 24px 64px;
  background: #fffdf9;
  min-height: 100vh;
}
h1 {
  font-size: 1.55em;
  line-height: 1.5;
  text-align: center;
  margin: 8px 0 28px;
  color: #1d1b17;
}
h2 {
  font-size: 1.22em;
  margin: 36px 0 12px;
  padding-left: 10px;
  border-left: 4px solid #b9812f;
  color: #1d1b17;
  font-weight: 600;
}
h3 { font-size: 1.08em; margin: 24px 0 8px; color: #1d1b17; font-weight: 600; }
p { margin: 12px 0; text-align: left; }
ul, ol { margin: 12px 0; padding-left: 1.5em; text-align: left; }
li { margin: 7px 0; }
li.nested { margin: 5px 0; }
img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 22px auto 6px;
  border-radius: 10px;
}
.image-caption {
  text-align: center;
  font-size: 0.82em;
  color: #8a8578;
  margin: 0 0 18px;
}
.image-failed {
  margin: 18px 0;
  padding: 12px 16px;
  border: 1px dashed #d8c9a8;
  border-radius: 8px;
  background: #faf5ea;
  color: #8a6a2f;
  font-size: 0.88em;
  text-align: center;
}
strong { color: #1d1b17; }
blockquote {
  margin: 14px 0;
  padding: 10px 16px;
  border-left: 3px solid #d8c9a8;
  background: #faf7f0;
  color: #55503f;
}
@media print {
  html, body { background: #fff; }
  .article { padding: 0; max-width: none; }
}
`.trim();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 行内语法：加粗（**text**）与材料图片占位符；其余按纯文本转义。 */
function renderInline(
  text: string,
  imageUrlById: ReadonlyMap<string, string>,
): string {
  const imagePattern = new RegExp(
    `!\\[([^\\]]*)\\]\\(${MATERIAL_IMAGE_URI_SCHEME}([^)\\s]+)\\)`,
    "g",
  );
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(imagePattern)) {
    const start = match.index ?? 0;
    html += renderBoldOnly(text.slice(cursor, start));
    const [, alt, imageId] = match;
    const url = imageUrlById.get(imageId);
    if (url) {
      html += `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />${
        alt ? `<figcaption class="image-caption">${escapeHtml(alt)}</figcaption>` : ""
      }</figure>`;
    } else {
      html += `<div class="image-failed">图片（${escapeHtml(imageId.slice(0, 8))}…）未能加载：不在候选池或取回失败</div>`;
    }
    cursor = start + match[0].length;
  }
  html += renderBoldOnly(text.slice(cursor));
  return html;
}

function renderBoldOnly(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

/** 正文 Markdown（受控语法）→ HTML 片段。存量正文的行首圆点/✅ 在
 * 生成期归一上线前落库，这里再归一一次（幂等）让旧文同样逐行对齐。 */
export function renderArticleHtml(
  body: string,
  imageUrlById: ReadonlyMap<string, string>,
): string {
  const lines = normalizeUnicodeBulletsToMarkdown(body).split(/\r?\n/);
  const out: string[] = [];
  const listStack: number[] = [];

  const closeLists = () => {
    while (listStack.length) {
      listStack.pop();
      out.push("</ul>");
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      closeLists();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderBoldOnly(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = /^(\s*)([-*])\s+(.*)$/.exec(line);
    if (listItem) {
      const indent = listItem[1].length;
      const nested = indent >= 2;
      if (listStack.length === 0) {
        out.push("<ul>");
        listStack.push(0);
      } else if (nested && listStack.length === 1) {
        out.push("<ul>");
        listStack.push(indent);
      } else if (!nested && listStack.length === 2) {
        out.push("</ul>");
        listStack.pop();
      }
      out.push(
        `<li${nested && listStack.length === 2 ? ' class="nested"' : ""}>${renderInline(listItem[3], imageUrlById)}</li>`,
      );
      continue;
    }
    closeLists();
    out.push(`<p>${renderInline(line, imageUrlById)}</p>`);
  }
  closeLists();
  return out.join("\n");
}

/** 完整独立 HTML 文档（全屏预览 iframe srcDoc 与导出文件共用）。 */
export function renderArticleHtmlDocument(
  body: string,
  imageUrlById: ReadonlyMap<string, string>,
  title?: string,
): string {
  const headingTitle = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const documentTitle = escapeHtml(title || headingTitle || "文章预览");
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${documentTitle}</title>`,
    `<style>${ARTICLE_PREVIEW_CSS}</style>`,
    "</head>",
    "<body>",
    '<main class="article">',
    renderArticleHtml(body, imageUrlById),
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}
