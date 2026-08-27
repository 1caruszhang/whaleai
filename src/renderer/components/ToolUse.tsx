import { CircleAlert, Loader2 } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';

import type { ToolUseSimple } from '@/types/chat';
import { CollapsibleTool } from './tools/CollapsibleTool';
import {
  formatToolResultPreview,
  hasMeaningfulInput,
  xiaojingToolLabelKey,
} from './tools/toolDisplay';
import GeoOperationEventCard, { parseGeoOperationEventCard } from './xiaojing/GeoOperationEventCard';
import KnowledgeBatchCard, { parseKnowledgeCandidatesCard } from './xiaojing/KnowledgeBatchCard';
import MaterialRequestCard, { parseMaterialRequestCard } from './xiaojing/MaterialRequestCard';
import KnowledgeConflictCard, { parseKnowledgeConflictCard } from './xiaojing/KnowledgeConflictCard';
import QuestionPoolGateCard, { parseQuestionPoolGateCard } from './xiaojing/QuestionPoolGateCard';
import TopicPlanGateCard, { parseTopicPlanGateCard } from './xiaojing/TopicPlanGateCard';
import ArticleApprovalGateCard, { parseArticleApprovalGateCard } from './xiaojing/ArticleApprovalGateCard';
import DistributionGateCard, { parseDistributionGateCard } from './xiaojing/DistributionGateCard';
import PublishAuthorizationGateCard, { parsePublishAuthorizationGateCard } from './xiaojing/PublishAuthorizationGateCard';

interface ToolUseProps {
  tool: ToolUseSimple;
}

function blockLabel(text: string): React.JSX.Element {
  return (
    <p className="text-xs font-medium uppercase tracking-[0.04em] text-[var(--ink-subtle)]">{text}</p>
  );
}

/** Renderer for the only executable product capability: xiaojing-geo MCP. */
export default function ToolUse({ tool }: ToolUseProps): React.JSX.Element {
  const { t } = useTranslation('chat');

  if (tool.name.startsWith('mcp__xiaojing-geo__') && tool.result) {
    const batchCard = parseKnowledgeCandidatesCard(tool.result);
    if (batchCard) return <KnowledgeBatchCard data={batchCard} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__request_brand_material' && tool.result) {
    const materialRequest = parseMaterialRequestCard(tool.result);
    if (materialRequest) return <MaterialRequestCard data={materialRequest} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__propose_brand_fact' && tool.result) {
    const knowledgeCard = parseKnowledgeConflictCard(tool.result);
    if (knowledgeCard) return <KnowledgeConflictCard data={knowledgeCard} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__run_question_pool' && tool.result) {
    const poolCard = parseQuestionPoolGateCard(tool.result);
    if (poolCard) return <QuestionPoolGateCard data={poolCard} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__plan_topics' && tool.result) {
    const planCard = parseTopicPlanGateCard(tool.result);
    if (planCard) return <TopicPlanGateCard data={planCard} />;
  }
  // 按信封 kind 分发而非工具名：confirm_ranking_competitors 恢复生成时
  // 返回与 generate_articles 相同的 article-operation 信封，都必须渲染批准卡。
  if (tool.name.startsWith('mcp__xiaojing-geo__') && tool.result) {
    const articleCard = parseArticleApprovalGateCard(tool.result);
    if (articleCard) return <ArticleApprovalGateCard data={articleCard} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__plan_distribution' && tool.result) {
    const distributionCard = parseDistributionGateCard(tool.result);
    if (distributionCard) return <DistributionGateCard data={distributionCard} />;
  }
  if (tool.name === 'mcp__xiaojing-geo__prepare_publish' && tool.result) {
    const publishCard = parsePublishAuthorizationGateCard(tool.result);
    if (publishCard) return <PublishAuthorizationGateCard data={publishCard} />;
  }
  if (tool.name.startsWith('mcp__xiaojing-geo__') && tool.result) {
    const operationEvent = parseGeoOperationEventCard(tool.result);
    if (operationEvent) return <GeoOperationEventCard data={operationEvent} />;
  }

  // 通用过程行：登记过的工具显示动作标签（title 保留原始 FQN 供诊断），
  // 展开后输入与结果分段呈现；空输入 `{}` 与执行中状态不产生噪声输出。
  const labelKey = xiaojingToolLabelKey(tool.name);
  const label = labelKey ? t(labelKey) : tool.name;
  const resultPreview = !tool.isLoading && tool.result !== undefined
    ? formatToolResultPreview(tool.result)
    : null;
  const resultPreClass = `overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-sm wrap-break-word whitespace-pre-wrap ${
    tool.isError ? 'text-[var(--danger)]' : 'text-[var(--ink-secondary)]'
  }`;

  return (
    <CollapsibleTool
      collapsedContent={
        <div className="flex min-w-0 items-center gap-1.5">
          {tool.isLoading ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ink-muted)]" aria-hidden />
          ) : tool.isError ? (
            <CircleAlert className="h-3 w-3 shrink-0 text-[var(--danger)]" aria-hidden />
          ) : null}
          <span className="truncate font-medium" title={tool.name}>{label}</span>
          {tool.isError && !tool.isLoading ? (
            <span className="shrink-0 text-xs text-[var(--danger)]">{t('process.common.failedLabel')}</span>
          ) : null}
        </div>
      }
      expandedContent={
        <>
          {hasMeaningfulInput(tool.inputJson) && (
            <div>
              {blockLabel(t('process.common.inputLabel'))}
              <pre className="overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-sm wrap-break-word whitespace-pre-wrap text-[var(--ink-secondary)]">{tool.inputJson}</pre>
            </div>
          )}
          <div>
            {blockLabel(t('process.common.outputLabel'))}
            {tool.isLoading ? (
              <p className="text-sm text-[var(--ink-muted)]">{t('process.common.runningLabel')}</p>
            ) : resultPreview ? (
              <>
                <pre className={`max-h-64 overflow-y-auto ${resultPreClass}`}>{resultPreview.text}</pre>
                {resultPreview.truncated ? (
                  <p className="text-xs text-[var(--ink-subtle)]">
                    {t('process.common.truncatedLabel', { count: resultPreview.totalChars })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-[var(--ink-muted)]">{t('process.common.emptyResultLabel')}</p>
            )}
          </div>
        </>
      }
    />
  );
}
