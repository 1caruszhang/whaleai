import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';

import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REHYPE_PLUGINS_MATERIAL_IMAGE,
  MARKDOWN_REMARK_PLUGINS_DEFAULT,
  materialImageUrlTransform,
} from './markdownPipeline';

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: MARKDOWN_REMARK_PLUGINS_DEFAULT,
        rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
      },
      markdown,
    ),
  );
}

function renderMarkdownWithMaterialImage(markdown: string): string {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: MARKDOWN_REMARK_PLUGINS_DEFAULT,
        rehypePlugins: MARKDOWN_REHYPE_PLUGINS_MATERIAL_IMAGE,
        urlTransform: materialImageUrlTransform,
      },
      markdown,
    ),
  );
}

describe('markdownPipeline sanitization', () => {
  it('strips raw HTML classes and inline styles that can escape the message bounds', () => {
    const html = renderMarkdown([
      '<div class="fixed inset-0 z-[9999] bg-black/50" style="position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.5)">遮罩</div>',
      '<span class="fixed inset-0 bg-black/50" style="position: fixed; inset: 0">span</span>',
    ].join('\n'));

    expect(html).toContain('<div');
    expect(html).toContain('遮罩');
    expect(html).toContain('<span>span</span>');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('fixed');
    expect(html).not.toContain('inset-0');
    expect(html).not.toContain('z-[9999]');
    expect(html).not.toContain('position:fixed');
  });

  it('keeps safe semantic raw HTML tags', () => {
    const html = renderMarkdown('H<sub>2</sub>O + x<sup>2</sup> <mark>ok</mark>');

    expect(html).toContain('H<sub>2</sub>O');
    expect(html).toContain('x<sup>2</sup>');
    expect(html).toContain('<mark>ok</mark>');
  });

  it('keeps fenced HTML as escaped code instead of live DOM', () => {
    const html = renderMarkdown('```tsx\n<div className="fixed inset-0">x</div>\n```');

    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-tsx">');
    expect(html).toContain('&lt;div className=&quot;fixed inset-0&quot;&gt;x&lt;/div&gt;');
    expect(html).not.toContain('<div class="fixed');
  });

  it('keeps KaTeX-generated classes because math rendering runs after sanitize', () => {
    const html = renderMarkdown('$x$');

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-mathml"');
    expect(html).toContain('class="katex-html"');
  });

  // ADR-0008 批准预览：material-image:// 占位符要经自定义 <img> 组件换成
  // 本地 blob，src 必须活着穿过 sanitize；聊天等默认管线保持原样剥掉。
  it('keeps material-image placeholder img src only in the material-image pipeline', () => {
    const body = '# 标题\n\n![产品图](material-image://img-17)';
    const preview = renderMarkdownWithMaterialImage(body);
    expect(preview).toContain('src="material-image://img-17"');
    expect(preview).toContain('alt="产品图"');

    const chat = renderMarkdown(body);
    expect(chat).not.toContain('material-image:');
  });

  it('keeps raw html <img> material-image src subject to the same split', () => {
    const raw = '<img src="material-image://img-raw" alt="x">';
    expect(renderMarkdownWithMaterialImage(raw)).toContain('src="material-image://img-raw"');
    expect(renderMarkdown(raw)).not.toContain('material-image:');
  });
});
