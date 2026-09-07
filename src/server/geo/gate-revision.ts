/**
 * 通用闸门修订分发骨架（ADR 0003）：聊天里的显式改/删/增指令经单一受限
 * 工具按闸门类型分发到对应域 owner。本模块持有分发契约、回执投影与工具
 * 纪律文案；知识闸门 handler 在此作为参考实现注册，其余闸门经
 * {@link registerGateRevisionHandler} 接入，无需改动工具契约。
 */

import {
  createKnowledgeAuthority,
  type KnowledgeRevisionInput,
} from './knowledge-authority';
import type { ArticleGenerationService } from './article-generation';
import type { DistributionPlanningService } from './distribution-plan';
import type { PublishSchedulerPort } from './publish-scheduler';
import type { QuestionPoolService } from './question-pool';
import type { TopicPlanService } from './topic-plan';
import { geoServices } from './service-composition';
import type {
  TopicPlanItem,
  TopicPlanKnowledgeFact,
  TopicPlanProjection,
} from '../../shared/geo/topicPlan';
import type {
  DistributionAssignment,
  DistributionPlanEditInput,
  DistributionPlanProjection,
} from '../../shared/geo/distributionPlan';
import type { PublishExecutionProjection } from '../../shared/geo/publishScheduler';
import { pointsToCny } from '../../shared/geo/points';

export const GATE_REVISION_TOOL_NAME = 'revise_gate_content';

/**
 * 工具纪律写死在描述里（ADR 0003）：仅基于用户显式指令、不得自行判断
 * 删除。修订只作用于未决内容；已入库事实仍走既有单条提案/冲突卡通道。
 */
export const GATE_REVISION_TOOL_DESCRIPTION = [
  "Revise content that is still pending on a confirmation gate, strictly from the user's explicit instruction given in chat (e.g. 删掉核心产品第三条 / 行业改成汽车后市场装具).",
  'This is the single restricted entry for every gate: pass the gate type plus a list of modify/delete/add operations, each carrying the user\'s verbatim instruction (userInstruction) for audit.',
  'Pending gate content only — already-adjudicated authoritative facts keep going through the existing single-proposal conflict card, never through this tool.',
  'STRICT DISCIPLINE: 仅基于用户显式指令调用本工具；不得自行判断删除。 Never delete anything the user did not explicitly name, never add edits the user did not ask for, and never use this tool to bypass a confirmation gate.',
  'The revised card re-renders on its own polling cycle; report the returned receipt honestly.',
].join(' ');

/** 分发契约覆盖全部既有闸门；六个闸门的 handler 均在本模块注册（票 38）。 */
export const GATE_REVISION_GATE_TYPES = [
  'knowledge',
  'question-pool',
  'topic-plan',
  'article',
  'distribution-plan',
  'publish-preparation',
] as const;

export type GateRevisionGateType = (typeof GATE_REVISION_GATE_TYPES)[number];

export function isGateRevisionGateType(
  value: string,
): value is GateRevisionGateType {
  return (GATE_REVISION_GATE_TYPES as readonly string[]).includes(value);
}

export const GATE_REVISION_MAX_OPERATIONS = 20;
export const GATE_REVISION_MAX_USER_INSTRUCTION_CHARS = 2_000;

/** 工具操作：modify/delete 按条目 id 定位；add 携带目标键与新值。 */
export interface GateRevisionOperation {
  action: 'modify' | 'delete' | 'add';
  /** modify/delete：目标条目标识（知识闸门 = 复核卡候选 id）。 */
  targetId?: string;
  /** add：目标键（知识闸门 = 事实键字段）。 */
  subject?: string;
  predicate?: string;
  scope?: Record<string, string | number | boolean | null>;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** modify/add：新值。 */
  value?: unknown;
  unit?: string;
  /** add：待决复核卡的材料 id；携带时新增行挂回该卡随轮询重渲染。 */
  materialId?: string;
  /** 用户显式指令原文（逐字引用），逐条写审计。 */
  userInstruction: string;
}

export interface GateRevisionOpResult {
  action: 'modify' | 'delete' | 'add';
  targetId?: string;
  candidateId?: string;
  ok: boolean;
  status?: string;
  code?: string;
  error?: string;
}

export interface GateRevisionReceipt {
  kind: 'gate-revision';
  gate: string;
  ok: boolean;
  code?: string;
  error?: string;
  hint?: string;
  results: GateRevisionOpResult[];
}

export interface GateRevisionContext {
  workspaceId: string;
  sessionId: string;
  /**
   * 请求级新鲜账号 token（revise_gate_content 工具从 MCP 会话上下文带入，
   * 与 MCP 组装点共用同一取值）：组合根按其取能力与计费口径，缺省回退启动单例
   * ——长会话（env token 已过期）下的修订路径不再依赖启动单例。
   */
  requestAccountToken?: string;
}

export type GateRevisionHandler = (
  operations: GateRevisionOperation[],
  context: GateRevisionContext,
) => Promise<GateRevisionOpResult[]>;

const gateRevisionHandlers: Partial<
  Record<GateRevisionGateType, GateRevisionHandler>
> = {};

/** 后续闸门的接入点：注册后自动被同一工具契约分发。 */
export function registerGateRevisionHandler(
  gate: GateRevisionGateType,
  handler: GateRevisionHandler,
): void {
  gateRevisionHandlers[gate] = handler;
}

const RECEIPT_FAILURE_HINT =
  '逐条检查回执：非未决内容、跨 Session/品牌的目标会被拒绝；已裁决的权威事实请走既有单条提案/冲突卡通道。';

export function gateRevisionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('no longer pending')) return 'target_not_pending';
  if (message.includes('does not belong to the current brand Session')) {
    return 'target_not_in_session';
  }
  if (message.includes('not found for this Session')) return 'target_not_found';
  // 各域持久层错误码（票 38）：非未决、跨 Session/品牌、目标缺失与 CAS 冲突。
  if (
    message.includes('immutable') ||
    message.includes('not_selectable') ||
    message.includes('already_immutable') ||
    message.includes('discovery_incomplete') ||
    message.includes('not pending')
  ) {
    return 'target_not_pending';
  }
  if (message.includes('identity_mismatch') || message.includes('session_mismatch')) {
    return 'target_not_in_session';
  }
  if (message.includes('revision_conflict')) return 'revision_conflict';
  if (message.includes('not_found')) return 'target_not_found';
  return 'revision_rejected';
}

/**
 * 操作列表的结构校验；返回首个错误消息，合法则返回 null。add 的目标键
 * 按闸门区分：知识闸门维持事实键（subject+predicate）契约，其余闸门把
 * 新条目内容整体放在 value 里（工具 zod 契约不变）。
 */
export function validateGateRevisionOperations(
  operations: GateRevisionOperation[],
  gate?: GateRevisionGateType,
): string | null {
  if (!Array.isArray(operations) || operations.length === 0) {
    return 'gate revision requires at least one operation';
  }
  if (operations.length > GATE_REVISION_MAX_OPERATIONS) {
    return `gate revision accepts at most ${GATE_REVISION_MAX_OPERATIONS} operations per call`;
  }
  for (const [index, operation] of operations.entries()) {
    const label = `operation ${index + 1}`;
    const instruction = operation.userInstruction?.trim() ?? '';
    if (
      !instruction ||
      instruction.length > GATE_REVISION_MAX_USER_INSTRUCTION_CHARS
    ) {
      return `${label} requires the user's verbatim instruction (1-${GATE_REVISION_MAX_USER_INSTRUCTION_CHARS} characters)`;
    }
    if (operation.action === 'modify') {
      if (!operation.targetId?.trim()) return `${label} (modify) requires targetId`;
      if (operation.value === undefined) {
        return `${label} (modify) requires a value`;
      }
    } else if (operation.action === 'delete') {
      if (!operation.targetId?.trim()) return `${label} (delete) requires targetId`;
    } else if (operation.action === 'add') {
      if (gate === undefined || gate === 'knowledge') {
        if (!operation.subject?.trim() || !operation.predicate?.trim()) {
          return `${label} (add) requires a subject and predicate`;
        }
      }
      if (operation.value === undefined) {
        return `${label} (add) requires a value`;
      }
    } else {
      return `${label} has an invalid action`;
    }
  }
  return null;
}

/**
 * 单一分发入口：按闸门类型路由到已注册的域 handler。逐条独立执行，
 * 单条失败不影响其余操作（与 decide-batch 的逐条独立语义一致）。
 */
export async function dispatchGateRevision(
  gate: string,
  operations: GateRevisionOperation[],
  context: GateRevisionContext,
): Promise<GateRevisionReceipt> {
  if (!isGateRevisionGateType(gate)) {
    return {
      kind: 'gate-revision',
      gate,
      ok: false,
      code: 'gate_unknown',
      error: `unknown gate type: ${gate}`,
      hint: `闸门类型必须是 ${GATE_REVISION_GATE_TYPES.join(' / ')} 之一。`,
      results: [],
    };
  }
  const handler = gateRevisionHandlers[gate];
  if (!handler) {
    return {
      kind: 'gate-revision',
      gate,
      ok: false,
      code: 'gate_revision_not_available',
      error: `gate revision is not available for ${gate} yet`,
      hint: '该闸门的修订接入尚未交付；向用户说明当前只能在对应确认卡上操作。',
      results: [],
    };
  }
  const validationError = validateGateRevisionOperations(operations, gate);
  if (validationError) {
    return {
      kind: 'gate-revision',
      gate,
      ok: false,
      code: 'operations_invalid',
      error: validationError,
      results: [],
    };
  }
  const results = await handler(operations, context);
  const ok = results.every((result) => result.ok);
  return {
    kind: 'gate-revision',
    gate,
    ok,
    ...(ok ? {} : { hint: RECEIPT_FAILURE_HINT }),
    results,
  };
}

/** 卡片决策与聊天修订同出一人：指令都来自桌面前的用户本人。 */
const GATE_REVISION_ACTOR_ID = 'desktop-user';

/**
 * 知识闸门参考实现（票 38 接其余闸门时照此形状注册）：KnowledgeAuthority
 * 修订只接受本 Session 的 awaiting-confirmation/conflict 候选；add 走
 * propose 语义（user-stated / knowledge-update / asked）且必须携带待决卡片
 * 的 materialId——不挂卡的新增不构成闸门修订，应走 propose_brand_fact。
 * 每条操作的错误按候选越权类别结构化。
 */
export async function knowledgeGateRevisionHandler(
  operations: GateRevisionOperation[],
  context: GateRevisionContext,
): Promise<GateRevisionOpResult[]> {
  // 惰性创建：结构化拒绝（如 add 缺 materialId）不依赖 Sidecar 身份。
  let authority: ReturnType<typeof createKnowledgeAuthority> | null = null;
  const results: GateRevisionOpResult[] = [];
  for (const operation of operations) {
    const base = {
      action: operation.action,
      ...(operation.targetId ? { targetId: operation.targetId } : {}),
    };
    if (operation.action === 'add' && !operation.materialId?.trim()) {
      results.push({
        ...base,
        ok: false,
        code: 'material_required',
        error:
          'knowledge gate add requires the pending card materialId so the new row joins the card; for facts outside a pending card use propose_brand_fact instead',
      });
      continue;
    }
    const input: KnowledgeRevisionInput =
      operation.action === 'add'
        ? {
            action: 'add',
            key: {
              subject: operation.subject!,
              predicate: operation.predicate!,
              scope: operation.scope,
              effectiveFrom: operation.effectiveFrom,
              effectiveTo: operation.effectiveTo,
            },
            value: operation.value,
            unit: operation.unit,
            materialId: operation.materialId,
            reason: operation.userInstruction,
            actorId: GATE_REVISION_ACTOR_ID,
          }
        : operation.action === 'modify'
          ? {
              action: 'modify',
              candidateId: operation.targetId!,
              value: operation.value,
              unit: operation.unit,
              reason: operation.userInstruction,
              actorId: GATE_REVISION_ACTOR_ID,
            }
          : {
              action: 'delete',
              candidateId: operation.targetId!,
              reason: operation.userInstruction,
              actorId: GATE_REVISION_ACTOR_ID,
            };
    try {
      const outcome = await (authority ??= createKnowledgeAuthority(context)).revise(input);
      results.push({
        ...base,
        candidateId: outcome.candidateId,
        ok: true,
        status: outcome.status,
      });
    } catch (error) {
      results.push({
        ...base,
        ok: false,
        code: gateRevisionErrorCode(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

registerGateRevisionHandler('knowledge', knowledgeGateRevisionHandler);

/** 单条操作的回执基座：带回目标 id，错误按域错误码结构化。 */
function opFailure(
  operation: GateRevisionOperation,
  error: unknown,
): GateRevisionOpResult {
  return {
    action: operation.action,
    ...(operation.targetId ? { targetId: operation.targetId } : {}),
    ok: false,
    code: gateRevisionErrorCode(error),
    error: error instanceof Error ? error.message : String(error),
  };
}

function opUnsupported(
  operation: GateRevisionOperation,
  supported: string,
): GateRevisionOpResult {
  return {
    action: operation.action,
    ...(operation.targetId ? { targetId: operation.targetId } : {}),
    ok: false,
    code: 'action_not_supported',
    error: `this gate supports ${supported} only; refuse the instruction and explain the existing channel instead`,
  };
}

/**
 * 问题池闸门（票 38）：确认卡上的搜索词（subject='keyword'）与候选问题
 * （默认）改/删/增。逐条独立提交，只动本 Session awaiting-selection 池的
 * 待决内容；每条写 geo_question_pool_revisions 审计（含指令原文）。
 */
export function createQuestionPoolGateRevisionHandler(
  resolveService: (
    context: GateRevisionContext,
  ) => Pick<QuestionPoolService, 'revise'>,
): GateRevisionHandler {
  return async (operations, context) => {
    // 惰性解析（与知识 handler 一致）：Sidecar 身份缺失等服务构造错误也按
    // 单条回执结构化，不让整批分发变成裸工具错误。
    let service: Pick<QuestionPoolService, 'revise'> | null = null;
    const resolve = () => (service ??= resolveService(context));
    const results: GateRevisionOpResult[] = [];
    for (const operation of operations) {
      try {
        const outcome = await resolve().revise({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          action: operation.action,
          targetKind: operation.subject === 'keyword' ? 'keyword' : 'question',
          ...(operation.targetId ? { targetId: operation.targetId } : {}),
          ...(operation.value !== undefined ? { value: operation.value } : {}),
          reason: operation.userInstruction,
          actorId: GATE_REVISION_ACTOR_ID,
        });
        results.push({
          action: operation.action,
          ...(operation.targetId ? { targetId: operation.targetId } : {}),
          ok: true,
          status: outcome.pool.status,
        });
      } catch (error) {
        results.push(opFailure(operation, error));
      }
    }
    return results;
  };
}

const TOPIC_PLAN_PATCHABLE_FIELDS = [
  'title',
  'contentType',
  'typeSelectionReason',
  'sourceQuestionIds',
  'plannedFacts',
] as const;

function topicPlanUserItemRationale(instruction: string): TopicPlanItem['titleRationale'] {
  return {
    questionCoverage: '用户在聊天中补充的选题',
    searchIntent: `用户指令：${instruction}`,
    differentiation: '未评估（用户补充）',
    brandFit: '未评估（用户补充）',
    chinaMarketExpression: '未评估（用户补充）',
  };
}

function topicPlanItemId(taken: Set<string>): string {
  let sequence = taken.size + 1;
  let id = `item-user-${sequence}`;
  while (taken.has(id)) {
    sequence += 1;
    id = `item-user-${sequence}`;
  }
  return id;
}

/**
 * 把一条修订操作映射到新的选题条目数组；目标缺失/结构非法抛域错误码，
 * 由回执结构化。add 的 value 携带新条目字段（topicId、sourceQuestionIds、
 * contentType、typeSelectionReason、title、plannedFacts）。
 */
export function applyTopicPlanRevisionOperation(
  plan: TopicPlanProjection,
  operation: GateRevisionOperation,
): TopicPlanItem[] {
  if (operation.action === 'add') {
    const value =
      operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
        ? (operation.value as Record<string, unknown>)
        : {};
    const base = plan.items.map((item) => ({ ...item }));
    base.push({
      id: typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : topicPlanItemId(new Set(base.map((item) => item.id))),
      topicId: String(value.topicId ?? ''),
      sourceQuestionIds: Array.isArray(value.sourceQuestionIds)
        ? value.sourceQuestionIds.filter((id): id is string => typeof id === 'string')
        : [],
      contentType: value.contentType as TopicPlanItem['contentType'],
      typeSelectionReason: String(value.typeSelectionReason ?? ''),
      title: String(value.title ?? ''),
      titleCandidates: [],
      titleRationale: topicPlanUserItemRationale(operation.userInstruction),
      plannedFacts: (Array.isArray(value.plannedFacts)
        ? value.plannedFacts
        : []) as TopicPlanKnowledgeFact[],
      deduplication: {
        method: 'not-evaluated-user-override',
        comparedItemIds: [],
        maxSimilarity: null,
        threshold: 0,
      },
      userEdited: true,
      approvalStatus: 'draft',
      origin: 'user',
    });
    return base;
  }
  const target = plan.items.find((item) => item.id === operation.targetId);
  if (!target) throw new Error('topic_plan_revision_target_not_found');
  if (operation.action === 'delete') {
    const remaining = plan.items.filter((item) => item.id !== operation.targetId);
    if (remaining.length === 0) throw new Error('topic_plan_items_invalid');
    return remaining;
  }
  const patch =
    operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
      ? (operation.value as Record<string, unknown>)
      : {};
  const merged = { ...target } as Record<string, unknown>;
  for (const field of TOPIC_PLAN_PATCHABLE_FIELDS) {
    if (patch[field] !== undefined) merged[field] = patch[field];
  }
  return plan.items.map((item) =>
    item.id === operation.targetId ? (merged as unknown as TopicPlanItem) : item,
  );
}

/**
 * 选题规划闸门（票 38）：待确认选题条目改/删/增，复用 saveItems 的
 * user-edit 语义（origin=user、userEdited、审计含指令原文）。逐条独立
 * 提交；confirmed 计划按非未决拒绝。
 */
export function createTopicPlanGateRevisionHandler(
  resolveService: (
    context: GateRevisionContext,
  ) => Pick<TopicPlanService, 'latest' | 'saveItems'>,
): GateRevisionHandler {
  return async (operations, context) => {
    let service: Pick<TopicPlanService, 'latest' | 'saveItems'> | null = null;
    const resolve = () => (service ??= resolveService(context));
    const results: GateRevisionOpResult[] = [];
    let plan: TopicPlanProjection | null = null;
    let planLoaded = false;
    for (const operation of operations) {
      try {
        if (!planLoaded) {
          plan = await resolve().latest({
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
          });
          planLoaded = true;
        }
        if (!plan) {
          results.push(opFailure(operation, new Error('topic_plan_not_found')));
          continue;
        }
        if (plan.status !== 'awaiting-confirmation') {
          results.push(
            opFailure(operation, new Error('topic_plan_confirmed_immutable')),
          );
          continue;
        }
        const items = applyTopicPlanRevisionOperation(plan, operation);
        const outcome = await resolve().saveItems({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          planId: plan.id,
          expectedRevision: plan.revision,
          items,
          reason: operation.userInstruction,
        });
        plan = outcome.plan;
        results.push({
          action: operation.action,
          ...(operation.targetId ? { targetId: operation.targetId } : {}),
          ok: true,
          status: outcome.plan.status,
        });
      } catch (error) {
        results.push(opFailure(operation, error));
      }
    }
    return results;
  };
}

/**
 * 文章生成闸门（票 38）：仅支持修改待审批（draft_ready）文章的标题与正文，
 * 走既有 edit 语义（新版本行 origin=user-edited、状态回到 draft_ready、
 * 必须重新过审批门）。删除/新增不是本闸门语义——拒绝并指向既有通道。
 */
export function createArticleGateRevisionHandler(
  resolveService: (
    context: GateRevisionContext,
  ) => Pick<ArticleGenerationService, 'latest' | 'edit'>,
): GateRevisionHandler {
  return async (operations, context) => {
    let service: Pick<ArticleGenerationService, 'latest' | 'edit'> | null = null;
    const resolve = () => (service ??= resolveService(context));
    const results: GateRevisionOpResult[] = [];
    for (const operation of operations) {
      if (operation.action !== 'modify') {
        results.push(opUnsupported(operation, 'modify'));
        continue;
      }
      try {
        const articleOperation = await resolve().latest({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        });
        if (!articleOperation) {
          throw new Error('article_generation_operation_not_found');
        }
        const article = articleOperation.articles.find(
          (candidate) => candidate.id === operation.targetId,
        );
        if (!article) {
          throw new Error('article_generation_article_not_found');
        }
        if (article.status !== 'draft_ready') {
          throw new Error('article is no longer pending (awaiting approval)');
        }
        const holder =
          operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
            ? (operation.value as Record<string, unknown>)
            : {};
        if (typeof holder.body !== 'string' || !holder.body.trim()) {
          throw new Error('article revision requires the full new body');
        }
        const body = holder.body;
        const title =
          typeof holder.title === 'string' && holder.title.trim()
            ? holder.title.trim()
            : body.trim().split(/\r?\n/, 1)[0]?.replace(/^#\s*/, '').trim() ?? '';
        const revised = await resolve().edit({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          operationId: articleOperation.id,
          articleId: article.id,
          expectedRevision: article.revision,
          title,
          body,
          reason: operation.userInstruction,
        });
        results.push({
          action: operation.action,
          targetId: operation.targetId,
          ok: true,
          status: revised.status,
        });
      } catch (error) {
        results.push(opFailure(operation, error));
      }
    }
    return results;
  };
}

/**
 * 渠道计划闸门（票 38）：待确认渠道选择与计划参数改/删/增，复用既有
 * edit 语义（白名单字段整组替换、blockingIssues 重算、审计含指令原文）。
 * subject：'channel'（增删=选择/取消选择渠道）、'assignment'（改派）、
 * 缺省 'plan'（预算/发布开始时间）。
 */
export function createDistributionPlanGateRevisionHandler(
  resolveService: (
    context: GateRevisionContext,
  ) => Pick<DistributionPlanningService, 'latest' | 'edit'>,
): GateRevisionHandler {
  return async (operations, context) => {
    let service: Pick<DistributionPlanningService, 'latest' | 'edit'> | null =
      null;
    const resolve = () => (service ??= resolveService(context));
    const results: GateRevisionOpResult[] = [];
    let plan: DistributionPlanProjection | null = null;
    for (const operation of operations) {
      try {
        if (!plan) {
          plan = await resolve().latest({
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
          });
        }
        if (!plan) {
          results.push(
            opFailure(operation, new Error('distribution_plan_not_found')),
          );
          continue;
        }
        if (plan.status === 'confirmed') {
          // 非未决投影不缓存：批内下一条操作重新拉取（可能已有新 draft）。
          plan = null;
          results.push(
            opFailure(operation, new Error('distribution_plan_confirmed_immutable')),
          );
          continue;
        }
        if (plan.status === 'discovering') {
          plan = null;
          results.push(
            opFailure(operation, new Error('distribution_plan_discovery_incomplete')),
          );
          continue;
        }
        const edit = distributionPlanEditForOperation(plan, operation);
        const revised = await resolve().edit({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          planId: plan.id,
          expectedRevision: plan.revision,
          edit,
          reason: operation.userInstruction,
        });
        plan = revised;
        results.push({
          action: operation.action,
          ...(operation.targetId ? { targetId: operation.targetId } : {}),
          ok: true,
          status: revised.status,
        });
      } catch (error) {
        results.push(opFailure(operation, error));
      }
    }
    return results;
  };
}

/** 把单条操作映射为一次整组 edit 载荷；目标缺失/非法抛域错误码。 */
export function distributionPlanEditForOperation(
  plan: DistributionPlanProjection,
  operation: GateRevisionOperation,
): DistributionPlanEditInput {
  const base: DistributionPlanEditInput = {
    selectedResourceIds: [...plan.selectedResourceIds],
    assignments: plan.assignments.map((assignment) => ({ ...assignment })),
    budgetCny: plan.budgetCny,
    publishStartAt: plan.publishStartAt,
  };
  const subject = operation.subject ?? 'plan';
  if (subject === 'channel') {
    const resourceId = Number(operation.targetId);
    if (!Number.isInteger(resourceId) || resourceId <= 0) {
      throw new Error('distribution_plan_revision_target_not_found');
    }
    const known = plan.candidates.some(
      (candidate) => candidate.resourceId === resourceId,
    );
    if (!known) throw new Error('distribution_plan_revision_target_not_found');
    if (operation.action === 'modify') {
      throw new Error('distribution_plan_channel_snapshot_immutable');
    }
    if (operation.action === 'add') {
      if (!base.selectedResourceIds.includes(resourceId)) {
        base.selectedResourceIds.push(resourceId);
      }
      return base;
    }
    if (!base.selectedResourceIds.includes(resourceId)) {
      throw new Error('distribution_plan_revision_target_not_found');
    }
    base.selectedResourceIds = base.selectedResourceIds.filter(
      (id) => id !== resourceId,
    );
    base.assignments = base.assignments.map((assignment) =>
      assignment.resourceId === resourceId
        ? { ...assignment, resourceId: null, reason: 'unassigned' }
        : assignment,
    );
    return base;
  }
  if (subject === 'assignment') {
    if (operation.action !== 'modify') {
      throw new Error('assignment rows always exist; use modify');
    }
    const target = base.assignments.find(
      (assignment) => assignment.articleId === operation.targetId,
    );
    if (!target) throw new Error('distribution_plan_revision_target_not_found');
    const patch =
      operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
        ? (operation.value as Record<string, unknown>)
        : {};
    const next: DistributionAssignment = { ...target };
    if (patch.resourceId !== undefined) {
      const resourceId =
        patch.resourceId === null
          ? null
          : Number(patch.resourceId);
      if (resourceId !== null && !base.selectedResourceIds.includes(resourceId)) {
        throw new Error('distribution_plan_channel_not_selected');
      }
      next.resourceId = resourceId;
    }
    if (typeof patch.reason === 'string' && patch.reason.trim()) {
      const reason = patch.reason.trim();
      if (
        reason !== 'source-evidence' &&
        reason !== 'content-fit' &&
        reason !== 'weighted-score' &&
        reason !== 'unassigned'
      ) {
        throw new Error('distribution_plan_assignment_reason_invalid');
      }
      next.reason = reason;
    }
    if (typeof patch.scheduledAt === 'string' && patch.scheduledAt.trim()) {
      next.scheduledAt = patch.scheduledAt.trim();
    }
    base.assignments = base.assignments.map((assignment) =>
      assignment.articleId === target.articleId ? next : assignment,
    );
    return base;
  }
  if (operation.action !== 'modify') {
    throw new Error('plan-level parameters support modify only');
  }
  const patch =
    operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
      ? (operation.value as Record<string, unknown>)
      : {};
  const budget = patchBudgetCny(patch, 'distribution_plan_budget_invalid');
  if (budget !== undefined) {
    base.budgetCny = budget;
  }
  if (typeof patch.publishStartAt === 'string' && patch.publishStartAt.trim()) {
    base.publishStartAt = patch.publishStartAt.trim();
  }
  return base;
}

/**
 * 聊天修订的预算补丁：转录只携带点数（budgetPoints，优先；点数按
 * pointsToCny 换算回内部 CNY，预算是上限语义、非计费），兼容旧转录里
 * 的 budgetCny。两者都缺失返回 undefined，非法值抛 invalidCode。
 */
function patchBudgetCny(
  patch: Record<string, unknown>,
  invalidCode: string,
): number | undefined {
  if (patch.budgetPoints !== undefined) {
    const points = Number(patch.budgetPoints);
    if (!Number.isFinite(points) || points < 0) throw new Error(invalidCode);
    return pointsToCny(points);
  }
  if (patch.budgetCny !== undefined) {
    const budget = Number(patch.budgetCny);
    if (!Number.isFinite(budget) || budget < 0) throw new Error(invalidCode);
    return budget;
  }
  return undefined;
}

/**
 * 发布准备闸门（票 38）：仅支持修改 awaiting-confirmation 执行的预算、
 * 发布开始时间与逐项排期（subject='item' + targetId=itemId）。修订后
 * Rust 重算确认摘要——旧摘要即刻失效，用户必须对新摘要重新走 UI 授权；
 * 确认/开始/重试仍 exclusively 走 Rust UI 权威入口。
 */
export function createPublishPreparationGateRevisionHandler(
  resolvePort: (
    context: GateRevisionContext,
  ) => Pick<PublishSchedulerPort, 'latest' | 'revise'>,
): GateRevisionHandler {
  return async (operations, context) => {
    let port: Pick<PublishSchedulerPort, 'latest' | 'revise'> | null = null;
    const resolve = () => (port ??= resolvePort(context));
    const results: GateRevisionOpResult[] = [];
    let execution: PublishExecutionProjection | null = null;
    for (const operation of operations) {
      if (operation.action !== 'modify') {
        results.push(opUnsupported(operation, 'modify'));
        continue;
      }
      try {
        if (!execution) {
          execution = await resolve().latest();
        }
        if (!execution) {
          results.push(
            opFailure(operation, new Error('publish_execution_not_found')),
          );
          continue;
        }
        if (execution.status !== 'awaiting-confirmation') {
          // 非未决执行不缓存：批内下一条操作重新拉取（可能有新 preview）。
          execution = null;
          results.push(
            opFailure(operation, new Error('publish_execution_already_immutable')),
          );
          continue;
        }
        const current = execution;
        const patch =
          operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)
            ? (operation.value as Record<string, unknown>)
            : {};
        if (operation.subject === 'item') {
          if (typeof patch.scheduledAt !== 'string' || !patch.scheduledAt.trim()) {
            throw new Error('publish revision requires a scheduledAt');
          }
          execution = await resolve().revise({
            executionId: current.id,
            expectedRevision: current.revision,
            itemUpdates: [
              {
                itemId: operation.targetId ?? '',
                scheduledAt: patch.scheduledAt,
              },
            ],
            actorId: GATE_REVISION_ACTOR_ID,
            reason: operation.userInstruction,
          });
        } else {
          const budget = patchBudgetCny(patch, 'publish_budget_invalid');
          if (budget === undefined && patch.publishStartAt === undefined) {
            throw new Error('publish revision requires budgetPoints or publishStartAt');
          }
          execution = await resolve().revise({
            executionId: current.id,
            expectedRevision: current.revision,
            ...(budget !== undefined
              ? { budgetCny: budget }
              : {}),
            ...(typeof patch.publishStartAt === 'string'
              ? { publishStartAt: patch.publishStartAt }
              : {}),
            actorId: GATE_REVISION_ACTOR_ID,
            reason: operation.userInstruction,
          });
        }
        results.push({
          action: operation.action,
          ...(operation.targetId ? { targetId: operation.targetId } : {}),
          ok: true,
          status: execution.status,
        });
      } catch (error) {
        results.push(opFailure(operation, error));
      }
    }
    return results;
  };
}

/**
 * 默认注册（票 38）：五个域 handler 全部挂接同一工具契约；服务实例向
 * service-composition 组合根按闸门修订口径取用——显式携带
 * `billing: 'revision-unbilled'`（修订是对已付费产物的修正迭代，不计费
 * 是领域裁决而非遗漏；要变更必须走独立裁决，不得夹带在重构里）与
 * `accountToken: context.requestAccountToken`（票 B：请求级新鲜 token，
 * 由 revise_gate_content 唯一入口从 MCP 会话上下文带入）。修订路径只调
 * 持久化面方法，不触发任何 provider 调用。新增闸门仍只需
 * registerGateRevisionHandler，不得另起修改入口。
 */
function revisionGeoServices(context: GateRevisionContext) {
  return geoServices(context, {
    accountToken: context.requestAccountToken,
    billing: 'revision-unbilled',
  });
}

registerGateRevisionHandler(
  'question-pool',
  createQuestionPoolGateRevisionHandler((context) =>
    revisionGeoServices(context).questionPool,
  ),
);

registerGateRevisionHandler(
  'topic-plan',
  createTopicPlanGateRevisionHandler((context) =>
    revisionGeoServices(context).topicPlan,
  ),
);

registerGateRevisionHandler(
  'article',
  createArticleGateRevisionHandler((context) =>
    revisionGeoServices(context).article,
  ),
);

registerGateRevisionHandler(
  'distribution-plan',
  createDistributionPlanGateRevisionHandler((context) =>
    revisionGeoServices(context).distribution,
  ),
);

registerGateRevisionHandler(
  'publish-preparation',
  createPublishPreparationGateRevisionHandler((context) =>
    revisionGeoServices(context).publishPreview,
  ),
);
