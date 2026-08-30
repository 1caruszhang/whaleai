import type { ComponentProps } from 'react';
import type ReactMarkdown from 'react-markdown';
import { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { MATERIAL_IMAGE_URI_SCHEME } from '../../shared/geo/materialImagePlaceholder';

// Sanitize schema: allow safe HTML tags from rehype-raw, strip scripts/iframes/event handlers.
// Extends the default GitHub-flavored schema with additional tags used in AI-generated content.
export const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details', 'summary',  // collapsible sections
    'mark', 'ins', 'del',  // text highlighting
    'sub', 'sup',           // subscript/superscript
    'kbd', 'var', 'samp',  // technical inline elements
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Keep the default language-* class support for fenced code blocks.
    // Do not allow arbitrary class/style on raw HTML: AI/user Markdown can
    // otherwise render Tailwind or fixed-position overlay markup as live DOM.
    // KaTeX runs after this sanitizer, so its generated classes are unaffected.
    code: defaultSchema.attributes?.code ?? [],
  },
};

export const MARKDOWN_REMARK_PLUGINS_DEFAULT: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  remarkMath,
];

export const MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  remarkMath,
  remarkBreaks,
];

export const MARKDOWN_REHYPE_PLUGINS: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  rehypeKatex,
];

/**
 * 材料图片预览 schema（ADR-0008 批准预览）：在默认 schema 之上只放行
 * `material-image` 协议的 `src`——占位符要活着穿过 sanitize 才能到自定义
 * <img> 组件换本地 blob。该 scheme 是 TS/Rust 共享的受控契约，仅由预览
 * 组件解释，聊天等默认管线继续剥掉它（schema 不放行即属性被移除）。
 */
export const MATERIAL_IMAGE_SANITIZE_SCHEMA = {
  ...MARKDOWN_SANITIZE_SCHEMA,
  protocols: {
    ...(MARKDOWN_SANITIZE_SCHEMA.protocols ?? defaultSchema.protocols ?? {}),
    src: [
      ...(MARKDOWN_SANITIZE_SCHEMA.protocols?.src ?? defaultSchema.protocols?.src ?? []),
      'material-image',
    ],
  },
};

export const MARKDOWN_REHYPE_PLUGINS_MATERIAL_IMAGE: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, MATERIAL_IMAGE_SANITIZE_SCHEMA],
  rehypeKatex,
];

/**
 * react-markdown 自带的 URL 闸（defaultUrlTransform）会把非白名单协议改写
 * 为空串——sanitize 放行了 material-image 后仍会被这层剥掉。预览管线在
 * 默认行为之上仅对受控 scheme 放行，其余 URL（含 javascript: 等）行为与
 * 默认完全一致。
 */
export const materialImageUrlTransform: UrlTransform = (url, _key, _node) =>
  url.startsWith(MATERIAL_IMAGE_URI_SCHEME) ? url : defaultUrlTransform(url);
/**
 * Convert YAML frontmatter (---\n...\n---) to a fenced yaml code block
 * so the existing CodeBlock component renders it with syntax highlighting.
 * Only applied in raw file-preview mode.
 */
export function convertFrontmatter(content: string): string {
  if (!content) return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return content;
  const yamlBlock = '```yaml\n' + match[1] + '\n```\n';
  return yamlBlock + content.slice(match[0].length);
}
