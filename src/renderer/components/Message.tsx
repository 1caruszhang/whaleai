import { Check, Copy, FileText } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import BlockGroup from '@/components/BlockGroup';
import Markdown from '@/components/Markdown';
import Tip from '@/components/Tip';
import ToolUse from '@/components/ToolUse';
import { useImagePreview } from '@/context/ImagePreviewContext';
import type { ContentBlock, Message as MessageType, ToolUseSimple } from '@/types/chat';
import { copyPlainText } from '@/utils/clipboard';
import { extractSessionFileReferences } from '@/../shared/sessionFileReference';
import {
  parseDecisionReminderText,
  type ParsedDecisionReminder,
} from '../../shared/systemReminder';
import { parseKnowledgeCandidatesCard } from '../../shared/geo/knowledgeCard';
import { parseMaterialRequestCard } from '../../shared/geo/materialRequestCard';
import { parseKnowledgeConflictCard } from './xiaojing/KnowledgeConflictCard';
import { parseGeoOperationEventCard } from './xiaojing/GeoOperationEventCard';
import { parseQuestionPoolGateCard } from './xiaojing/QuestionPoolGateCard';
import { parseTopicPlanGateCard } from './xiaojing/TopicPlanGateCard';
import { parseArticleApprovalGateCard } from './xiaojing/ArticleApprovalGateCard';
import { parseDistributionGateCard } from './xiaojing/DistributionGateCard';
import { parsePublishAuthorizationGateCard } from './xiaojing/PublishAuthorizationGateCard';

interface MessageProps {
  message: MessageType;
  isLoading?: boolean;
}

function assistantText(content: MessageType['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n\n');
}

function AssistantCopy({ content }: { content: MessageType['content'] }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const text = assistantText(content);
  if (!text.trim()) return null;
  return (
    <Tip label={copied ? '已复制' : '复制'}>
      <button
        type="button"
        aria-label="复制回复"
        onClick={() => void copyPlainText(text).then(() => {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), 1500);
        })}
        className="rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </Tip>
  );
}

/** 需要用户决策/阅读的结构化卡片不得被 BlockGroup 折叠卸载。 */
function isDecisionCardTool(tool: ToolUseSimple): boolean {
  if (!tool.result || tool.isLoading || !tool.name.startsWith('mcp__xiaojing-geo__')) {
    return false;
  }
  return parseKnowledgeCandidatesCard(tool.result) !== null
    || parseMaterialRequestCard(tool.result) !== null
    || parseKnowledgeConflictCard(tool.result) !== null
    || parseQuestionPoolGateCard(tool.result) !== null
    || parseTopicPlanGateCard(tool.result) !== null
    || parseArticleApprovalGateCard(tool.result) !== null
    || parseDistributionGateCard(tool.result) !== null
    || parsePublishAuthorizationGateCard(tool.result) !== null
    || parseGeoOperationEventCard(tool.result) !== null;
}

function AssistantBlocks({
  blocks,
  isLoading,
  streamingTextActive,
}: {
  blocks: ContentBlock[];
  isLoading: boolean;
  streamingTextActive: boolean;
}) {
  const parts = useMemo(() => {
    const flow: Array<
      | { kind: 'text'; block: ContentBlock }
      | { kind: 'process'; blocks: ContentBlock[] }
    > = [];
    const cards: ContentBlock[] = [];
    let process: ContentBlock[] = [];
    const flush = () => {
      if (process.length) flow.push({ kind: 'process', blocks: process });
      process = [];
    };
    for (const block of blocks) {
      if (block.type === 'text') {
        flush();
        flow.push({ kind: 'text', block });
      } else if (block.type === 'tool_use' && block.tool && isDecisionCardTool(block.tool)) {
        // 信息闸门卡片统一排在全部正文之后：用户先读结论再操作（DESIGN.md）。
        flush();
        cards.push(block);
      } else {
        process.push(block);
      }
    }
    flush();
    return [...flow, ...cards.map((block) => ({ kind: 'card' as const, block }))];
  }, [blocks]);

  const lastProcessIndex = parts.map((part) => part.kind).lastIndexOf('process');

  return (
    <>
      {parts.map((part, index) => part.kind === 'text' ? (
        <Markdown key={index} streaming={isLoading && streamingTextActive}>{part.block.text ?? ''}</Markdown>
      ) : part.kind === 'process' ? (
        <BlockGroup key={index} blocks={part.blocks} isLatestActiveSection={index === lastProcessIndex} isStreaming={isLoading} />
      ) : part.block.type === 'tool_use' && part.block.tool ? (
        // 思考/流式未结束前不出现决策卡：等本回合收尾、用户读完结论，卡片再出现。
        isLoading ? null : (
          <div key={index} className="my-3"><ToolUse tool={part.block.tool} /></div>
        )
      ) : null)}
    </>
  );
}

/**
 * 决策回执 reminder 的自然语言投影：阀门确认后服务端会把结构化信封作为
 * 用户消息入队唤醒 Agent（协议原文只给 LLM 读）；renderer 用这里返回的
 * 文案代替裸 XML 扁平文本，避免聊天流里出现 UUID/枚举机器串。
 */
function decisionReminderLabel(reminder: ParsedDecisionReminder): string | null {
  if (reminder.kind === 'XIAOJING_GEO_OPERATION_EVENT') {
    const action = reminder.action ?? '';
    if (action === 'confirm-step:acknowledge-plan') return '认可本次计划';
    if (action.startsWith('confirm-step:')) return '确认操作步骤';
    switch (action) {
      case 'pause': return '暂停 GEO 操作';
      case 'resume': return '恢复 GEO 操作';
      case 'retry': return '重试失败单元';
      case 'cancel': return '取消 GEO 操作';
      case 'next-round-update-knowledge': return '下一轮更新品牌知识';
      case 'next-round-keep-knowledge': return '下一轮沿用品牌知识';
      default: return 'GEO 操作已更新';
    }
  }
  switch (reminder.kind) {
    case 'XIAOJING_KNOWLEDGE_DECISION': return '确认品牌知识候选';
    case 'XIAOJING_QUESTION_POOL_DECISION': return '确认题库选题';
    case 'XIAOJING_TOPIC_PLAN_DECISION': return '确认选题计划';
    case 'XIAOJING_ARTICLE_APPROVAL_DECISION': return '提交文章审核结果';
    case 'XIAOJING_DISTRIBUTION_PLAN_DECISION': return '确认分发计划';
    default: return null;
  }
}

function formatTimestamp(date: Date): string {
  const segments = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ];
  return `${segments.join('-')} ${time.join(':')}`;
}

export default memo(function Message({ message, isLoading = false }: MessageProps) {
  const { openPreview } = useImagePreview();
  const timestamp = Number.isNaN(message.timestamp.getTime())
    ? ''
    : formatTimestamp(message.timestamp);

  if (message.role === 'user') {
    const { cleanText, references } = typeof message.content === 'string'
      ? extractSessionFileReferences(message.content)
      : { cleanText: '', references: [] };
    // 决策回执 reminder（阀门确认后自动入队）：整条内容就是结构化信封时
    // 投影成自然语言，而不是把 XML 扁平化文本当作用户输入渲染。
    const reminder = typeof message.content === 'string'
      ? parseDecisionReminderText(message.content)
      : null;
    const reminderText = reminder ? decisionReminderLabel(reminder) : null;
    return (
      <div className="group/user-actions ml-auto w-fit max-w-[85%]">
        <article className="rounded-2xl rounded-br-md bg-[var(--accent)]/15 p-4 text-[var(--ink)]" data-message-role="user">
          {references.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5" data-testid="user-session-files">
              {references.map((path) => (
                <span
                  key={path}
                  title={path}
                  className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)]"
                >
                  <FileText className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                  <span className="truncate">{path.split('/').pop() ?? path}</span>
                </span>
              ))}
            </div>
          )}
          {message.attachments?.length ? (
            <AttachmentPreviewList
              compact
              attachments={message.attachments}
              onPreview={(url, name) => openPreview(url, name)}
              className="mb-2"
            />
          ) : null}
          {reminderText ? (
            <div
              className="user-message-content"
              data-system-reminder={reminder?.kind}
              title={typeof message.content === 'string' ? message.content : undefined}
            >
              <p className="whitespace-pre-wrap break-words">{reminderText}</p>
            </div>
          ) : typeof message.content === 'string' && cleanText ? (
            <div className="user-message-content">
              <Markdown>{cleanText}</Markdown>
            </div>
          ) : null}
        </article>
        {timestamp ? (
          <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover/user-actions:opacity-100 group-focus-within/user-actions:opacity-100">
            <span className="text-xs text-[var(--ink-muted)]">{timestamp}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <article className="max-w-full py-2 text-[var(--ink)]" data-message-role="assistant">
      {typeof message.content === 'string'
        ? <Markdown streaming={isLoading && message.streamingTextActive === true}>{message.content}</Markdown>
        : <AssistantBlocks
            blocks={message.content}
            isLoading={isLoading}
            streamingTextActive={message.streamingTextActive === true}
          />}
      {!isLoading ? <div className="mt-1 flex items-center gap-2"><AssistantCopy content={message.content} />{timestamp ? <span className="text-xs text-[var(--ink-muted)]">{timestamp}</span> : null}</div> : null}
    </article>
  );
});
