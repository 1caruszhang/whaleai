import { describe, expect, it } from "vitest";

import {
  ARTICLE_PREVIEW_CSS,
  renderArticleHtml,
  renderArticleHtmlDocument,
} from "./articlePreviewDocument";

describe("articlePreviewDocument", () => {
  const urls = new Map([["img-1", "blob:http://127.0.0.1/aaa"]]);

  it("renders headings, standard lists, bold and left-aligned paragraphs", () => {
    const html = renderArticleHtml(
      "# 标题\n\n## 小节\n\n段落 **加粗** 文本。\n\n- **维度一**：内容\n- **维度二**：内容\n  - 嵌套项",
      new Map(),
    );
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<h2>小节</h2>");
    expect(html).toContain("<p>段落 <strong>加粗</strong> 文本。</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li><strong>维度一</strong>：内容</li>");
    expect(html).toContain('<li class="nested">嵌套项</li>');
    expect(html).toContain("</ul>");
  });

  it("normalizes legacy checkmark lines into per-line list items", () => {
    // 存量正文（生成期归一之前落库）：行首 ✅ 相邻行按段落合并，全屏
    // 预览必须同样归一为逐行列表。
    const html = renderArticleHtml(
      "# 标题\n\n## 核心卖点\n✅ 按需求设计方案\n✅ 交付快",
      new Map(),
    );
    expect(html).toContain("<li>✅ 按需求设计方案</li>");
    expect(html).toContain("<li>✅ 交付快</li>");
  });

  it("embeds resolved material-image placeholders as figures with captions", () => {
    const html = renderArticleHtml(
      "# 标题\n\n![门店实景说明](material-image://img-1)",
      urls,
    );
    expect(html).toContain('<img src="blob:http://127.0.0.1/aaa" alt="门店实景说明"');
    expect(html).toContain('<figcaption class="image-caption">门店实景说明</figcaption>');
  });

  it("degrades unresolved placeholders to readable failure blocks, never raw scheme", () => {
    const html = renderArticleHtml(
      "# 标题\n\n![缺失图](material-image://missing-id)",
      urls,
    );
    expect(html).toContain('class="image-failed"');
    expect(html).not.toContain("material-image://missing-id");
  });

  it("escapes HTML in text to keep the standalone document inert", () => {
    const html = renderArticleHtml(
      "# 标题\n\n<script>alert(1)</script> 与 <b>标签</b>",
      new Map(),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("produces a self-contained document with embedded CSS for preview and export", () => {
    const doc = renderArticleHtmlDocument("# 标题\n\n正文", new Map(), "导出题");
    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain("<style>");
    expect(doc).toContain(ARTICLE_PREVIEW_CSS);
    expect(doc).toContain("<title>导出题</title>");
    // 阅读容器：内容栏居中 + 正文左对齐。
    expect(ARTICLE_PREVIEW_CSS).toContain("max-width: 42em");
    expect(ARTICLE_PREVIEW_CSS).toContain("margin: 0 auto");
    expect(ARTICLE_PREVIEW_CSS).toContain("text-align: left");
  });
});
