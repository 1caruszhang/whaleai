import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

import {
  configureXiaojingGeoProviderAdmission,
  getXiaojingGeoBillingPermitChannelForRequest,
  getXiaojingGeoProviderCapabilities,
  getXiaojingGeoProviderCapabilitiesForRequest,
} from '../geo/provider-runtime';
import {
  createKnowledgeAuthority,
  KNOWLEDGE_EXCERPT_MAX_LENGTH,
  type FactKeyInput,
  type KnowledgeProposalInput,
} from '../geo/knowledge-authority';
import { createBrandMaterialPort, MaterialImportService, materialLogProjection, type MaterialProcessResult } from '../geo/material-import';
import {
  createQuestionPoolPort,
  QuestionPoolService,
} from '../geo/question-pool';
import { createTopicPlanPort, TopicPlanService } from '../geo/topic-plan';
import { toTopicPlanCardProjection, TOPIC_PLAN_REUSE_OUTCOME } from '../../shared/geo/topicPlan';
import type { TopicPlanProjection } from '../../shared/geo/topicPlan';
import {
  createArticlePort,
  ArticleGenerationService,
} from '../geo/article-generation';
import {
  createDistributionPlanPort,
  DistributionPlanningService,
} from '../geo/distribution-plan';
import {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  type DistributionPlanCardProjection,
  type DistributionPlanProjection,
} from '../../shared/geo/distributionPlan';
import { createPublishSchedulerPort } from '../geo/publish-scheduler';
import type {
  PublishExecutionCardProjection,
  PublishExecutionProjection,
} from '../../shared/geo/publishScheduler';
import { createGeoBaselinePort } from '../geo/baseline';
import { createGeoDashboardPort } from '../geo/dashboard';
import {
  GEO_PROBE_SAMPLE_LIMIT_MAX,
  GeoProbeSamplesService,
  type GeoProbeSamplesReport,
} from '../geo/probe-samples';
import {
  ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
  filterValidRankingCompetitors,
  type ArticleOperationProjection,
  type ArticleOperationSource,
} from '../../shared/geo/articleGeneration';
import {
  QUESTION_POOL_REUSE_CONTRACT,
  QUESTION_POOL_REUSE_OUTCOME,
  type QuestionPoolProjection,
} from '../../shared/geo/questionPool';
import { cnyToPoints, pointsToCny } from '../../shared/geo/points';
import { GEO_PORT_CONTRACT } from '../../shared/geo/portContract';
import type { GeoContentType } from '../../shared/geo/portContract';
import { recordGeoOperationMilestone, reportGeoOperationStepProgress } from '../geo/operation-progress';
import { currentGeoOperationStep, TERMINAL_OPERATION } from '../geo/operation-progress';
import {
  createGeoOperationService,
  type GeoOperationCreateInput,
} from '../geo/operation';
import { stageToolOrderRejection, type GeoStageOrderRejection } from '../geo/stage-order-gate';
import { buildKnowledgeCandidatesCardData } from '../../shared/geo/knowledgeCard';
import {
  buildMaterialRequestCardData,
  MATERIAL_COLLECTION_CONTRACT,
  type MaterialRequestSkipTarget,
} from '../../shared/geo/materialRequestCard';
import {
  dispatchGateRevision,
  GATE_REVISION_GATE_TYPES,
  GATE_REVISION_MAX_OPERATIONS,
  GATE_REVISION_MAX_USER_INSTRUCTION_CHARS,
  GATE_REVISION_TOOL_DESCRIPTION,
  GATE_REVISION_TOOL_NAME,
  type GateRevisionOperation,
  type GateRevisionReceipt,
} from '../geo/gate-revision';
import { managementApi } from '../utils/management-api-client';
import { loadSessionTranscript } from '../SessionStore';
import {
  isSessionFileReference,
  isSessionFileTextReadable,
  SESSION_FILE_READ_HEAD_CHARS,
  SESSION_FILE_READ_MAX_OFFSET_CHARS,
} from '../../shared/sessionFileReference';
import {
  GEO_OPERATION_KINDS,
  GEO_OPERATION_PHASE_ID_ORDER,
  GEO_OPERATION_PHASES,
  GEO_OPERATION_REFERENCE_KINDS,
  type GeoOperationReference,
  type GeoOperationUnfinishedSummary,
} from '../../shared/geo/operation';

interface XiaojingGeoContext {
  workspace?: string;
  sessionId: string;
  /** 本轮聊天请求携带的新鲜账号 token（Rust 代理附头，临期已在 Rust 侧
   * refresh）：GEO 工具调网关优先于 admission env token；未携带回退 env。 */
  requestAccountToken?: string;
}

let context: XiaojingGeoContext = { sessionId: 'default' };

/**
 * 会话内已升级为品牌材料的附件名（按 import_pasted_material 的 displayName
 * 记录）。仅当前 Sidecar 生命周期内有效：用于附件提醒的"已导入"标注，
 * 让模型查询品牌知识而不是回读文件（ADR-0001）。
 */
const importedMaterialNames = new Set<string>();

export function markSessionFileImported(name: string): void {
  const trimmed = name.trim();
  if (trimmed) importedMaterialNames.add(trimmed);
}

export function isSessionFileImported(name: string): boolean {
  return importedMaterialNames.has(name.trim());
}

export function configureXiaojingGeo(
  _env: Record<string, string>,
  next: XiaojingGeoContext,
): void {
  context = {
    sessionId: next.sessionId,
    ...(next.workspace ? { workspace: resolve(next.workspace) } : {}),
    ...(next.requestAccountToken?.trim()
      ? { requestAccountToken: next.requestAccountToken.trim() }
      : {}),
  };
  configureXiaojingGeoProviderAdmission({
    workspacePath: next.workspace,
    sessionId: next.sessionId,
  });
}

/**
 * 会话身份快照：brandWorkspaceId + sessionId。静态能力清单不再随调用返回
 * （常量数据对模型是重复噪声，逐次占据上下文）——能力边界的说明收敛到
 * system prompt 一次说清；本函数只保留随会话变化的标识字段。
 */
export function xiaojingGeoContextSnapshot(): {
  brandWorkspaceId: string | null;
  sessionId: string;
} {
  return {
    brandWorkspaceId: context.workspace ? basename(context.workspace) : null,
    sessionId: context.sessionId,
  };
}

type BrandWorkspaceStageState =
  | { present: false }
  | { present: true; state: Record<string, unknown> };

const STAGE_ABSENT: BrandWorkspaceStageState = { present: false };

function stageStateFrom<T>(
  outcome: PromiseSettledResult<T | null>,
  project: (value: T) => Record<string, unknown>,
): BrandWorkspaceStageState {
  if (outcome.status !== 'fulfilled' || outcome.value === null) {
    return STAGE_ABSENT;
  }
  return { present: true, state: project(outcome.value) };
}

export interface BrandWorkspaceStateSummary {
  kind: 'brand-workspace-state';
  /** 品牌材料上下文读取失败时为 null（未知），不是空品牌。 */
  brandName: string | null;
  productLines: string[];
  /** brand scope 的已确认排行榜竞品（enterprise-profile.competitors）。
   * null = 知识读取失败（未知，不得按不足处理）；[] = 确认过、一家都没有。 */
  confirmedCompetitors: string[] | null;
  questionPool: BrandWorkspaceStageState;
  topicPlan: BrandWorkspaceStageState;
  articles: BrandWorkspaceStageState;
  distributionPlan: BrandWorkspaceStageState;
  publish: BrandWorkspaceStageState;
  /** 跨会话未完成轮次的元信息（ADR-0010 Decision 3，只读 tracer）：
   * state = { operations: BrandWorkspaceUnfinishedOperationEntry[] }；
   * 读取失败降级为 absent。不含草稿正文与任何会话聊天记录。 */
  unfinishedOperations: BrandWorkspaceStageState;
}

/** 摘要中一条未完成轮目的元信息条目（六要素 + 展示阶段）。 */
export interface BrandWorkspaceUnfinishedOperationEntry {
  operationId: string;
  sessionId: string;
  kind: string;
  goal: string;
  status: string;
  stuckStep: {
    id: string;
    title: string;
    capability: string;
    status: string;
    /** 展示阶段（shared policy 六阶段词汇）；未知 capability 时为 null。 */
    phase: { id: string; title: string } | null;
  } | null;
  pendingConfirmation: { kind: string; title: string } | null;
  pendingReviewCount: number;
  createdAt: string;
  updatedAt: string;
  /** 该轮是否更新品牌知识（票 #04）：false = 复用轮（不更新知识，从
   * 问题池选择开始）——起点推导描述该轮时如实按复用轮呈现；true =
   * 更新轮；null = 未决/不适用/存量旧轮，不臆断。 */
  updateKnowledge: boolean | null;
}

/** 卡住步骤的展示阶段：capability → 六阶段（与聊天进度卡/工作台同一词汇）。 */
function unfinishedOperationPhase(
  capability: string,
): { id: string; title: string } | null {
  const phase = GEO_OPERATION_PHASES.find((candidate) =>
    candidate.capabilities.some((item) => item === capability),
  );
  return phase ? { id: phase.id, title: phase.title } : null;
}

/**
 * Rust 未完成元信息 → 摘要条目：只做词汇映射（补展示阶段、瘦确认门），
 * 不添加任何正文性字段——跨会话正文隔离不因摘要破口。
 */
function brandWorkspaceUnfinishedOperationEntry(
  summary: GeoOperationUnfinishedSummary,
): BrandWorkspaceUnfinishedOperationEntry {
  return {
    operationId: summary.id,
    sessionId: summary.sessionId,
    kind: summary.kind,
    goal: summary.goal,
    status: summary.status,
    stuckStep: summary.stuckStep
      ? {
          id: summary.stuckStep.id,
          title: summary.stuckStep.title,
          capability: summary.stuckStep.capability,
          status: summary.stuckStep.status,
          phase: unfinishedOperationPhase(summary.stuckStep.capability),
        }
      : null,
    pendingConfirmation: summary.pendingConfirmation
      ? {
          kind: summary.pendingConfirmation.kind,
          title: summary.pendingConfirmation.title,
        }
      : null,
    pendingReviewCount: summary.pendingReviewCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    updateKnowledge: summary.updateKnowledge ?? null,
  };
}

/**
 * 跨 Session 只读的品牌工作台状态摘要：BrandWorkspace 是权威 owner，各阶段
 * 产物经 Rust `latest` 端点读取，与右侧工作台投影同源。Agent 在新 Session
 * 里先读这里再决定是否向用户要信息；单阶段读取失败只降级为 absent，
 * 不阻断整体摘要（只读路径，无副作用可安全重试）。
 */
export async function brandWorkspaceStateSummary(): Promise<BrandWorkspaceStateSummary | null> {
  if (!context.workspace) return null;
  const identity = stageIdentity();
  // Port 构造可能同步 throw（如缺 Sidecar 身份）；先包成 rejected promise，
  // 让 allSettled 按阶段降级而不是整体失败。
  const safe = <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return run();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const [brandContext, pools, plans, articleOperations, distributions, publishes, unfinished] =
    await Promise.allSettled([
      safe(() => brandMaterialPort().context()),
      safe(() => createQuestionPoolPort(identity).latest()),
      safe(() => createTopicPlanPort(identity).latest('confirmed')),
      safe(() => createArticlePort(identity).latest()),
      safe(() => createDistributionPlanPort(identity).latest()),
      safe(() => createPublishSchedulerPort(identity).latest()),
      safe(() => geoOperationService().listUnfinished()),
    ]);
  const contextResult =
    brandContext.status === 'fulfilled' ? brandContext.value : null;
  let confirmedCompetitors: string[] | null = null;
  if (contextResult) {
    try {
      const current = await knowledgeAuthority().inspect({
        subject: contextResult.brandName,
        predicate: 'enterprise-profile.competitors',
        scope: { entityScope: 'brand' },
      });
      confirmedCompetitors = parsedStringList(current?.normalizedValueJson);
    } catch {
      // 知识读取失败保持 null（未知）：不得与「确认过但为空」混淆，
      // 否则瞬时故障会被 prompt 规则当成不足而重新向用户征集。
    }
  }
  return {
    kind: 'brand-workspace-state',
    brandName: contextResult?.brandName ?? null,
    productLines: contextResult?.productLines ?? [],
    confirmedCompetitors,
    questionPool: stageStateFrom(pools, (pool) => ({
      id: pool.id,
      revision: pool.revision,
      status: pool.status,
      productLine: pool.productLine,
      targetRegion: pool.targetRegion,
      questionCount: pool.questions.length,
      updatedAt: pool.updatedAt,
    })),
    topicPlan: stageStateFrom(plans, (plan) => ({
      id: plan.id,
      revision: plan.revision,
      status: plan.status,
      productLine: plan.productLine,
      topicCount: plan.topics.length,
      updatedAt: plan.updatedAt,
    })),
    articles: stageStateFrom(articleOperations, (operation) => ({
      operationId: operation.id,
      status: operation.status,
      articleCount: operation.articles.length,
      approvedCount: operation.articles.filter((article) => article.approvedVersion).length,
      updatedAt: operation.updatedAt,
    })),
    distributionPlan: stageStateFrom(distributions, (plan) => ({
      status: plan.status,
      industry: plan.industry,
      updatedAt: plan.updatedAt,
    })),
    publish: stageStateFrom(publishes, (execution) => ({
      status: execution.status,
      publishStartAt: execution.publishStartAt,
      updatedAt: execution.updatedAt,
    })),
    unfinishedOperations: stageStateFrom(unfinished, ({ operations, total }) => ({
      operations: operations.map(brandWorkspaceUnfinishedOperationEntry),
      // 上界换算：total 是品牌内非终态轮次全量数，列表只带最新 5 条；
      // truncatedCount > 0 时按最新优先继续推进，不把未列出的当作不存在。
      total,
      truncatedCount: Math.max(0, total - operations.length),
    })),
  };
}

/**
 * 同会话未变化重读的瘦身信封（上下文经济）：inspect_brand_context 的全量
 * 返回会留在对话历史里被后续每轮重复计费；持久状态没变时，第二次及以后
 * 的读取只回一个「未变化」标记，模型复用先前的全量结果。状态一变（本
 * 会话写入、接管或另一会话的更新都会改 updatedAt 等字段）序列化即不一致，
 * 自动回到全量返回——新鲜度由逐字节比较保证，不靠失效钩子。
 */
let lastBrandContextRead: { sessionId: string; serialized: string } | null = null;

const BRAND_CONTEXT_UNCHANGED_ENVELOPE_NOTE =
  'The persisted brand workspace state is identical to your previous full read in this session. Reuse that earlier inspect_brand_context result; nothing changed that could re-open a question to the user.';

function geoOperationService() {
  if (!context.workspace)
    throw new Error('GeoOperation requires an explicit workspace identity');
  return createGeoOperationService({
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
  });
}

export async function startGeoOperation(input: GeoOperationCreateInput) {
  return geoOperationService().create(input);
}

export async function inspectGeoOperations(input: {
  operationId?: string;
  limit?: number;
}) {
  const service = geoOperationService();
  return input.operationId
    ? service.get(input.operationId)
    : service.list({
        includeAllSessions: false,
        limit: input.limit,
      });
}

const EMPTY_OPERATION_LIST_HINT =
  "No GeoOperations recorded for this session yet. Confirm the user's explicit intent first, then create one with start_geo_operation.";

/**
 * inspect_geo_operations 的工具负载：空列表是合法的权威结果，但裸 `[]`
 * 会让模型无话可说——附上建模提示，引导它向用户解释并走创建路径。
 */
export function geoOperationProjectionPayload(
  result: Awaited<ReturnType<typeof inspectGeoOperations>>,
): {
  kind: "geo-operation-projection";
  result: unknown;
  hint?: string;
} {
  return Array.isArray(result) && result.length === 0
    ? { kind: "geo-operation-projection", result, hint: EMPTY_OPERATION_LIST_HINT }
    : { kind: "geo-operation-projection", result };
}

/**
 * control_geo_operation 的失败投影：裸 throw 只会变成 SDK 的 isError 单行
 * 文本，模型拿不到恢复路径。与材料失败的 ok:false 结果同构；合法动作列表
 * 由 Rust 状态机错误文本携带（geo_operations.rs），这里只补中文恢复指引，
 * 不在 Node 侧复制状态表。
 */
export function geoOperationControlFailure(error: unknown): {
  kind: "geo-operation-control";
  ok: false;
  error: string;
  hint: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const hint = message.includes("geo_operation_session_mismatch:taken_over_by")
    ? "本会话已不再拥有该操作：它已被另一个会话接管（错误中 taken_over_by 标明接管会话）。请如实告诉用户，并停止对该操作的一切控制。"
    : message.includes("geo_operation_transition_invalid")
    ? "当前操作状态不允许该动作；错误信息中列出了此状态下合法的控制动作。改用其中的动作并携带 inspect_geo_operations 返回的最新 revision，或先查看操作状态。"
    : message.includes("geo_operation_already_terminal")
      ? "操作已处于终态（succeeded/failed/cancelled），不能再控制。如需继续同一目标，请用 start_geo_operation 创建新操作。"
      : message.includes("geo_operation_error_not_retryable")
        ? "只有标记为可重试的失败才能 retry。请改用 start_geo_operation 创建新操作，或与用户确认下一步。"
        : message.includes("revision_conflict")
          ? "expectedRevision 已过期：操作已被其他步骤推进。先调用 inspect_geo_operations 获取最新 revision 再重试。"
          : "控制请求被拒绝。先调用 inspect_geo_operations 查看最新状态与 revision，再选择合法动作。";
  return { kind: "geo-operation-control", ok: false, error: message, hint };
}

export async function controlGeoOperation(input: {
  operationId: string;
  expectedRevision: number;
  action: 'pause' | 'resume' | 'retry' | 'cancel';
}) {
  return geoOperationService().control(input);
}

/** 接管一个未完成轮次（ADR-0010）：CAS 所有权转移到当前 Session。 */
export async function takeoverGeoOperation(input: {
  operationId: string;
  expectedRevision: number;
}) {
  return geoOperationService().takeover(input);
}

/**
 * takeover_geo_operation 的失败投影（与 geoOperationControlFailure 同构）：
 * 运行中守卫、终态、已被抢（CAS 单赢家）、已是所有者、revision 过期各自
 * 映射为可转述的中文恢复指引——裸 throw 的 isError 单行文本无法转述。
 */
export function geoOperationTakeoverFailure(error: unknown): {
  kind: "geo-operation-takeover";
  ok: false;
  error: string;
  hint: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const hint = message.includes("geo_operation_takeover_running")
    ? "该轮次正在原会话中执行，不能接管。请如实告诉用户：等原会话的这轮工作暂停或结束（关闭原窗口会自动暂停）后，再重新读取品牌状态并接管。"
    : message.includes("geo_operation_takeover_conflict")
      ? "该轮次已被另一个会话抢先接管（错误中 taken_over_by 标明接管会话）。请如实告诉用户接管未成功，并用 inspect_geo_operations 查看本会话自己的操作。"
      : message.includes("geo_operation_takeover_already_owner")
        ? "本会话已经是该轮次的所有者，无需再接管。直接用 inspect_geo_operations 查看进度，从中断的那一步继续。"
        : message.includes("geo_operation_takeover_terminal")
          ? "该轮次已结束（succeeded/failed/cancelled），没有可接管的工作。如需继续同一目标，请与用户确认后用 start_geo_operation 创建新操作。"
          : message.includes("revision_conflict")
            ? "expectedRevision 已过期：操作状态已被推进（或已被其他会话接管）。先调用 inspect_geo_operations 获取最新状态与 revision，再重试接管。"
            : "接管请求被拒绝。先调用 inspect_geo_operations 查看该轮次的最新状态，再决定重试或放弃。";
  return { kind: "geo-operation-takeover", ok: false, error: message, hint };
}

export async function chooseNextRoundKnowledge(input: {
  operationId: string;
  expectedRevision: number;
  updateKnowledge: boolean;
}) {
  return geoOperationService().chooseNextRoundKnowledge(input);
}

/**
 * 跳过出口的服务入口（票 07）：与知识分支决策同一 service seam，计划
 * 替换动作 + revision CAS 由 GeoOperationService 裁决。
 */
export async function skipMaterialCollection(input: {
  operationId: string;
  expectedRevision: number;
}) {
  return geoOperationService().skipMaterialCollection(input);
}

/**
 * 材料请求卡的跳过出口锚点（票 07）：卡片发出时查本会话非终态操作中
 * 当前停在 collect-materials 的最新一个（列表按 updated_at 倒序），把
 * operationId + revision 嵌进卡数据——跳过动作据此发起 CAS 计划替换。
 * 查不到或读取失败返回 null：计划外补材料入口照常出卡，只是不呈现
 * 跳过动作，卡片上传路径不受影响。
 */
async function resolveMaterialSkipTarget(): Promise<MaterialRequestSkipTarget | null> {
  if (!context.workspace) return null;
  try {
    const operations = await geoOperationService().list();
    const parked = operations.find((operation) =>
      !TERMINAL_OPERATION.has(operation.status)
      && currentGeoOperationStep(operation.steps)?.id === 'collect-materials');
    return parked
      ? { operationId: parked.id, expectedRevision: parked.revision }
      : null;
  } catch {
    // 卡片必须始终能发出：锚点解析失败降级为无跳过动作的普通卡。
    return null;
  }
}

/**
 * 顺序闸拒绝的工具结果（票 #05）：结构化指路信封直接作为工具内容返回——
 * 当前步 + 应调工具 + 一句话指引，模型一次读明白、一次重试到位，不 throw
 * 成 isError 单行文本。闸只覆盖五个有后果的阶段工具（GEO_STAGE_ORDER_
 * GATED_TOOLS）；只读查询与材料类工具不经此路径。
 */
function stageOrderGateResult(rejection: GeoStageOrderRejection) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(rejection) }],
  };
}

function knowledgeAuthority() {
  if (!context.workspace) throw new Error('Brand knowledge requires an explicit workspace identity');
  return createKnowledgeAuthority({
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
  });
}

function materialIdentity(): { workspaceId: string; sessionId: string } {
  if (!context.workspace) throw new Error('Brand materials require an explicit workspace identity');
  return { workspaceId: basename(context.workspace), sessionId: context.sessionId };
}

function materialImportService(): MaterialImportService {
  const identity = materialIdentity();
  const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(context.requestAccountToken);
  return new MaterialImportService(
    identity,
    createBrandMaterialPort(identity),
    capabilities.extraction,
    createKnowledgeAuthority(identity),
    {},
    capabilities.keywordSearch,
    undefined,
    getXiaojingGeoBillingPermitChannelForRequest(context.requestAccountToken),
  );
}

function brandMaterialPort() {
  return createBrandMaterialPort(materialIdentity());
}

// 题库/主题服务与 index.ts 的 HTTP 路由共用同一构造；这里按 Session 缓存实例，
// 保证 agent 工具与面板/卡片走完全相同的领域语义与复用规则。缓存键携带本轮
// 请求级 token 的截断指纹：轮换（refresh）后必须重建服务，不能让旧 token 留在
// 已缓存的能力闭包里；token 稳定时实例照常复用。原始 token 不进常驻缓存键
// （生命周期长于请求），只留 SHA-256 前 16 hex。
function stageIdentity(): { workspaceId: string; sessionId: string } {
  if (!context.workspace) throw new Error('This stage requires an explicit workspace identity');
  return { workspaceId: basename(context.workspace), sessionId: context.sessionId };
}

/**
 * 请求级 token 的缓存键指纹：SHA-256 前 16 hex。原始 token 不进常驻缓存键
 * （生命周期长于请求）；指纹只用于区分轮换前后的 token，碰撞即同 key 复用
 * 同实例，语义与原「token 原文入 key」一致。
 */
export function accountTokenCacheFingerprint(token: string | undefined): string {
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function stageRuntimeKey(identity: { workspaceId: string; sessionId: string }): string {
  return `${identity.workspaceId}:${identity.sessionId}:${accountTokenCacheFingerprint(context.requestAccountToken)}`;
}

let questionPoolRuntime: { key: string; service: QuestionPoolService } | null = null;
function questionPoolService(): QuestionPoolService {
  const identity = stageIdentity();
  const key = stageRuntimeKey(identity);
  if (questionPoolRuntime?.key === key) return questionPoolRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(context.requestAccountToken);
  const service = new QuestionPoolService(
    identity,
    createQuestionPoolPort(identity),
    capabilities.keywordSearch,
    capabilities.generation,
    capabilities.embedding,
    getXiaojingGeoBillingPermitChannelForRequest(context.requestAccountToken),
  );
  questionPoolRuntime = { key, service };
  return service;
}

let topicPlanRuntime: { key: string; service: TopicPlanService } | null = null;
function topicPlanService(): TopicPlanService {
  const identity = stageIdentity();
  const key = stageRuntimeKey(identity);
  if (topicPlanRuntime?.key === key) return topicPlanRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(context.requestAccountToken);
  const service = new TopicPlanService(
    identity,
    createTopicPlanPort(identity),
    capabilities.generation,
    capabilities.embedding,
    undefined,
    getXiaojingGeoBillingPermitChannelForRequest(context.requestAccountToken),
  );
  topicPlanRuntime = { key, service };
  return service;
}

let articleRuntime: { key: string; service: ArticleGenerationService } | null = null;
function articleService(): ArticleGenerationService {
  const identity = stageIdentity();
  const key = stageRuntimeKey(identity);
  if (articleRuntime?.key === key) return articleRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(context.requestAccountToken);
  const service = new ArticleGenerationService(
    identity,
    createArticlePort(identity),
    capabilities.generation,
    capabilities.reflection,
    getXiaojingGeoBillingPermitChannelForRequest(context.requestAccountToken),
    // 配图候选池（ADR-0008 T4）：与 xiaojing-shared 的 HTTP 路由同一取数。
    // 2026-08-31 线上事故：本构造点漏传池，Agent 经 MCP 的批量生成与
    // 重生成全部静默零配图（HTTP 重试路径有池、有图——两路径行为分裂）。
    async () =>
      createBrandMaterialPort(identity).listImageAssets({
        limit: ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
      }),
  );
  articleRuntime = { key, service };
  return service;
}

let distributionRuntime: { key: string; service: DistributionPlanningService } | null = null;
function distributionService(): DistributionPlanningService {
  const identity = stageIdentity();
  const key = stageRuntimeKey(identity);
  if (distributionRuntime?.key === key) return distributionRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(context.requestAccountToken);
  const service = new DistributionPlanningService(
    identity,
    createDistributionPlanPort(identity),
    capabilities.distribution,
    capabilities.keywordSearch,
    undefined,
    getXiaojingGeoBillingPermitChannelForRequest(context.requestAccountToken),
  );
  distributionRuntime = { key, service };
  return service;
}

let publishPreviewRuntime: { key: string; port: ReturnType<typeof createPublishSchedulerPort> } | null = null;
function publishPreviewPort(): ReturnType<typeof createPublishSchedulerPort> {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (publishPreviewRuntime?.key === key) return publishPreviewRuntime.port;
  const port = createPublishSchedulerPort(identity);
  publishPreviewRuntime = { key, port };
  return port;
}

/** 导入产出候选后推进 GeoOperation 的材料/抽取步骤；best-effort，不阻断工具结果。 */
async function recordMaterialImportedMilestone(result: MaterialProcessResult): Promise<void> {
  if (!result.ok || result.candidateIds.length === 0 || !context.workspace) return;
  await recordGeoOperationMilestone(
    { workspaceId: basename(context.workspace), sessionId: context.sessionId },
    'materials-imported',
  );
}

/**
 * Agent 工具路径与 HTTP 路由共用同一份 [materials] 脱敏投影：没有它，
 * 工具发起的导入失败在 sidecar 日志中没有任何时间线（只存在于 SQLite）。
 */
function logMaterialTool(
  operation: 'import-text' | 'fetch-website' | 'retry' | 'delete',
  status: 'started' | 'completed' | 'failed',
  payload: { materialId?: string; errorCode?: string } = {},
): void {
  if (!context.workspace) return;
  console.log(`[materials] ${JSON.stringify(materialLogProjection({
    operation,
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
    materialId: payload.materialId,
    status,
    ...(status === 'failed' && payload.errorCode ? { error: new Error(payload.errorCode) } : {}),
  }))}`);
}

function materialResultLogInfo(result: MaterialProcessResult): { materialId?: string; errorCode?: string } {
  return result.ok
    ? { materialId: result.material.id }
    : { materialId: result.materialId, errorCode: result.errorCode };
}

/**
 * 成功的材料导入渲染为批量知识确认卡（用户在聊天卡片内裁决），
 * 失败结果保持原样供模型诊断。ADR-0001 裁决门的唯一会话内呈现形态。
 */
function materialCandidatesToolText(result: MaterialProcessResult): string {
  if (result.ok) {
    const card = buildKnowledgeCandidatesCardData(
      { id: result.material.id, displayName: result.material.displayName },
      result.candidates ?? [],
    );
    if (card) return JSON.stringify(card);
  }
  return JSON.stringify(result);
}

export async function proposeBrandFact(input: KnowledgeProposalInput) {
  const candidate = await knowledgeAuthority().propose(input);
  return {
    kind: 'knowledge-conflict-card',
    candidate,
    requiresUserDecision: true,
  };
}

export interface RankingCompetitorConfirmationChallenge {
  subject: string;
  source: ArticleOperationSource;
  issuedAfterUserMessageId: string;
}

export interface AuthorizedRankingCompetitorConfirmation
  extends RankingCompetitorConfirmationChallenge {
  userInstruction: string;
}

function normalizedConfirmationText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

/** Session-owned、Sidecar 生命周期内的一次排行榜竞品补充门。 */
export class RankingCompetitorConfirmationGate {
  private pending: RankingCompetitorConfirmationChallenge | null = null;

  issue(challenge: RankingCompetitorConfirmationChallenge): void {
    if (
      this.pending &&
      normalizedConfirmationText(this.pending.subject) ===
        normalizedConfirmationText(challenge.subject) &&
      JSON.stringify(this.pending.source) === JSON.stringify(challenge.source)
    ) {
      return;
    }
    this.pending = structuredClone(challenge);
  }

  /**
   * 部分采纳后把围栏推进到刚消费的用户消息：同一条消息不得再授权下一轮
   * 采纳（否则消息里顺带提到的名字都能被后续调用逐个直采纳）。不能走
   * issue()——同主体去重会把它变成空操作（生成重试正是靠该去重不移动围栏）。
   */
  advanceFence(userMessageId: string): void {
    if (this.pending) this.pending.issuedAfterUserMessageId = userMessageId;
  }

  clear(): void {
    this.pending = null;
  }

  authorize(
    input: { names: string[] },
    latestUserMessage: { id: string; content: string } | null,
  ): AuthorizedRankingCompetitorConfirmation {
    const pending = this.pending;
    if (!pending) throw new Error("ranking_competitor_confirmation_not_requested");
    if (
      !latestUserMessage ||
      latestUserMessage.id === pending.issuedAfterUserMessageId
    ) {
      throw new Error("ranking_competitor_confirmation_user_reply_required");
    }
    const latestInstruction = normalizedConfirmationText(
      latestUserMessage.content,
    );
    if (!latestInstruction) {
      throw new Error("ranking_competitor_confirmation_user_reply_required");
    }
    const missingFromUserMessage = input.names.filter(
      (name) =>
        !latestInstruction.includes(normalizedConfirmationText(name)),
    );
    if (missingFromUserMessage.length > 0) {
      throw new Error(
        `ranking_competitor_confirmation_name_not_user_stated:${missingFromUserMessage.join("、")}`,
      );
    }
    return {
      ...structuredClone(pending),
      userInstruction: latestUserMessage.content,
    };
  }
}

const rankingCompetitorGatesBySession = new Map<
  string,
  RankingCompetitorConfirmationGate
>();

/**
 * `createXiaojingGeoServer()` 每个 Agent turn 都会重建 MCP server；竞品不足门
 * 必须由 Session Sidecar 持有，不能绑在单轮 server factory 闭包里。按
 * Session : Sidecar = 1 : 1，一个 sidecar 进程生命周期内最多只有一个 session
 * 键，Map 不需要淘汰机制。
 */
export function sessionRankingCompetitorGate(
  sessionId: string,
): RankingCompetitorConfirmationGate {
  const key = sessionId.trim();
  if (!key) throw new Error("ranking_competitor_confirmation_session_required");
  const existing = rankingCompetitorGatesBySession.get(key);
  if (existing) return existing;
  const gate = new RankingCompetitorConfirmationGate();
  rankingCompetitorGatesBySession.set(key, gate);
  return gate;
}

type RankingCompetitorAuthority = Pick<
  ReturnType<typeof createKnowledgeAuthority>,
  "inspect" | "propose" | "decide"
>;

function parsedStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
      .map((value) => value.trim());
  } catch {
    return [];
  }
}

/**
 * 排行榜不足五家时的自然语言补充入口。只接受用户在当前消息中明确确认的
 * 名称；工具把原话作为 asked 来源，经同一个 KnowledgeAuthority 提议并立即
 * adopt。调用边界从 Session Gate 取主体、从最新持久化用户消息取原话；
 * 模型发现的名字仍走普通候选卡，不能调用本入口自动确认。
 */
export async function confirmRankingCompetitors(
  input: { subject: string; names: string[]; userInstruction: string },
  authority: RankingCompetitorAuthority = knowledgeAuthority(),
) {
  const subject = input.subject.trim();
  const userInstruction = input.userInstruction.trim();
  const names = [
    ...new Set(input.names.map((name) => name.trim()).filter(Boolean)),
  ];
  if (!subject || !userInstruction || names.length === 0) {
    throw new Error("ranking_competitor_confirmation_invalid");
  }
  const [fullName, shortNames, relatedBrands] = await Promise.all([
    authority.inspect({
      subject,
      predicate: "enterprise-profile.fullname",
      scope: { entityScope: "brand" },
    }),
    authority.inspect({
      subject,
      predicate: "enterprise-profile.shortnames",
      scope: { entityScope: "brand" },
    }),
    authority.inspect({
      subject,
      predicate: "enterprise-profile.relatedbrands",
      scope: { entityScope: "brand" },
    }),
  ]);
  const identity = {
    workspaceBrandName: subject,
    fullNames: parsedStringList(fullName?.normalizedValueJson),
    shortNames: parsedStringList(shortNames?.normalizedValueJson),
    relatedBrands: parsedStringList(relatedBrands?.normalizedValueJson),
  };
  const allowedNames = filterValidRankingCompetitors(names, identity);
  const invalid = names.filter((name) => !allowedNames.includes(name));
  if (invalid.length > 0) {
    throw new Error(`ranking_competitor_name_invalid:${invalid.join("、")}`);
  }
  const candidate = await authority.propose({
    rawInput: userInstruction,
    origin: "user-stated",
    intent: "knowledge-update",
    key: {
      subject,
      predicate: "enterprise-profile.competitors",
      scope: { entityScope: "brand" },
    },
    value: allowedNames,
    source: {
      excerpt: userInstruction,
      confidence: 1,
      profileProvenance: "asked",
    },
  });
  const result = await authority.decide({
    candidateId: candidate.id,
    decision: "adopt-new",
    expectedCurrentVersion: candidate.baseVersion,
    actorId: "desktop-user",
    reason: userInstruction,
  });
  const competitors = parsedStringList(result.current?.normalizedValueJson);
  const confirmedCount = filterValidRankingCompetitors(
    competitors,
    identity,
  ).length;
  return {
    kind: "ranking-competitors-confirmed",
    added: names,
    confirmedCount,
    readyForRanking: confirmedCount >= 5,
  };
}

export function rankingCompetitorRequirement(error: unknown): {
  kind: "ranking-competitors-required";
  confirmedCount: number;
  missingCount: number;
  instruction: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /article_generation_ranking_competitors_insufficient:(\d+)/.exec(message);
  if (!match) return null;
  const confirmedCount = Math.min(4, Math.max(0, Number(match[1])));
  const missingCount = 5 - confirmedCount;
  return {
    kind: "ranking-competitors-required",
    confirmedCount,
    missingCount,
    instruction: `当前已确认 ${confirmedCount} 家竞品，还差 ${missingCount} 家。请用户直接在聊天中回复要补充并确认的竞品名称。`,
  };
}

/**
 * generate_articles 工具入参 → ArticleOperationSource（票 #34）：
 * planId 与 direct 互斥（空 planId 走 Rust「最新 confirmed plan」回落）；
 * itemIds 是生成时选取的计划项子集，只对 plan 入口有意义，与 direct 同传
 * 即歧义。子集成员资格与逐项 approved 由 Rust seeds 准备校验。
 */
export function articleOperationSourceFromGenerateInput(input: {
  planId?: string;
  itemIds?: string[];
  direct?: {
    count: number;
    themes: string[];
    contentType: string;
    constraints: string;
  };
}): ArticleOperationSource {
  if (input.planId && input.direct) {
    throw new Error(
      "generate_articles accepts planId or direct, never both; omit both to use the latest confirmed plan",
    );
  }
  if (input.itemIds && input.direct) {
    throw new Error(
      "generate_articles itemIds selects plan items and cannot be combined with direct",
    );
  }
  return input.direct
    ? {
        kind: "direct",
        count: input.direct.count,
        themes: input.direct.themes,
        contentType: input.direct.contentType as GeoContentType,
        constraints: input.direct.constraints,
      }
    : {
        kind: "confirmed-topic-plan",
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.itemIds ? { itemIds: input.itemIds } : {}),
      };
}

export async function inspectBrandFact(key: FactKeyInput) {
  return knowledgeAuthority().inspect(key);
}

/**
 * inspect_geo_probe_samples 的领域入口：组合两个既有只读持久化端口
 * （基线 latest + geo-dashboard get/drilldown），不新建 Rust 通道。
 */
export async function inspectGeoProbeSamples(input: {
  limit?: number;
}): Promise<GeoProbeSamplesReport> {
  const identity = stageIdentity();
  const baselinePort = createGeoBaselinePort(identity);
  const dashboardPort = createGeoDashboardPort(identity);
  return new GeoProbeSamplesService({
    latestBaseline: () => baselinePort.latest(),
    getDashboard: (filters) => dashboardPort.get(filters),
    drilldown: (target) => dashboardPort.drilldown(target),
  }).inspect(input);
}

/**
 * 与 geoOperationControlFailure 同构：裸 throw 只会变成 SDK 的 isError 单行
 * 文本，模型拿不到恢复路径；Rust 侧错误码原样透传，附一条中文恢复指引。
 */
export function geoProbeSamplesFailure(error: unknown): {
  kind: 'geo-probe-samples';
  ok: false;
  error: string;
  hint: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'geo-probe-samples',
    ok: false,
    error: message,
    hint: '探测证据读取失败，未改变任何状态。可稍后重试；若持续失败，引导用户在「效果」页直接查看真实探测证据。',
  };
}

/**
 * plan_distribution 的转录投影（卡片最小投影）：只回「卡片初始渲染 +
 * agent 复述」所需字段，把转录占用压到 ~1/7；卡片 3s 轮询 /latest 后即
 * 切换为完整权威投影，编辑/确认请求不依赖这份瘦身数据（assignments 全量
 * 保留以防轮询前确认）。转录只携带点数（budgetPoints /
 * estimatedPricePoints）：CNY 金额与换算倍率不进聊天，agent 只能引用
 * 点数字段复述费用。
 */
export function distributionPlanCardProjection(
  plan: DistributionPlanProjection,
): DistributionPlanCardProjection {
  return {
    id: plan.id,
    status: plan.status,
    revision: plan.revision,
    budgetPoints: cnyToPoints(plan.budgetCny),
    perArticleMaxPoints:
      plan.perArticleMaxPoints ??
      DEFAULT_DISTRIBUTION_SPEND_LIMITS.perArticleMaxPoints,
    totalMaxPoints: plan.totalMaxPoints ?? cnyToPoints(plan.budgetCny),
    workspaceId: plan.workspaceId,
    publishStartAt: plan.publishStartAt,
    selectedResourceIds: plan.selectedResourceIds,
    blockingIssues: plan.blockingIssues,
    articles: plan.articles.map((article) => ({ id: article.id })),
    assignments: plan.assignments,
    candidates: plan.candidates.map((candidate) => ({
      resourceId: candidate.resourceId,
      kind: candidate.kind,
      name: candidate.name,
      availability: candidate.availability,
      estimatedPricePoints:
        candidate.estimatedPriceCny === null
          ? null
          : cnyToPoints(candidate.estimatedPriceCny),
      pathHits: candidate.pathHits,
      fitReasons: candidate.fitReasons,
      evidence: candidate.evidence.map((item) => ({
        path: item.path,
        label:
          item.label.length > 64
            ? `${item.label.slice(0, 64)}…`
            : item.label,
      })),
    })),
  };
}

/**
 * prepare_publish 的转录投影：与 plan_distribution 同一原则——CNY 金额
 * （budgetCny / estimatedSpendCny / 逐项 estimatedPriceCny）与换算倍率
 * 不进聊天，只带卡片首渲染 + agent 复述所需的点数字段；完整权威投影由
 * 卡片 3s 轮询 /latest 水合（解析侧见 PublishAuthorizationGateCard）。
 */
export function publishExecutionCardProjection(
  execution: PublishExecutionProjection,
): PublishExecutionCardProjection {
  return {
    id: execution.id,
    revision: execution.revision,
    status: execution.status,
    workspaceId: execution.workspaceId,
    distributionPlanId: execution.distributionPlanId,
    publishStartAt: execution.publishStartAt,
    confirmationDigest: execution.confirmationDigest,
    irreversibleImpact: execution.irreversibleImpact,
    totalPricePoints: execution.totalPricePoints,
    budgetPoints: cnyToPoints(execution.budgetCny),
    items: execution.items.map((item) => ({
      id: item.id,
      status: item.status,
      scheduledAt: item.scheduledAt,
      article: {
        title: item.article.title,
        bodySummary: item.article.bodySummary,
      },
      channel: {
        resourceId: item.channel.resourceId,
        kind: item.channel.kind,
        name: item.channel.name,
        pricePoints: item.channel.pricePoints,
      },
    })),
  };
}

/**
 * plan_distribution 的预算入参换算：聊天边界只携带点数，缺省使用设置页
 * 当前总上限；给出点数时按 pointsToCny 折算回内部 CNY（预算上限语义，
 * 换算倍率不进转录）。
 */
export function planDistributionBudgetCny(
  budgetPoints: number | undefined,
  maximumBudgetPoints: number =
    DEFAULT_DISTRIBUTION_SPEND_LIMITS.perExecutionMaxPoints,
): number {
  return pointsToCny(Math.min(budgetPoints ?? maximumBudgetPoints, maximumBudgetPoints));
}

/**
 * Product-owned capability boundary for Xiaojing. Later GEO slices extend this
 * one fixed server instead of exposing unregistered capability sources.
 */
export async function createXiaojingGeoServer() {
  // Materialize the fixed typed provider registry before exposing any GEO
  // tool. Later business slices receive these ports; they never read env or
  // provider DTOs directly.
  getXiaojingGeoProviderCapabilities();
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  const rankingCompetitorGate = sessionRankingCompetitorGate(context.sessionId);
  const latestUserMessage = async () => {
    const transcript = await loadSessionTranscript(context.sessionId);
    const latest = [...transcript.messages]
      .reverse()
      .find((message) => message.role === 'user');
    return latest
      ? { id: latest.id, content: latest.content }
      : null;
  };
  const operationReferenceSchema = z.object({
    kind: z.enum(GEO_OPERATION_REFERENCE_KINDS),
    id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+$/),
    revision: z.number().int().min(0).optional(),
  });
  return createSdkMcpServer({
    name: 'xiaojing-geo',
    version: '1.0.0',
    instructions: 'Only report capabilities marked available. Never invent results for planned GEO slices.',
    alwaysLoad: true,
    tools: [
      tool(
        'inspect_brand_context',
        "Read the current Xiaojing brand/session identity and the cross-session BrandWorkspace state summary (brand name, product lines, confirmed ranking competitors, and the latest persisted artifact status per stage: question pool, topic plan, articles, distribution plan, publish execution). The summary also lists this brand's unfinished GEO operation rounds from any prior session as read-only metadata (kind, goal, the stuck step and its display phase, pending review count, owning session, created/updated times, and updateKnowledge — whether that round updates brand knowledge: false means a reuse round that keeps confirmed knowledge and starts from question-pool selection, true means a knowledge-update round; describe each round accordingly instead of guessing from its kind) — use it to recognize an interrupted round and offer to continue it; only the 5 most recently updated rounds are listed, truncatedCount names how many older ones exist, and draft bodies and chat transcripts are never included. Call this once early in a session, before proposing a GEO action and before asking the user for any brand facts — prior sessions' confirmed knowledge and approved artifacts are already persisted here; only ask the user when this summary or inspect_brand_fact shows the fact is missing. Do not re-read speculatively: while the persisted state is unchanged, a re-read returns only the slim {kind:'brand-workspace-state-unchanged'} marker — reuse your previous full read; re-read after your own writes (material import, knowledge confirmation, takeover) or when the user reports another session's activity.",
        { reason: z.string().max(200).optional().describe('Why the current GEO context is needed.') },
        async () => {
          const payload = {
            ...xiaojingGeoContextSnapshot(),
            workspaceState: await brandWorkspaceStateSummary(),
          };
          const serialized = JSON.stringify(payload);
          if (
            lastBrandContextRead?.sessionId === context.sessionId &&
            lastBrandContextRead.serialized === serialized
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    kind: 'brand-workspace-state-unchanged',
                    note: BRAND_CONTEXT_UNCHANGED_ENVELOPE_NOTE,
                  }),
                },
              ],
            };
          }
          lastBrandContextRead = { sessionId: context.sessionId, serialized };
          return { content: [{ type: 'text' as const, text: serialized }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'start_geo_operation',
        "Create the one BrandWorkspace GeoOperation that matches the user's intent. Use the direct intent when the user names a specific stage; when the user states a GEO goal without naming a stage, create full-optimization instead of asking which intent to pick. The starting-point derivation question also settles where the round ENDS: pass the user-picked end as endingPhase (with a one-sentence endingPointReason) so one operation spans start to end — never create a follow-up operation to continue the same chain inside the round; a new operation or takeover only happens when the user changes the plan mid-round. Keep goal a short plain-language phrase (e.g. 一轮完整的 GEO 优化) — the chat progress card broadcasts the full stage and step plan, so never restate every step in prose; report only the stage and the confirmation gate the operation currently stops at. When the starting point was derived from the brand-state summary and the user just picked it in your recommended-option question (start a new round without a knowledge update / start over from knowledge), pass that derived starting point and its reason as startingPointReason in one plain sentence — the plan acknowledgement gate then shows where this round starts and why, so the user confirms the starting point, not just the start. When the user picked 'start a new round' (reuse the pool, no knowledge update), also pass updateKnowledge=false explicitly — the preferred path: the plan then starts directly at pool selection, matching the pick; the answer must not be omitted (an omitted full-chain plan starts at the knowledge chain and contradicts the pick), though the server already normalizes full-optimization + updateKnowledge=false and next-round-optimization + updateKnowledge=false into the identical step shape. Never call this tool for the continue-last-round pick: that option is the single whole-card takeover confirmation of the listed unfinished round — call takeover_geo_operation instead; creating a new round here would abandon the round (its progress and pending work set) the user chose to continue. Every new operation first parks at the plan acknowledgement gate: after creating it, briefly state the goal and the opening stage, tell the user to review and release the plan on the progress card, then end your turn — do not start any stage before the operation event reminder tells you the plan was released. For next-round-optimization whose knowledge branch the user has not answered yet, omit updateKnowledge first so the operation stops and asks, then record the user's answer with choose_next_round_knowledge; the explicit answer releases the replaced plan, which starts directly at its first work step (still stopping at that stage's confirmation gate); if the user already answered the knowledge branch explicitly while picking the starting point, pass that answer here instead of re-asking. When reporting to the user, use natural, professional Simplified Chinese and keep your own thinking in Simplified Chinese; never surface internal enum values, operation IDs, UUIDs, revision numbers, tool names, or endpoint names — describe the operation by its goal and stages in plain language.",
        {
          intent: z.enum(GEO_OPERATION_KINDS),
          goal: z.string().min(1).max(500),
          inputRefs: z.array(operationReferenceSchema).max(256).optional(),
          sourceOperationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/)
            .optional(),
          updateKnowledge: z.boolean().optional(),
            startingPointReason: z
              .string()
              .min(1)
              .max(300)
              .optional()
              .describe(
                'One plain sentence stating the derived starting point and why (e.g. 知识 3 天前刚确认，直接从问题机会继续). Only pass it when the starting point was derived from inspect_brand_context and the user picked it; it appears on the plan acknowledgement gate so the user confirms where the round starts, not just the start.',
              ),
            endingPhase: z
              .enum(GEO_OPERATION_PHASE_ID_ORDER)
              .optional()
              .describe(
                'The stage where this round ends (from the starting-point derivation question the user answered). Omit only when the user explicitly wants a single stage; otherwise pass the user-picked end so the plan card shows the full start-to-end span and the round continues through downstream stages without creating follow-up operations. Must be strictly downstream of the intent start — an end equal to the start is not a span; omit endingPhase for single-stage rounds.',
              ),
            endingPointReason: z
              .string()
              .min(1)
              .max(300)
              .optional()
              .describe(
                'One plain sentence stating why the round ends there (e.g. 用户选择先发文验证效果，做到发布为止). Only pass it together with endingPhase; it appears on the plan acknowledgement gate.',
              ),
          },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'geo-operation',
                operation: await startGeoOperation({
                  intent: input.intent,
                  goal: input.goal,
                  inputRefs: input.inputRefs as
                    | GeoOperationReference[]
                    | undefined,
                  sourceOperationId: input.sourceOperationId,
                  updateKnowledge: input.updateKnowledge,
                  startingPointReason: input.startingPointReason,
                  endingPhase: input.endingPhase,
                  endingPointReason: input.endingPointReason,
                }),
              }),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'inspect_geo_operations',
        'Read one exact GeoOperation, or list operations owned by the current Session. Execution context is never shared across Sessions.',
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/)
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                geoOperationProjectionPayload(await inspectGeoOperations(input)),
              ),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'choose_next_round_knowledge',
        "Record the user's explicit answer to the next-round knowledge-refresh question. Never infer this answer from a dashboard report.",
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
          updateKnowledge: z.boolean(),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'geo-operation',
                operation: await chooseNextRoundKnowledge(input),
              }),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'control_geo_operation',
        'Pause, resume, retry, or cancel one exact GeoOperation with revision CAS. Valid by status: pause works from ready/queued/running/recovering; resume only from paused/recovering; retry only for failed operations whose error is retryable; cancel works until the operation is terminal. An invalid-transition error lists the actions valid for the current status. This tool cannot confirm knowledge, paid publishing, external publishing, or monitoring activation.',
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
          action: z.enum(['pause', 'resume', 'retry', 'cancel']),
        },
        async (input) => {
          try {
            const operation = await controlGeoOperation(input);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    kind: 'geo-operation',
                    operation,
                  }),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(geoOperationControlFailure(error)) },
              ],
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        'takeover_geo_operation',
        "Take over an unfinished GEO round owned by another session (ADR-0010): one CAS mutation transfers its ownership — plus the owning session's unapproved article drafts and awaiting-selection question pools, which move with the round as a whole — to the current session, which can then continue from the stuck step exactly where the round stopped. Gate discipline: the takeover confirmation is exactly ONE whole-card confirmation on the chat gate card — after inspect_brand_context lists the unfinished round, present its goal, stuck stage, pending review count and owning session with your recommendation, let the user confirm once on the card, then call this tool a single time; never call it speculatively, never re-ask after the user already confirmed, and never create a second confirmation entry. The continue-last-round option in the starting-point derivation question IS that one whole-card confirmation — its description already carries the round's goal and stuck point, so once the user picks it, call this tool a single time immediately; routing that pick into start_geo_operation (creating a new round) is the wrong action and abandons the round the user chose to continue. Rejections return structured relayable results: a running round must pause or finish first (closing the old window auto-pauses); a round already taken over names the winning session; a terminal round means there is nothing to continue. On success report what transferred (drafts and pending pools follow the round) and continue the round with inspect_geo_operations.",
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
        },
        async (input) => {
          try {
            const takeover = await takeoverGeoOperation(input);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    kind: 'geo-operation-takeover',
                    ok: true,
                    takeover,
                  }),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(geoOperationTakeoverFailure(error)) },
              ],
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        'propose_brand_fact',
        'Submit raw text and one structured brand-fact candidate to KnowledgeAuthority. This never confirms a new or changed value. Use origin=model-inferred and intent=chat-observation for facts merely noticed during ordinary chat; those always remain suggestions. Use origin=user-stated and intent=knowledge-update only when the user explicitly asked to add or update knowledge.',
        {
          rawInput: z.string().min(1).max(20_000),
          origin: z.enum(['user-stated', 'model-inferred']),
          intent: z.enum(['knowledge-update', 'chat-observation']),
          subject: z.string().min(1).max(200),
          predicate: z.string().min(1).max(200),
          scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
          effectiveFrom: z.string().optional(),
          effectiveTo: z.string().optional(),
          value: z.json(),
          unit: z.string().max(80).optional(),
          materialId: z.string().max(200).optional(),
          excerpt: z.string().min(1).max(KNOWLEDGE_EXCERPT_MAX_LENGTH),
          confidence: z.number().min(0).max(1),
          profileProvenance: z.enum(['extracted', 'asked', 'inferred']).optional(),
        },
        async (input) => {
          const result = await proposeBrandFact({
            rawInput: input.rawInput,
            origin: input.origin,
            intent: input.intent,
            key: {
              subject: input.subject,
              predicate: input.predicate,
              scope: input.scope,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo,
            },
            value: input.value,
            unit: input.unit,
            source: {
              materialId: input.materialId,
              excerpt: input.excerpt,
              confidence: input.confidence,
              profileProvenance: input.profileProvenance,
            },
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        "confirm_ranking_competitors",
        "Confirm competitor names the user explicitly supplied in their latest natural-language message after ranking generation reported fewer than five confirmed competitors. Pass only those names: the server owns the pending Session gate, target subject, original article request, and verbatim audit text from the latest persisted user message. Names absent from that message are rejected. Never use model-inferred, searched, or merely mentioned names. When the valid total reaches five, this tool itself resumes the original article request and returns the article operation; do not call generate_articles again.",
        {
          names: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(20)
            .describe(
              "Only competitor names explicitly written by the user in the latest message.",
            ),
        },
        async (input) => {
          const latest = await latestUserMessage();
          const challenge = rankingCompetitorGate.authorize(input, latest);
          const confirmed = await confirmRankingCompetitors({
            subject: challenge.subject,
            names: input.names,
            userInstruction: challenge.userInstruction,
          });
          if (!confirmed.readyForRanking) {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(confirmed) },
              ],
            };
          }
          rankingCompetitorGate.clear();
          try {
            const operation = await articleService().start({
              ...stageIdentity(),
              source: challenge.source,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ kind: "article-operation", operation }),
                },
              ],
            };
          } catch (error) {
            const requirement = rankingCompetitorRequirement(error);
            if (!requirement) throw error;
            rankingCompetitorGate.advanceFence(latest!.id);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(requirement) },
              ],
            };
          }
        },
        { alwaysLoad: true },
      ),
      tool(
        "inspect_brand_fact",
        "Read the current authoritative value for one exact structured fact key. Scope and effective time are part of the key and must be supplied explicitly when applicable.",
        {
          subject: z.string().min(1).max(200),
          predicate: z.string().min(1).max(200),
          scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
          effectiveFrom: z.string().optional(),
          effectiveTo: z.string().optional(),
        },
        async (input) => ({
          content: [{ type: 'text' as const, text: JSON.stringify({
            kind: 'knowledge-authority-read',
            current: await inspectBrandFact(input),
          }) }],
        }),
        { alwaysLoad: true },
      ),
      tool(
        GATE_REVISION_TOOL_NAME,
        GATE_REVISION_TOOL_DESCRIPTION,
        {
          gate: z.enum(GATE_REVISION_GATE_TYPES),
          operations: z
            .array(
              z.object({
                action: z.enum(['modify', 'delete', 'add']),
                targetId: z.string().min(1).max(200).optional()
                  .describe('modify/delete: pending entry id from the confirmation card (knowledge gate = candidate id; distribution channel ops use the resourceId, publish item ops use the item id).'),
                subject: z.string().min(1).max(200).optional()
                  .describe('Entry kind. knowledge add: fact subject of the new entry. question-pool: "keyword" targets a mined search term, omit for a candidate question. distribution-plan: "channel" | "assignment" (omit for plan-level budget/publishStartAt). publish-preparation: "item" (omit for execution-level budget/publishStartAt).'),
                predicate: z.string().min(1).max(200).optional()
                  .describe('add: fact predicate of the new entry.'),
                scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
                effectiveFrom: z.string().optional(),
                effectiveTo: z.string().optional(),
                value: z.json().optional()
                  .describe('modify/add: the new value the user asked for. Budget changes are in points: { budgetPoints: number }.'),
                unit: z.string().max(80).optional(),
                materialId: z.string().min(1).max(200).optional()
                  .describe('add: material id of the pending confirmation card — required for the knowledge gate so the new row joins that card; facts outside a pending card go through propose_brand_fact.'),
                userInstruction: z
                  .string()
                  .min(1)
                  .max(GATE_REVISION_MAX_USER_INSTRUCTION_CHARS)
                  .describe('The user\'s explicit instruction quoted verbatim; recorded in the audit trail.'),
              }),
            )
            .min(1)
            .max(GATE_REVISION_MAX_OPERATIONS),
        },
        async (input) => {
          let receipt: GateRevisionReceipt;
          if (!context.workspace) {
            receipt = {
              kind: 'gate-revision',
              gate: input.gate,
              ok: false,
              code: 'workspace_required',
              error: 'Gate revision requires an explicit workspace identity',
              results: [],
            };
          } else {
            receipt = await dispatchGateRevision(
              input.gate,
              input.operations as GateRevisionOperation[],
              {
                workspaceId: basename(context.workspace),
                sessionId: context.sessionId,
              },
            );
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'request_brand_material',
        `Surface the brand-material request card in chat where the user uploads materials (file picker, pasted text or official-site URL; PDF/Office are parsed there). Call it exactly when: (1) material-collection contract: ${MATERIAL_COLLECTION_CONTRACT}; (2) the user explicitly asks to add brand material; (3) the user attached a binary file that read_session_file cannot parse and it is brand material. Never call it mid-operation just because a gate lacks material evidence — proceed with AI-completion rows and let the user adjudicate on that card. reason is one plain-language line shown on the card header. When the card is issued while the round parks at the material-collection step it also carries a real skip action: the user may press 跳过材料收集 (behind a confirmation) to strip the round's remaining knowledge steps and continue from the next planned step; if the user asks to skip in chat instead, record it with skip_material_collection rather than telling them to press anything else. After calling it, tell the user to upload on the card and end your turn; the knowledge confirmation card follows the import automatically.`,
        { reason: z.string().min(1).max(300).describe('One plain-language line telling the user why material is needed now.') },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                buildMaterialRequestCardData(input.reason, await resolveMaterialSkipTarget()),
              ),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'skip_material_collection',
        "Record the user's explicit request to skip this round's material collection (e.g. they reply 跳过/先不补材料 while the material-request card waits): one plan-replacement strips the round's remaining knowledge-segment steps — already completed or confirmed steps stay — and the operation continues from the next planned step on the existing confirmed knowledge; the user can still upload material at any time afterwards. Read operationId and the latest revision from inspect_geo_operations first; never call it speculatively, never call it because the round feels slow, and never re-ask after the user already confirmed the skip — the skip is the user's decision, not yours. Invalid when the round is not currently parked inside the knowledge segment (nothing left to strip) or when the revision is stale (re-read and retry).",
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'geo-operation',
                operation: await skipMaterialCollection(input),
              }),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'import_pasted_material',
        'Save user-pasted brand material as a traceable original, extract Enterprise Profile candidates, and submit every candidate to KnowledgeAuthority. Never use this for a local file path.',
        {
          text: z.string().min(1).max(2_000_000),
          displayName: z.string().min(1).max(180).optional(),
        },
        async (input) => {
          logMaterialTool('import-text', 'started');
          const result = await materialImportService().importPastedText(input.text, input.displayName);
          logMaterialTool('import-text', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          // 记录附件名→已导入，供后续附件提醒标注（ADR-0001）。
          if (input.displayName) markSessionFileImported(input.displayName);
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'delete_brand_material',
        "Delete one imported brand material of this session: the stored original, its file and its pending knowledge candidates are removed; knowledge facts the user already confirmed are never touched. Call it when the user asks to delete or discard an uploaded material (e.g. wrong file uploaded, to be replaced by a new one). Identify it by materialId when known, otherwise by exact displayName (the file/material name the user mentions). Name lookup covers this session's 20 most recent materials; when the name matches nothing or matches several, the result lists them — ask the user to pick, never guess. A material still being processed cannot be deleted; tell the user to wait for its extraction to finish or fail, then retry. After a successful delete, confirm the removal and, when the user wants a replacement, surface the material request card via request_brand_material.",
        {
          materialId: z.string().min(1).max(200).optional()
            .describe('The material id when known (from an import result or a previous list).'),
          displayName: z.string().min(1).max(180).optional()
            .describe('Exact material display name (e.g. the original file name) when materialId is unknown.'),
        },
        async (input) => {
          const respond = (payload: Record<string, unknown>) => ({
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          });
          let materialId = input.materialId;
          try {
            const port = brandMaterialPort();
            if (!materialId) {
              if (!input.displayName) {
                return respond({
                  kind: 'material-delete',
                  ok: false,
                  error: 'material_identity_required',
                  hint: 'Pass materialId, or the exact displayName of the material to delete.',
                });
              }
              const items = await port.list({ limit: 20 });
              const matches = items.filter((item) => item.material.displayName === input.displayName);
              if (matches.length !== 1) {
                return respond({
                  kind: 'material-delete',
                  ok: false,
                  error: matches.length === 0 ? 'material_not_found' : 'material_name_ambiguous',
                  materials: items.map((item) => ({
                    materialId: item.material.id,
                    displayName: item.material.displayName,
                    status: item.material.status,
                  })),
                  hint: 'Ask the user which one to delete, then retry with its materialId.',
                });
              }
              materialId = matches[0].material.id;
            }
            await port.delete(materialId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logMaterialTool('delete', 'failed', { materialId, errorCode: message });
            return respond({
              kind: 'material-delete',
              ok: false,
              error: message,
              hint: message.includes('material_processing_active')
                ? 'This material is still being processed; wait for its extraction to finish or fail, then retry the delete.'
                : message.includes('material_not_found')
                  ? 'No such material in this brand workspace; it may already be deleted.'
                  : 'Delete was refused; relay the error to the user.',
            });
          }
          logMaterialTool('delete', 'completed', { materialId });
          return respond({ kind: 'material-delete', ok: true, materialId });
        },
        { alwaysLoad: true },
      ),
      tool(
        'read_session_file',
        'Read one file the user attached to a chat message. Scope is strictly the current session directory xiaojing_files/<sessionId>/; returns a bounded head of text plus totalChars and a truncated flag — continue larger files with offsetChars. Binary attachments are rejected with guidance to surface the material request card via request_brand_material instead.',
        {
          path: z
            .string()
            .min(1)
            .max(600)
            .describe('Workspace-relative path from the session-files reminder, e.g. xiaojing_files/<sessionId>/notes.md'),
          offsetChars: z
            .number()
            .int()
            .min(0)
            .max(SESSION_FILE_READ_MAX_OFFSET_CHARS)
            .optional()
            .describe('Character offset to continue from a previous truncated read.'),
        },
        async (input) => {
          const fail = (error: string, hint: string) => ({
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'session-file-read', ok: false, error, hint }) }],
          });
          if (!isSessionFileReference(input.path, context.sessionId)) {
            return fail(
              'path_out_of_scope',
              'Only files under the current session directory xiaojing_files/<sessionId>/ are readable.',
            );
          }
          if (!isSessionFileTextReadable(input.path)) {
            return fail(
              'binary_not_readable',
              'This file type cannot be read as text. If it is brand material, call request_brand_material so the user can upload it on the chat material request card (paste, official-site URL or file picker; PDF/Office are parsed there).',
            );
          }
          const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
          if (!context.workspace || !sidecarId) {
            return fail('sidecar_identity_missing', 'Session file reading requires an authenticated Sidecar identity.');
          }
          const result = await managementApi(
            '/api/workspace-files/read-session-file',
            'POST',
            {
              sidecarId,
              workspaceId: basename(context.workspace),
              sessionId: context.sessionId,
              payload: {
                relativePath: input.path,
                offsetChars: input.offsetChars ?? 0,
                maxChars: SESSION_FILE_READ_HEAD_CHARS,
              },
            },
          );
          if (result.ok !== true) {
            return fail(
              typeof result.code === 'string' ? result.code : 'management_read_failed',
              typeof result.error === 'string' ? result.error : 'The desktop shell refused or failed the scoped file read.',
            );
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'session-file-read',
                ok: true,
                path: input.path,
                offsetChars: typeof result.offsetChars === 'number' ? result.offsetChars : (input.offsetChars ?? 0),
                content: typeof result.content === 'string' ? result.content : '',
                totalChars: typeof result.totalChars === 'number' ? result.totalChars : 0,
                truncated: result.truncated === true,
              }),
            }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'import_website_material',
        'Fetch one public HTTPS official-site URL with SSRF, redirect, content-type, size and timeout guards; save the raw response before extracting candidates through KnowledgeAuthority.',
        { url: z.string().url().max(2_000) },
        async (input) => {
          logMaterialTool('fetch-website', 'started');
          const result = await materialImportService().importWebsite(input.url);
          logMaterialTool('fetch-website', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'retry_brand_material',
        'Retry extraction for exactly one already-stored brand material. This does not rerun any other material.',
        { materialId: z.string().uuid() },
        async (input) => {
          logMaterialTool('retry', 'started', { materialId: input.materialId });
          const result = await materialImportService().process(input.materialId);
          logMaterialTool('retry', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'run_question_pool',
        `Run the question-opportunity stage for one product line (domain-level, e.g. 汽车音响改装 — not a fine-grained service item). Reuse contract: ${QUESTION_POOL_REUSE_CONTRACT}; call it as planned without judging whether to skip or rerun — when no reusable pool exists the service mines keywords online and generates candidate questions (real provider spend). Omit productLine to use the brand's first confirmed product line (synced from the industry fact at knowledge confirmation — if none exists, call request_brand_material so the user can import brand material and confirm knowledge first, then retry). When the user names a specific business within the domain (e.g. 汽车隔音), pass it as businessFocus instead of inventing a new product line. On fresh generation the result renders as the confirmation card where the user reviews the mined keywords and selects questions — never claim the pool is confirmed; a reused confirmed pool arrives on the card pre-checked with the previous selection and the user re-selects this round's questions there (the card also offers a paid regenerate) — the question gate releases only on the user's card confirmation, never proceed past it on your own. Keyword geography is bounded by the user-declared service area (服务区域): the declared scope kept at its own granularity (e.g. 新都区 stays 新都区, not the whole 成都) is both the mining anchor and the ceiling — terms never reference regions beyond it, and store addresses only anchor when no usable scope is declared. For targetRegion pass the declared scope as a plain name (e.g. 新都区 or 成都); never prose like 成都本地，辐射西南地区 and never boundless values such as 全国 — nationwide/online service mines in geo-free mode.`,
        {
          productLine: z.string().min(1).max(120).optional(),
          targetRegion: z.string().min(1).max(60),
          businessFocus: z.string().min(2).max(120).optional(),
          idempotencyKey: z.string().min(8).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          // 顺序闸（票 #05）：阶段工具先对齐本会话操作的当前步，越序调用
          // 在任何业务工作（含缺省产品线回读）之前被结构化拒绝。
          const orderGate = await stageToolOrderRejection(identity, 'run_question_pool');
          if (orderGate) return stageOrderGateResult(orderGate);
          let productLine = input.productLine?.trim();
          if (!productLine) {
            const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
            if (!sidecarId) {
              throw new Error('Brand workspace info requires an authenticated Sidecar identity');
            }
            const info = await managementApi('/api/brand-workspace/info', 'POST', {
              sidecarId,
              workspaceId: identity.workspaceId,
              sessionId: identity.sessionId,
              payload: {},
            });
            const lines: unknown = (info as { workspace?: { productLines?: unknown } }).workspace?.productLines;
            if (info.ok !== true || !Array.isArray(lines)) {
              throw new Error(
                typeof (info as { error?: unknown }).error === 'string'
                  ? (info as { error: string }).error
                  : 'brand_workspace_info_unavailable',
              );
            }
            const first = (lines as string[]).find((line) => line.trim().length > 0);
            if (!first) {
              throw new Error(
                '品牌还没有已确认的产品线（领域）：请先用 request_brand_material 发起材料请求，待用户上传品牌资料并在确认卡片上完成知识裁决后重试；行业事实确认后产品线会自动同步。',
              );
            }
            productLine = first;
          }
          // 执行段先行 begin：题库挖掘是真实 provider 工作，进度条从
          // ready 推进到 running，避免长耗时期间条上无事发生。必须在
          // 输入解析（含缺省产品线回读）之后触发——纯校验失败不应把
          // 步骤留在 running。
          await recordGeoOperationMilestone(identity, 'question-pool-generation-started');
          const pool: QuestionPoolProjection = await questionPoolService().generate({
            ...identity,
            productLine,
            targetRegion: input.targetRegion,
            ...(input.businessFocus ? { businessFocus: input.businessFocus } : {}),
            idempotencyKey: input.idempotencyKey ?? `agent-pool-${crypto.randomUUID()}`,
          });
          await recordGeoOperationMilestone(identity, 'question-pool-generated');
          // 复用契约（ADR-0011 Decision 3，2026-09-01 修订）：已确认池到达时
          // 卡片预勾上次的选择，由用户为本轮重选——问题门只在用户的卡片
          // 确认（confirm 路由发 question-pool-confirmed 里程碑）后放行，
          // 这里不自动放行。信封 outcome + proceed 提示与工具描述、next-step
          // 表同一话术。判定与确认卡展示侧同口径：只看 status=confirmed。
          const envelope = pool.status === 'confirmed'
            ? {
                kind: 'question-pool',
                outcome: QUESTION_POOL_REUSE_OUTCOME,
                proceed: `Zero-cost reuse hit — ${QUESTION_POOL_REUSE_CONTRACT}; park at the question gate and wait for the user's card confirmation, never proceed past it on your own.`,
                pool,
              }
            : { kind: 'question-pool', pool };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'plan_topics',
        'Run the content-planning stage: cluster the confirmed questions semantically and produce the five-type topic/title plan (real provider spend). Plan reuse: the service returns the existing confirmed plan for the same pool revision at zero cost — the card arrives pre-checked with the previously approved items and the user re-confirms or regenerates there (a paid regenerate); the content gate releases only on the card confirmation by the user, never proceed past it on your own. On fresh generation the result renders as the confirmation card where the user approves plan items — never claim a fresh plan is confirmed; the user confirms on the card. Requires a confirmed question pool first.',
        {
          questionPoolId: z.string().min(1).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          // 顺序闸（票 #05）：先对齐当前步，越序调用在真实 provider 工作前
          // 被结构化拒绝。
          const orderGate = await stageToolOrderRejection(identity, 'plan_topics');
          if (orderGate) return stageOrderGateResult(orderGate);
          // 执行段先行 begin：主题规划是真实 provider 工作。
          await recordGeoOperationMilestone(identity, 'topic-plan-started');
          const plan: TopicPlanProjection = await topicPlanService().generate({
            ...identity,
            ...(input.questionPoolId ? { questionPoolId: input.questionPoolId } : {}),
          });
          await recordGeoOperationMilestone(identity, 'topic-plan-generated');
          // 复用命中（prepare 返回同池同版本的既有 confirmed 计划，零成本）：
          // 停卡重选（预勾上次的已批准项），用户「沿用此计划」确认或付费
          // 重新生成——内容计划门只在用户的卡片确认后放行，这里不自动放行。
          const envelope = plan.status === 'confirmed'
            ? {
                kind: 'topic-plan',
                outcome: TOPIC_PLAN_REUSE_OUTCOME,
                proceed: 'Zero-cost reuse hit — this confirmed plan was already approved; park at the content gate and wait for the user to re-confirm or regenerate on the card, never proceed past it on your own.',
                plan: toTopicPlanCardProjection(plan),
              }
            : { kind: 'topic-plan', plan: toTopicPlanCardProjection(plan) };
          // 信封必须走卡片瘦身投影：完整投影曾达 ~81KB，超过 MCP 工具结果
          // 上限被 MCP 宿主客户端持久化成文件，tool.result 变存根、确认卡
          // 随之不渲染。瘦身后同级计划 ~29KB；plannedFacts 全量值以 SQLite
          // 为权威（saveItems 合并时服务端回填）。
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'generate_articles',
        'Run the article stage from the confirmed topic plan (or a direct explicit article task the user asked for). Real provider spend; drafts then pass the dual quality-gate review. The result renders as the approval card where the user reads each draft, checks the ones to approve and approves the selection — never claim an article is approved; only the user can approve on the card. Omit planId to consume the latest confirmed topic plan; pass planId only to pin a specific confirmed plan. Pass itemIds only when the user names a subset of the confirmed plan items to write now (e.g. "先写这三篇" — copy the item ids from the confirmed plan card); the rest stay available for later generations. Never pass both planId/direct together, and never combine itemIds with direct.',
        {
          planId: z.string().min(1).max(120).optional(),
          itemIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
          direct: z.object({
            count: z.number().int().min(1).max(10),
            themes: z.array(z.string().min(1).max(200)).min(1).max(10),
            contentType: z.enum(
              GEO_PORT_CONTRACT.contentTypes.slice() as unknown as [string, ...string[]],
            ),
            constraints: z.string().max(2000),
          }).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          // 空 planId 走 Rust「最新 confirmed plan」回落（规格：指定或最新）；
          // planId/direct 互斥与 itemIds 归属校验收敛在纯函数里（含历史注释
          // 的初衷：旧实现强制二选一，模型被迫空参试探报错后绕路四步打捞
          // planId——inspect_brand_fact 打错库、重跑 pool/plan）。
          const source: ArticleOperationSource =
            articleOperationSourceFromGenerateInput(input);
          const identity = stageIdentity();
          // 顺序闸（票 #05）：先对齐当前步，越序调用在真实 provider 工作
          //（含执行段 begin 里程碑）前被结构化拒绝；纯入参校验仍先行，
          // 互斥组合的 isError 语义不变。
          const orderGate = await stageToolOrderRejection(identity, 'generate_articles');
          if (orderGate) return stageOrderGateResult(orderGate);
          // 执行段先行 begin：文章生成是全程最长的真实工作段，进度条从
          // 工具开始即进入 running，逐篇落定由 onArticleSettled 回报 N/M。
          await recordGeoOperationMilestone(identity, 'article-generation-started');
          let operation: ArticleOperationProjection;
          try {
            operation = await articleService().start({
              ...identity,
              source,
              onArticleSettled: (settled, total) => {
                // Fire-and-forget：并发逐篇回报不得串行等待管理端口往返。
                void reportGeoOperationStepProgress(identity, 'generate-articles', {
                  current: settled,
                  total,
                });
              },
            });
          } catch (error) {
            const requirement = rankingCompetitorRequirement(error);
            if (requirement) {
              const [brandContext, latest] = await Promise.all([
                brandMaterialPort().context(),
                latestUserMessage(),
              ]);
              if (!latest) throw error;
              rankingCompetitorGate.issue({
                subject: brandContext.brandName,
                source,
                issuedAfterUserMessageId: latest.id,
              });
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(requirement) },
                ],
              };
            }
            rankingCompetitorGate.clear();
            throw error;
          }
          rankingCompetitorGate.clear();
          // 生成收尾：complete 执行段，确认门（审核并批准文章）就地停靠。
          await recordGeoOperationMilestone(identity, 'articles-generated');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'article-operation', operation }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'get_article_operation',
        'Read one article operation by operationId (or the latest when omitted) and return the same envelope that renders the article approval card in chat. Use it when the user asks to re-show the approval card or check article generation status; the approval card re-renders from this result, so never re-run generate_articles just to recover the card. Read-only: it never generates, edits, approves or decides anything.',
        {
          operationId: z.string().min(1).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          const operation = input.operationId
            ? await articleService().operation({
                ...identity,
                operationId: input.operationId,
              })
            : await articleService().latest(identity);
          if (!operation) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ kind: 'article-operation-not-found' }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ kind: 'article-operation', operation }),
              },
            ],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'plan_distribution',
        'Run the distribution-planning stage: discover real channel candidates from the approved articles and persisted evidence, then render the confirmation card where the user selects channels and confirms the plan. Confirming the plan never places orders or spends money. Derive targetAudience from brand context or the user goal; optional mappingMode/ratio/budgetPoints/publishStartAt default to product defaults. All cost values are points: pass the budget cap as budgetPoints and quote only the points fields in the result.',
        {
          targetAudience: z.string().min(2).max(200),
          mappingMode: z.enum(['one-to-one', 'ratio']).optional(),
          mediaRatio: z.number().min(0).max(100).optional(),
          weMediaRatio: z.number().min(0).max(100).optional(),
          budgetPoints: z.number().min(0).max(160_000_000).optional()
            .describe('Total budget cap in points (预算点数上限). Default: product default.'),
          publishStartAt: z.string().datetime().optional()
            .describe('Publish start time (发布开始时间), ISO 8601. Omit to publish immediately once the user authorizes; pass a future timestamp only for deliberate scheduled publishing.'),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          // 顺序闸（票 #05）：先对齐当前步，越序调用在渠道候选探测等业务
          // 工作前被结构化拒绝。
          const orderGate = await stageToolOrderRejection(identity, 'plan_distribution');
          if (orderGate) return stageOrderGateResult(orderGate);
          const service = distributionService();
          const [context, spendLimits] = await Promise.all([
            service.context({ ...stageIdentity() }),
            service.spendLimits({ ...stageIdentity() }),
          ]);
          if (context.articles.length === 0) {
            throw new Error('distribution_approved_articles_required');
          }
          const plan: DistributionPlanProjection = await service.start({
            ...identity,
            source: {
              articleOperationId: context.articles[0]?.operationId ?? '',
              articleIds: context.articles.map((article) => article.id),
              industry: context.industry,
              targetAudience: input.targetAudience,
              // 被动路证据由服务在现场探测问题池产出（js_ai 语义），工具不再
              // 透传基线快照；偏好路由品牌 overlay 合成。
              questionSources: [],
              preferredResourceIds: [],
              mappingMode: input.mappingMode ?? 'one-to-one',
              ratio: {
                media: input.mediaRatio ?? 2,
                weMedia: input.weMediaRatio ?? 1,
              },
              perArticleMaxPoints: spendLimits.perArticleMaxPoints,
              totalMaxPoints: spendLimits.perExecutionMaxPoints,
              // 聊天边界只携带点数：预算入参是点数，服务端换算回内部 CNY
              // （预算是上限语义，非计费），换算倍率不进转录。
              budgetCny: planDistributionBudgetCny(
                input.budgetPoints,
                spendLimits.perExecutionMaxPoints,
              ),
              // 确认即发：默认开始时间取当前时间——用户授权启动后到期项立即被
              // 调度器认领执行；只有显式传入未来时间才是定时发布。
              publishStartAt: input.publishStartAt ?? new Date().toISOString(),
            },
          });
          // 工具结果是聊天转录的一部分：只回「卡片初始渲染 + agent 复述」
          // 所需的最小投影，且费用字段一律为点数（CNY 与换算倍率不进聊天）；
          // 字段口径见 distributionPlanCardProjection。
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'distribution-plan', plan: distributionPlanCardProjection(plan) }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'prepare_publish',
        'Run the publishing stage: build the exact publish-execution preview (final approved articles, channels, per-channel points prices, points budget, schedule) from the confirmed distribution plan. This uploads nothing, charges nothing and places no order. The result renders as the irreversible-authorization card; the user authorizes and starts publishing there — the Agent can never authorize or start a paid publish. Quote only the points fields (totalPricePoints, budgetPoints, pricePoints) from the result.',
        {
          planId: z.string().min(1).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          // 顺序闸（票 #05）：发布预览也要对齐当前步——越序预览同样制造
          // 叙事与状态分叉（模型拿着预览数据向用户描述未到阶段的发布）。
          const identity = stageIdentity();
          const orderGate = await stageToolOrderRejection(identity, 'prepare_publish');
          if (orderGate) return stageOrderGateResult(orderGate);
          const execution = await publishPreviewPort().preview(input.planId);
          if (!execution) {
            throw new Error('publish_preview_requires_confirmed_plan');
          }
          const preview: PublishExecutionProjection = execution;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'publish-execution', execution: publishExecutionCardProjection(preview) }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'inspect_geo_probe_samples',
        'Read real GEO probe evidence: up to limit samples from the latest frozen baseline round and from the latest post-publish monitoring round, each with the question, engine, truncated raw answer, deterministic analysis (competitorMentions, suspectedNegative) and citations. Read-only: it never starts probes and never changes any state. Use it to see what AI engines actually answered and to spot third-party brands that appear repeatedly. When a recurring third-party brand looks like a competitor, submit it with propose_brand_fact using predicate enterprise-profile.competitors (subject = the brand full name, value = string array of candidate names, excerpt = the answer passage where the name appears, origin = model-inferred) — you only ever propose; the user confirms or rejects on the knowledge confirmation card, so never claim a competitor is confirmed. competitorMentions only reflects the already-confirmed competitor list; suspectedNegative is a review lead, not a verdict — quote the passage and let the user judge.',
        {
          limit: z
            .number()
            .int()
            .min(1)
            .max(GEO_PROBE_SAMPLE_LIMIT_MAX)
            .optional()
            .describe('Samples per round (baseline and monitoring each). Default 6, max 12.'),
        },
        async (input) => {
          try {
            const report = await inspectGeoProbeSamples({ limit: input.limit });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(report) }],
            };
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(geoProbeSamplesFailure(error)) },
              ],
            };
          }
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
