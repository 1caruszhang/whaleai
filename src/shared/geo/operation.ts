export const GEO_OPERATION_KINDS = [
  "knowledge-update",
  "question-opportunities",
  "article-generation",
  "performance-inspection",
  "distribution-planning",
  "publishing",
  "monitoring",
  "full-optimization",
  "next-round-optimization",
] as const;

export type GeoOperationKind = (typeof GEO_OPERATION_KINDS)[number];

export const GEO_OPERATION_STATUSES = [
  "ready",
  "queued",
  "running",
  "awaiting-confirmation",
  "paused",
  "recovering",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type GeoOperationStatus = (typeof GEO_OPERATION_STATUSES)[number];

export const GEO_OPERATION_STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "awaiting-confirmation",
  "succeeded",
  "failed",
  "skipped",
] as const;

export type GeoOperationStepStatus =
  (typeof GEO_OPERATION_STEP_STATUSES)[number];

/** 终态操作状态集：顺序闸、next-step 引述与跳过出口守卫的同口径判定。 */
export const TERMINAL_GEO_OPERATION_STATUSES: ReadonlySet<GeoOperationStatus> =
  new Set(["succeeded", "failed", "cancelled"]);

/** 「当前步」口径里视为已走完的步骤状态（failed 未走完——可引述重试）。 */
export const GEO_STEP_PAST_STATUSES: ReadonlySet<GeoOperationStepStatus> =
  new Set(["succeeded", "skipped"]);

/**
 * 计划序上首个未走完的步骤（failed 未走完——可引述指引重试）；全走完
 * 返回 null。顺序闸（票 #05）、next-step 引述与跳过出口（票 #07）共用
 * 同一「当前步」口径：业务层、状态机与信封引述不分叉。
 */
export function currentGeoOperationStep(
  steps: readonly GeoOperationStep[],
): GeoOperationStep | null {
  return steps.find((step) => !GEO_STEP_PAST_STATUSES.has(step.status)) ?? null;
}

/**
 * 运行中工作步骤的量化进度（如逐篇生成「3/5」）。只由 Sidecar 在步骤
 * running 期间上报；确认门与未开始步骤恒为 null。
 */
export interface GeoOperationStepProgress {
  current: number;
  total: number;
}

export const GEO_OPERATION_CAPABILITIES = [
  "brand-material-import",
  "brand-knowledge",
  "question-opportunities",
  "geo-observation",
  "content-planning",
  "content-production",
  "distribution-planning",
  "publishing",
  "monitoring",
  "geo-dashboard",
] as const;

export type GeoOperationCapability =
  (typeof GEO_OPERATION_CAPABILITIES)[number];

export const GEO_OPERATION_REFERENCE_KINDS = [
  "knowledge-version",
  "material",
  "question-pool",
  "baseline",
  "topic-plan",
  "article-operation",
  "article",
  "distribution-plan",
  "publish-execution",
  "monitor-plan",
  "operation",
  "report",
] as const;

export type GeoOperationReferenceKind =
  (typeof GEO_OPERATION_REFERENCE_KINDS)[number];

export interface GeoOperationReference {
  kind: GeoOperationReferenceKind;
  id: string;
  revision?: number;
}

export type GeoOperationRetryUnit =
  | "operation"
  | "article"
  | "probe"
  | "publish-item"
  | "monitor-item";

export type GeoOperationStepCondition =
  | "if-evidence-insufficient"
  | "if-knowledge-refresh-requested";

export type GeoOperationConfirmationKind =
  | "plan-ack"
  | "knowledge-change"
  | "next-round-knowledge"
  | "question-selection"
  | "baseline-probe"
  | "topic-plan"
  | "article-approval"
  | "distribution-plan"
  | "paid-publish"
  | "external-publish"
  | "monitoring-activation";

export type GeoOperationConfirmationAuthority =
  | "geo-operation"
  | "knowledge-authority"
  | "brand-workspace"
  | "publish-scheduler"
  | "post-publish-monitor";

export interface GeoOperationConfirmation {
  kind: GeoOperationConfirmationKind;
  authority: GeoOperationConfirmationAuthority;
  title: string;
  summary: string;
}

export interface GeoOperationStep {
  id: string;
  title: string;
  capability: GeoOperationCapability;
  status: GeoOperationStepStatus;
  requiresConfirmation: boolean;
  irreversible: boolean;
  retryUnit: GeoOperationRetryUnit;
  condition: GeoOperationStepCondition | null;
  confirmation: GeoOperationConfirmation | null;
  progress?: GeoOperationStepProgress | null;
}

export interface GeoOperationCheckpoint {
  activeStepId: string | null;
  completedStepIds: string[];
  completedUnitRefs: GeoOperationReference[];
  safeToResume: boolean;
  savedAt: string;
  /** Fences a checkpoint against a later resume/retry incarnation. */
  executionGeneration?: number;
  /** Process epoch that produced the checkpoint; Rust is the authority. */
  sidecarGeneration?: number;
  /** The smallest idempotent unit that may need to continue after recovery. */
  activeRetryUnit?: Exclude<GeoOperationRetryUnit, "operation">;
  activeUnitId?: string;
}

export interface GeoOperationError {
  code: string;
  message: string;
  retryable: boolean;
  unitId?: string;
}

export interface GeoArtifactFreshnessProjection {
  artifactId: string;
  status: "needs-confirmation";
  comparedToKnowledgeVersion: number;
  changedFactKeys: string[];
  markedAt: string;
}

export interface GeoOperationProjection {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: GeoOperationKind;
  goal: string;
  status: GeoOperationStatus;
  steps: GeoOperationStep[];
  inputRefs: GeoOperationReference[];
  artifactRefs: GeoOperationReference[];
  checkpoint: GeoOperationCheckpoint | null;
  pendingConfirmation: GeoOperationConfirmation | null;
  error: GeoOperationError | null;
  sourceOperationId: string | null;
  /** 本轮「是否更新品牌知识」的显式决策（票 #04，spec 2026-09-02）：
   * false = 复用轮（不更新知识，从问题池选择开始）；true = 更新轮；
   * null = 未决（下一轮分支门未回答）或不适用（直接意图）——起点推导
   * 读轮次时以此为准，不靠 kind 意图标签推断。 */
  updateKnowledge?: boolean | null;
  revision: number;
  executionGeneration: number;
  executionSidecarGeneration: number | null;
  queueReason: string | null;
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  /** 接管留痕（ADR-0010）：上一次所有权转移的原所有者与时间；
   * 从未被接管时为 null。sessionId 即当前所有者。 */
  takenOverFromSessionId?: string | null;
  takenOverAt?: string | null;
}

/** 接管回执（ADR-0010）：转移后的操作投影 + 留痕 + 随 operation 整体
 * 转移的工作集计数（未批准文章操作、awaiting-selection 池）。 */
export interface GeoOperationTakeoverReceipt {
  operation: GeoOperationProjection;
  previousOwnerSessionId: string;
  takenOverAt: string;
  transferredArticleOperations: number;
  transferredQuestionPools: number;
}

export interface GeoOperationPlan {
  kind: GeoOperationKind;
  goal: string;
  status: "ready" | "awaiting-confirmation";
  steps: GeoOperationStep[];
  inputRefs: GeoOperationReference[];
  pendingConfirmation: GeoOperationConfirmation | null;
  sourceOperationId?: string;
}

/** 跨会话未完成轮次「卡住步骤」的元信息：计划序上首个仍活跃的步骤。 */
export interface GeoOperationUnfinishedStuckStep {
  id: string;
  title: string;
  capability: GeoOperationCapability;
  status: GeoOperationStepStatus;
}

/**
 * 跨会话未完成轮次的只读元信息（ADR-0010 Decision 3；Rust store 投影）：
 * 六要素——类型、卡住步骤、待审数量、所属会话（= 当前所有者，接管后随之
 * 变化）、创建/更新时间、是否更新品牌知识（票 #04，见 updateKnowledge）。
 * 不含草稿正文与任何会话聊天记录（正文隔离保留在各领域 owned-or-approved
 * 投影）；待审数量 = 当前所有者会话名下 draft_ready 未批准文章篇数。
 */
export interface GeoOperationUnfinishedSummary {
  id: string;
  sessionId: string;
  kind: GeoOperationKind;
  goal: string;
  status: GeoOperationStatus;
  stuckStep: GeoOperationUnfinishedStuckStep | null;
  pendingConfirmation: GeoOperationConfirmation | null;
  pendingReviewCount: number;
  createdAt: string;
  updatedAt: string;
  /** 该轮是否更新品牌知识（票 #04）：false = 复用轮，true = 更新轮，
   * null = 未决/不适用/存量旧轮——与操作投影同语义。 */
  updateKnowledge?: boolean | null;
}

export interface PlanGeoOperationInput {
  intent: GeoOperationKind;
  goal: string;
  inputRefs?: GeoOperationReference[];
  sourceOperationId?: string;
  /**
   * 知识分支（票 02 归一，spec 2026-09-02）：`next-round-optimization`
   * 未携带时整单停在分支决策门；显式 false 时两个全链入口
   * （`full-optimization` 与 `next-round-optimization`）归一为同一
   * 「不更新知识」计划形状——起点为问题段、首工作步「从问题池选择」，
   * 不重走知识链。`full-optimization` 未携带或为真保持全链现状（既有
   * 调用方零破坏）。
   */
  updateKnowledge?: boolean;
  /**
   * 起点推导理由（ADR-0010 Decision 5，票 #27）：新轮次经「带推荐与理由
   * 的选项式询问」选定起点后由 agent 写入；只进入计划认可门 confirmation
   * 的 summary——用户在计划门上确认的是「从哪里开始、为什么」，绝不改写
   * 步骤序列或确认门位置。可选；空白视为未提供。
   */
  startingPointReason?: string;
  /**
   * 终点阶段（起止推导）：本轮在哪个阶段收尾。省略 = 意图的自然跨度
   * （单阶段意图一段；full/next-round 全链）。提供时必须是意图起点阶段
   * 的下游阶段，否则 geo_operation_ending_phase_invalid——起点与终点
   * 一起决定计划卡的步骤跨度，轮内不再为同一链条新起操作重复问
   * 「接下来做什么」。产物确认门位置不受影响。
   */
  endingPhase?: GeoOperationPhaseId;
  /**
   * 终点推导理由：与 startingPointReason 同款纪律，只进入计划认可门
   * summary。仅在携带 endingPhase 时允许提供。
   */
  endingPointReason?: string;
}

interface StepDefinition {
  id: string;
  title: string;
  capability: GeoOperationCapability;
  confirmation?: GeoOperationConfirmation;
  irreversible?: boolean;
  retryUnit?: GeoOperationRetryUnit;
  condition?: GeoOperationStepCondition;
}

function confirmation(
  kind: GeoOperationConfirmationKind,
  authority: GeoOperationConfirmationAuthority,
  title: string,
  summary: string,
): GeoOperationConfirmation {
  return { kind, authority, title, summary };
}

function steps(definitions: readonly StepDefinition[]): GeoOperationStep[] {
  return definitions.map((step, index) => ({
    id: step.id,
    title: step.title,
    capability: step.capability,
    status: index === 0 ? "ready" : "pending",
    requiresConfirmation: step.confirmation !== undefined,
    irreversible: step.irreversible ?? false,
    retryUnit: step.retryUnit ?? "operation",
    condition: step.condition ?? null,
    confirmation: step.confirmation ?? null,
    progress: null,
  }));
}

const KNOWLEDGE_STEPS: readonly StepDefinition[] = [
  {
    id: "collect-materials",
    title: "收集品牌材料",
    capability: "brand-material-import",
  },
  {
    id: "extract-facts",
    title: "提取候选事实",
    capability: "brand-knowledge",
  },
  {
    id: "confirm-knowledge",
    title: "确认知识变更",
    capability: "brand-knowledge",
    confirmation: confirmation(
      "knowledge-change",
      "knowledge-authority",
      "确认品牌知识变更",
      "候选事实和冲突必须由你逐项裁决，确认前不会写入权威知识。",
    ),
  },
];

/**
 * 知识段步骤 id 集（geo-plan-normalization 票 07）：材料收集 / 事实提取 /
 * 知识确认。跳过出口的计划替换以此判定「知识段剩余步骤」——从
 * KNOWLEDGE_STEPS 派生，知识段改形状时自动跟随。
 */
export const KNOWLEDGE_SEGMENT_STEP_IDS: ReadonlySet<string> = new Set(
  KNOWLEDGE_STEPS.map((definition) => definition.id),
);

const QUESTION_STEPS: readonly StepDefinition[] = [
  {
    id: "generate-question-pool",
    title: "生成问题机会",
    capability: "question-opportunities",
  },
  {
    id: "confirm-question-selection",
    title: "确认问题选择",
    capability: "question-opportunities",
    confirmation: confirmation(
      "question-selection",
      "brand-workspace",
      "确认问题选择",
      "只有显式选中的问题会进入后续基线和内容规划。",
    ),
  },
];

/**
 * Baseline probing is deliberately NOT part of the composed main chain: it is
 * an on-demand action behind the brand-level "效果" entry (or the direct
 * performance-inspection intent), because post-publish monitoring freezes its
 * own baseline reference anyway. The probe gate definitions live inline in the
 * performance-inspection branch below.
 */

const CONTENT_STEPS: readonly StepDefinition[] = [
  {
    id: "plan-topics",
    title: "规划主题、类型与标题",
    capability: "content-planning",
  },
  {
    id: "confirm-content-plan",
    title: "确认内容计划",
    capability: "content-planning",
    confirmation: confirmation(
      "topic-plan",
      "brand-workspace",
      "确认内容计划",
      "只有已批准并选中的主题计划项会进入文章生成。",
    ),
  },
  {
    id: "generate-articles",
    title: "生成文章",
    capability: "content-production",
    retryUnit: "article",
  },
  {
    id: "confirm-articles",
    title: "确认文章",
    capability: "content-production",
    retryUnit: "article",
    confirmation: confirmation(
      "article-approval",
      "brand-workspace",
      "审核并批准文章",
      "草稿、事实与双质量门结果必须由你审核；批准后保存不可变历史副本。",
    ),
  },
];

const DIRECT_ARTICLE_STEPS: readonly StepDefinition[] = CONTENT_STEPS.slice(2);

const DISTRIBUTION_STEPS: readonly StepDefinition[] = [
  {
    id: "plan-distribution",
    title: "制定分发计划",
    capability: "distribution-planning",
  },
  {
    id: "confirm-distribution",
    title: "确认分发计划",
    capability: "distribution-planning",
    confirmation: confirmation(
      "distribution-plan",
      "brand-workspace",
      "确认分发计划",
      "请确认文章、渠道、预算与发布时间；此步骤不会下单或发布。",
    ),
  },
];

const PUBLISH_STEPS: readonly StepDefinition[] = [
  {
    id: "prepare-publish",
    title: "核对发布项目与费用",
    capability: "publishing",
  },
  {
    id: "confirm-publish",
    title: "确认付费外部发布",
    capability: "publishing",
    irreversible: true,
    retryUnit: "publish-item",
    confirmation: confirmation(
      "paid-publish",
      "publish-scheduler",
      "确认付费外部发布",
      "付费、上传和外部发布只能在 PublishScheduler 的用户界面确认，Agent 无权跨越。",
    ),
  },
  {
    id: "observe-publish",
    title: "跟踪已授权发布",
    capability: "publishing",
    retryUnit: "publish-item",
  },
];

const MONITOR_STEPS: readonly StepDefinition[] = [
  {
    id: "configure-monitoring",
    title: "配置发布后监测",
    capability: "monitoring",
  },
  {
    id: "confirm-monitoring",
    title: "确认监测计划",
    capability: "monitoring",
    confirmation: confirmation(
      "monitoring-activation",
      "post-publish-monitor",
      "确认监测计划",
      "请确认引擎、频率与结束条件；激活只能由用户界面完成。",
    ),
  },
  {
    id: "collect-monitoring-evidence",
    title: "收集真实监测证据",
    capability: "monitoring",
    retryUnit: "monitor-item",
  },
  {
    id: "report-monitoring",
    title: "生成证据化报告",
    capability: "geo-dashboard",
  },
];

const FULL_OPTIMIZATION_STEPS: readonly StepDefinition[] = [
  ...KNOWLEDGE_STEPS,
  ...QUESTION_STEPS,
  ...CONTENT_STEPS,
  ...DISTRIBUTION_STEPS,
  ...PUBLISH_STEPS,
  ...MONITOR_STEPS,
];

/**
 * 六阶段链序（与 GEO_OPERATION_PHASES 的展示分组同一词汇）。起止推导
 * （endingPhase）按这张表组合跨度：意图的起点段 + 下游各段，直到终点段。
 * 单一词汇源：`GeoOperationPhaseId` 联合类型与 MCP 层的 zod 枚举都从这
 * 张表派生，新增阶段只改这里。
 */
export const GEO_OPERATION_PHASE_ID_ORDER = [
  "knowledge",
  "questions",
  "content",
  "distribution",
  "publishing",
  "monitoring",
] as const;

export type GeoOperationPhaseId = (typeof GEO_OPERATION_PHASE_ID_ORDER)[number];

const PHASE_SEGMENTS: Record<GeoOperationPhaseId, readonly StepDefinition[]> = {
  knowledge: KNOWLEDGE_STEPS,
  questions: QUESTION_STEPS,
  content: CONTENT_STEPS,
  distribution: DISTRIBUTION_STEPS,
  publishing: PUBLISH_STEPS,
  monitoring: MONITOR_STEPS,
};

/**
 * 跨度组合：无终点时整段照用意图的自然跨度；带终点时起点段（缺省＝自然
 * 跨度，意图可用覆盖替换该段，如文章直达用 DIRECT_ARTICLE_STEPS 跳过已
 * 确认的计划步骤）+ 链序上直到终点段的各标准段。覆盖必须恰好覆盖
 * startPhase 一个阶段——多盖一段会让链序追加重复（无计划发布意图的自然
 * 跨度含两段，带终点时覆盖只留分发段）。终点不在起点严格下游（上游或
 * 同段，含 performance-inspection 等链外意图）直接 fail-loud——那不是
 * 跨度，是矛盾的输入；单阶段轮次省略 endingPhase，不用终点重申起点。
 */
function spanDefinitions(
  startPhase: GeoOperationPhaseId,
  endingPhase: GeoOperationPhaseId | undefined,
  naturalDefinitions: readonly StepDefinition[],
  startSegment: readonly StepDefinition[] = naturalDefinitions,
): readonly StepDefinition[] {
  if (!endingPhase) return naturalDefinitions;
  const startIndex = GEO_OPERATION_PHASE_ID_ORDER.indexOf(startPhase);
  const endIndex = GEO_OPERATION_PHASE_ID_ORDER.indexOf(endingPhase);
  if (endIndex <= startIndex) {
    throw new Error("geo_operation_ending_phase_invalid");
  }
  return [
    ...startSegment,
    ...GEO_OPERATION_PHASE_ID_ORDER.slice(startIndex + 1, endIndex + 1).flatMap(
      (phase) => PHASE_SEGMENTS[phase],
    ),
  ];
}

/**
 * 「不更新知识」轮次的起点段：问题段替换为「从池选择」——已有确认池直接
 * 复用重选（复用契约见 questionPool.ts），不重新生成池，也不重走知识链
 * （材料收集/事实提取/知识确认都不进计划）。
 */
const SELECT_NEXT_QUESTION_STEP: StepDefinition = {
  id: "select-next-question-pool",
  title: "从问题池选择下一轮问题",
  capability: "question-opportunities",
  confirmation: confirmation(
    "question-selection",
    "brand-workspace",
    "选择下一轮问题",
    "本轮不更新知识，请从已有问题池明确选择后续问题。",
  ),
};

/**
 * 「不更新知识」轮次的计划跨度（票 02 归一的单一事实源）：起点段＝从池
 * 选择，其余段按六阶段链序跟随；带终点时从选择步起截到终点段为止。
 * 两个全链入口（full-optimization 显式 false 与 next-round-optimization
 * 的同名分支）都从这里拿步骤序列，杜绝双入口漂移；跨度裁决按归一后的
 * 起点段（questions）判下游。
 */
function noUpdateKnowledgeDefinitions(
  endingPhase: GeoOperationPhaseId | undefined,
): readonly StepDefinition[] {
  return spanDefinitions(
    "questions",
    endingPhase,
    [
      SELECT_NEXT_QUESTION_STEP,
      ...CONTENT_STEPS,
      ...DISTRIBUTION_STEPS,
      ...PUBLISH_STEPS,
      ...MONITOR_STEPS,
    ],
    [SELECT_NEXT_QUESTION_STEP],
  );
}

/**
 * 全链跨度（知识段起步）：full-optimization 未携带/为真与
 * next-round-optimization「更新知识」分支共用；带终点 = 截尾。
 */
function fullChainDefinitions(
  endingPhase: GeoOperationPhaseId | undefined,
): readonly StepDefinition[] {
  return spanDefinitions(
    "knowledge",
    endingPhase,
    FULL_OPTIMIZATION_STEPS,
    KNOWLEDGE_STEPS,
  );
}

/** 终点推导理由的归一：与起点理由同款纪律；无 endingPhase 时拒绝提供。 */
function endingPointReasonOf(
  reason: string | undefined,
  endingPhase: GeoOperationPhaseId | undefined,
): string | null {
  const value = reason?.trim();
  if (!endingPhase && value) {
    throw new Error("geo_operation_ending_point_reason_invalid");
  }
  if (!value) return null;
  if ([...value].length > SPAN_POINT_REASON_MAX_CHARS) {
    throw new Error("geo_operation_ending_point_reason_invalid");
  }
  return value;
}

/** 终点在计划认可门上的一句话（阶段口语名 + 可选理由）。 */
function endingStatement(
  endingPhase: GeoOperationPhaseId | undefined,
  reason: string | null,
): string | null {
  if (!endingPhase) return null;
  const title =
    GEO_OPERATION_PHASES.find((phase) => phase.id === endingPhase)?.title ??
    endingPhase;
  return reason ? `${title}——${reason}` : title;
}

function cloneRefs(
  refs: readonly GeoOperationReference[] | undefined,
): GeoOperationReference[] {
  return (refs ?? []).map((reference) => ({ ...reference }));
}

function requireGoal(goal: string): string {
  const value = goal.trim();
  if (!value || [...value].length > 500) {
    throw new Error("geo_operation_goal_invalid");
  }
  return value;
}

const SPAN_POINT_REASON_MAX_CHARS = 300;

/**
 * 起点推导理由的归一：空白视为未提供（保持认可门默认文案零漂移），
 * 超长按与 goal 同款纪律拒绝。上限收紧到 300 字：理由是一句话，不是
 * 计划复述。
 */
function startingPointReasonOf(reason: string | undefined): string | null {
  const value = reason?.trim();
  if (!value) return null;
  if ([...value].length > SPAN_POINT_REASON_MAX_CHARS) {
    throw new Error("geo_operation_starting_point_reason_invalid");
  }
  return value;
}

function nextRoundKnowledgeDecision(): GeoOperationConfirmation {
  return confirmation(
    "next-round-knowledge",
    "brand-workspace",
    "下一轮是否更新品牌知识？",
    "不更新将从问题池选择开始；更新后将从知识链路起点开始。效果报告只作上下文，不决定分支。",
  );
}

/**
 * Every executable plan parks at the plan acknowledgement gate before any
 * stage runs: the progress card broadcasts the plan, the user releases it
 * once, then each stage still stops at its own consequential gate. The step
 * borrows the first work step's capability so it groups into the opening
 * phase instead of a stray「其他」group. The optional starting-point
 * derivation reason (ticket #27, ADR-0010 Decision 5) and the ending
 * statement only enrich the summary text so the gate shows where the round
 * starts, where it ends and why — the gate positions never change.
 */
function planAckStep(
  capability: GeoOperationCapability,
  startingPointReason: string | undefined,
  ending: string | null,
): StepDefinition {
  const reason = startingPointReasonOf(startingPointReason);
  const releaseSummary =
    "查看上方阶段与步骤计划后放行；各阶段的产物仍会停在各自的确认门。";
  const lead = [
    reason ? `从哪里开始：${reason}。` : null,
    ending ? `到哪里结束：${ending}。` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("");
  return {
    id: "acknowledge-plan",
    title: "认可本轮计划",
    capability,
    confirmation: confirmation(
      "plan-ack",
      "geo-operation",
      "认可本轮计划",
      `${lead}${releaseSummary}`,
    ),
  };
}

/**
 * The only intent-to-operation policy. Direct intents plan one capability
 * slice; full optimization composes the exact same definitions and gates.
 * Every decided plan starts with the plan acknowledgement gate.
 */
export function planGeoOperation(
  input: PlanGeoOperationInput,
): GeoOperationPlan {
  const goal = requireGoal(input.goal);
  const inputRefs = cloneRefs(input.inputRefs);
  const common = {
    goal,
    inputRefs,
    sourceOperationId: input.sourceOperationId,
  };

  if (
    input.intent === "next-round-optimization" &&
    input.updateKnowledge === undefined
  ) {
    // 分支未决时没有可裁量的跨度：终点只能等知识分支定了再带。
    if (input.endingPhase) {
      throw new Error("geo_operation_ending_phase_invalid");
    }
    const pendingConfirmation = nextRoundKnowledgeDecision();
    return {
      ...common,
      kind: input.intent,
      status: "awaiting-confirmation",
      steps: [
        {
          id: "decide-knowledge-refresh",
          title: "确认是否更新品牌知识",
          capability: "brand-knowledge",
          status: "awaiting-confirmation",
          requiresConfirmation: true,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: pendingConfirmation,
        },
      ],
      pendingConfirmation,
    };
  }

  let definitions: readonly StepDefinition[];
  switch (input.intent) {
    case "knowledge-update":
      definitions = spanDefinitions(
        "knowledge",
        input.endingPhase,
        KNOWLEDGE_STEPS,
      );
      break;
    case "question-opportunities":
      definitions = spanDefinitions(
        "questions",
        input.endingPhase,
        QUESTION_STEPS,
      );
      break;
    case "article-generation":
      definitions = spanDefinitions(
        "content",
        input.endingPhase,
        DIRECT_ARTICLE_STEPS,
      );
      break;
    case "performance-inspection":
      if (input.endingPhase) {
        // 链外意图：效果巡检不落六阶段链，没有「下游」可言。
        throw new Error("geo_operation_ending_phase_invalid");
      }
      definitions = [
        {
          id: "load-real-evidence",
          title: "读取现有真实证据",
          capability: "geo-dashboard",
        },
        {
          id: "confirm-missing-evidence-probe",
          title: "确认是否补充缺失探测",
          capability: "geo-observation",
          condition: "if-evidence-insufficient",
          confirmation: confirmation(
            "baseline-probe",
            "brand-workspace",
            "是否补充缺失探测？",
            "现有证据不足时才需要补充；请确认问题、引擎和 Provider 用量。",
          ),
        },
        {
          id: "probe-missing-evidence",
          title: "补充必要探测",
          capability: "geo-observation",
          retryUnit: "probe",
          condition: "if-evidence-insufficient",
        },
        {
          id: "report-performance",
          title: "生成证据化结果",
          capability: "geo-dashboard",
        },
      ];
      break;
    case "distribution-planning":
      definitions = spanDefinitions(
        "distribution",
        input.endingPhase,
        DISTRIBUTION_STEPS,
      );
      break;
    case "publishing":
      // 引用已确认分发计划时从发布段起步；否则分发段先补（无计划可消费）。
      // 两种起点的 endingPhase 校验都按实际起点段裁决；无计划分支的自然
      // 跨度含分发+发布两段，带终点时覆盖只留分发段，发布段由链序追加。
      definitions = inputRefs.some(
        (reference) => reference.kind === "distribution-plan",
      )
        ? spanDefinitions("publishing", input.endingPhase, PUBLISH_STEPS)
        : spanDefinitions(
            "distribution",
            input.endingPhase,
            [...DISTRIBUTION_STEPS, ...PUBLISH_STEPS],
            DISTRIBUTION_STEPS,
          );
      break;
    case "monitoring":
      definitions = spanDefinitions(
        "monitoring",
        input.endingPhase,
        MONITOR_STEPS,
      );
      break;
    case "full-optimization":
      // 归一（票 02）：全链意图显式「不更新知识」时与下一轮优化的同名
      // 分支完全同形——从问题池选择起步，不重走知识链；未携带或为真保持
      // 全链现状（带终点 = 截尾，如「只做到文章为止」；不带 = 完整六段）。
      // 注意守卫是 === false：undefined 在全链入口意味着「未表达」而非
      // 「不更新」，必须留在全链现状。
      definitions =
        input.updateKnowledge === false
          ? noUpdateKnowledgeDefinitions(input.endingPhase)
          : fullChainDefinitions(input.endingPhase);
      break;
    case "next-round-optimization":
      // 走到这里分支已决（undefined 在 switch 前停在分支决策门）：真值 =
      // 更新知识，与全链同构（带终点 = 截尾）；假值 = 从池选择起步
      // （与全链显式 false 同一份构造）。
      definitions = input.updateKnowledge
        ? fullChainDefinitions(input.endingPhase)
        : noUpdateKnowledgeDefinitions(input.endingPhase);
      break;
  }

  const plannedSteps = steps([
    planAckStep(
      definitions[0].capability,
      input.startingPointReason,
      endingStatement(
        input.endingPhase,
        endingPointReasonOf(input.endingPointReason, input.endingPhase),
      ),
    ),
    ...definitions,
  ]);
  const firstConfirmation = plannedSteps[0]?.confirmation ?? null;
  if (firstConfirmation) {
    plannedSteps[0].status = "awaiting-confirmation";
  }
  return {
    ...common,
    kind: input.intent,
    status: firstConfirmation ? "awaiting-confirmation" : "ready",
    steps: plannedSteps,
    pendingConfirmation: firstConfirmation,
  };
}

export interface GeoOperationPhase {
  id: string;
  title: string;
  capabilities: GeoOperationCapability[];
}

/**
 * 阶段是步骤的唯一展示分组，六个阶段名与 Agent 口头汇报的环节名一一
 * 对应；聊天进度卡片与右侧工作台共用这份分组，避免两套词汇。
 */
export const GEO_OPERATION_PHASES: readonly GeoOperationPhase[] = [
  {
    id: "knowledge",
    title: "品牌知识",
    capabilities: ["brand-material-import", "brand-knowledge"],
  },
  {
    id: "questions",
    title: "问题机会",
    capabilities: ["question-opportunities"],
  },
  {
    id: "content",
    title: "内容生产",
    capabilities: ["content-planning", "content-production"],
  },
  {
    id: "distribution",
    title: "渠道计划",
    capabilities: ["distribution-planning"],
  },
  { id: "publishing", title: "发布", capabilities: ["publishing"] },
  {
    id: "monitoring",
    title: "监测",
    capabilities: ["monitoring", "geo-dashboard"],
  },
];

export interface GeoOperationStepGroup {
  id: string;
  title: string;
  steps: GeoOperationStep[];
}

/**
 * 步骤按阶段分组的展示投影，只保留有步骤的阶段；未匹配任何阶段的
 * 步骤落入末尾「其他」组，防御残缺投影而不是静默丢弃步骤。
 */
export function groupGeoOperationSteps(
  steps: readonly GeoOperationStep[],
): GeoOperationStepGroup[] {
  const groups = GEO_OPERATION_PHASES.map((phase) => ({
    id: phase.id,
    title: phase.title,
    steps: steps.filter((step) => phase.capabilities.includes(step.capability)),
  })).filter((group) => group.steps.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.steps));
  const leftovers = steps.filter((step) => !grouped.has(step));
  if (leftovers.length > 0) {
    groups.push({ id: "other", title: "其他", steps: leftovers });
  }
  return groups;
}

/** capability → 阶段的反查：跨度标签端点归段用（不命中返回 undefined）。 */
function phaseOfCapability(
  capability: GeoOperationCapability,
): GeoOperationPhase | undefined {
  return GEO_OPERATION_PHASES.find((phase) =>
    phase.capabilities.includes(capability),
  );
}

/**
 * 结构派生的跨度标签（ADR-0011 Decision 4）：起点取首个工作步骤
 * capability 映射的阶段名（认可门借用首步 capability，同段）；终点取
 * 计划末步映射的阶段名——带 endingPhase 组合的跨度恰好收在终点段，
 * 不带时即自然跨度末段。起终同段只报一个段名；端点 capability 不落
 * 任何阶段（残缺投影的防御分支）返回 null，调用方不渲染——
 * 跨度只从结构读出，不靠 goal 措辞或门序猜测。
 */
export function formatGeoOperationSpanLabel(
  steps: readonly GeoOperationStep[],
): string | null {
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first || !last) return null;
  const startPhase = phaseOfCapability(first.capability);
  const endPhase = phaseOfCapability(last.capability);
  if (!startPhase || !endPhase) return null;
  return startPhase.id === endPhase.id
    ? `跨度：${startPhase.title}`
    : `跨度：${startPhase.title} → ${endPhase.title}`;
}

/** 阶段状态：任一步骤失败即失败；全部完成才算完成；否则取首个活跃状态。 */
export function geoOperationPhaseStatus(
  steps: readonly GeoOperationStep[],
): GeoOperationStepStatus {
  if (steps.length === 0) return "pending";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (
    steps.every(
      (step) => step.status === "succeeded" || step.status === "skipped",
    )
  ) {
    return "succeeded";
  }
  return (
    steps.find(
      (step) =>
        step.status === "running" ||
        step.status === "awaiting-confirmation" ||
        step.status === "ready",
    )?.status ?? "pending"
  );
}

/**
 * 当前真实活动 = 首个 running 工作步骤。确认门按状态机只会
 * pending → awaiting-confirmation → succeeded，因此 running 必然是
 * 正在执行的业务步骤（如逐篇生成文章）。
 */
export function runningGeoOperationStep(
  steps: readonly GeoOperationStep[],
): GeoOperationStep | null {
  return steps.find((step) => step.status === "running") ?? null;
}

/** 进度文案：有量化进度时输出「生成文章 3/5」，否则只输出步骤名。 */
export function formatGeoStepProgressNote(step: GeoOperationStep): string {
  if (!step.progress) return step.title;
  return `${step.title} ${step.progress.current}/${step.progress.total}`;
}

/** Deterministic fallback for tests and non-Agent import surfaces only. */
export function classifyGeoIntent(text: string): GeoOperationKind | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/下一轮|next\s+round/.test(normalized)) {
    return "next-round-optimization";
  }
  if (/完整.*geo|全流程|full.*geo/.test(normalized)) {
    return "full-optimization";
  }
  if (/更新.*知识|补充.*知识|update.*knowledge/.test(normalized)) {
    return "knowledge-update";
  }
  if (
    /生成.*(?:篇|文章)|写.*(?:篇|文章)|generate.*articles?/.test(normalized)
  ) {
    return "article-generation";
  }
  if (/问题池|问题机会|用户问题|question.*opportunit/.test(normalized)) {
    return "question-opportunities";
  }
  if (/分发计划|渠道计划|distribution.*plan/.test(normalized)) {
    return "distribution-planning";
  }
  if (/发布这些|发布文章|开始发布|publish/.test(normalized)) {
    return "publishing";
  }
  if (/监测|监控|monitor/.test(normalized)) return "monitoring";
  if (
    /geo.*(?:效果|表现)|(?:效果|表现).*geo|看.*效果|performance/.test(
      normalized,
    )
  ) {
    return "performance-inspection";
  }
  // Umbrella GEO requests without a named stage compose the full chain; the
  // confirmation gates on every consequential step keep that default safe.
  if (
    /geo|ai\s*搜索|搜索引擎/.test(normalized) &&
    /优化|营销|推广|曝光|排名/.test(normalized)
  ) {
    return "full-optimization";
  }
  return null;
}
