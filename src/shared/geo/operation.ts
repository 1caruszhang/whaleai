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
  revision: number;
  executionGeneration: number;
  executionSidecarGeneration: number | null;
  queueReason: string | null;
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
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

export interface PlanGeoOperationInput {
  intent: GeoOperationKind;
  goal: string;
  inputRefs?: GeoOperationReference[];
  sourceOperationId?: string;
  /** Required only for the next-round branch. Undefined means ask first. */
  updateKnowledge?: boolean;
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
 * phase instead of a stray「其他」group.
 */
function planAckStep(capability: GeoOperationCapability): StepDefinition {
  return {
    id: "acknowledge-plan",
    title: "认可本轮计划",
    capability,
    confirmation: confirmation(
      "plan-ack",
      "geo-operation",
      "认可本轮计划",
      "查看上方阶段与步骤计划后放行；各阶段的产物仍会停在各自的确认门。",
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
      definitions = KNOWLEDGE_STEPS;
      break;
    case "question-opportunities":
      definitions = QUESTION_STEPS;
      break;
    case "article-generation":
      definitions = DIRECT_ARTICLE_STEPS;
      break;
    case "performance-inspection":
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
      definitions = DISTRIBUTION_STEPS;
      break;
    case "publishing":
      definitions = inputRefs.some(
        (reference) => reference.kind === "distribution-plan",
      )
        ? PUBLISH_STEPS
        : [...DISTRIBUTION_STEPS, ...PUBLISH_STEPS];
      break;
    case "monitoring":
      definitions = MONITOR_STEPS;
      break;
    case "full-optimization":
      definitions = FULL_OPTIMIZATION_STEPS;
      break;
    case "next-round-optimization":
      definitions = input.updateKnowledge
        ? FULL_OPTIMIZATION_STEPS
        : [
            {
              id: "select-next-question-pool",
              title: "从问题池选择下一轮问题",
              capability: "question-opportunities",
              confirmation: confirmation(
                "question-selection",
                "brand-workspace",
                "选择下一轮问题",
                "本轮不更新知识，请从已有问题池明确选择后续问题。",
              ),
            },
            ...CONTENT_STEPS,
            ...DISTRIBUTION_STEPS,
            ...PUBLISH_STEPS,
            ...MONITOR_STEPS,
          ];
      break;
  }

  const plannedSteps = steps([
    planAckStep(definitions[0].capability),
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
