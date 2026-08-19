import { useMemo } from "react";
import ReactMarkdown from "react-markdown";

import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS_DEFAULT,
} from "@/utils/markdownPipeline";

/**
 * 渠道回传订单截图渲染（票 09）：截图是查单透传的用户来源 HTML，绝不能
 * innerHTML 直插。这里复用聊天 Markdown 的现有 sanitize 栈（rehype-raw +
 * rehype-sanitize，schema 见 markdownPipeline）：脚本、事件处理器、
 * javascript: 链接等在渲染前被清洗，图片与文本内容保留。渲染产物由
 * React 元素树组装，本组件不使用 dangerouslySetInnerHTML。
 */
export default function PublishOrderScreenshot({ html }: { html: string }) {
  // 截图内容按引用整体替换；空串渲染为空。
  const content = useMemo(() => html.trim(), [html]);
  return (
    <div
      data-publish-order-screenshot
      className="overflow-hidden rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-2 text-xs leading-5 [&_img]:max-w-full"
    >
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS_DEFAULT}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
