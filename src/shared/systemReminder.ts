const OPEN = '<system-reminder>';
const CLOSE = '</system-reminder>';

/**
 * 信封引述的 next-step（ADR-0011 Decision 2）：从持久化计划引述的下一步
 * （工具名 + 一句话指引），随计划快照 revision 防过期。引述不是第二决策
 * 源——agent 先重读对应 owner 再照单执行，引述过期时以重读结果为准。
 */
export interface NextStepReminderInput {
  /** 所引述计划步骤的 step-id（重读后定位用）。 */
  stepId: string;
  /** MCP 工具名（next-step 单表与工具注册表的一致性测试保证真实存在）。 */
  tool: string;
  /** 一句话指引。 */
  guidance: string;
  /** 引述所基于的计划（GeoOperation）快照 revision。 */
  planRevision: number;
}

/** 决策回执指令的统一收尾：按引述执行，先重读再执行，不现场推导。
 * 只在信封确有引述时附加——收据形态（无 next-step）不带执行指令。 */
const NEXT_STEP_INSTRUCTION =
  'After re-reading the owning artifact/operation, execute the next-step quoted in this envelope as-is — do not re-derive what comes next.';

function instructionWithNextStep(
  base: string,
  nextStep: NextStepReminderInput | undefined,
): string {
  return nextStep ? `${base} ${NEXT_STEP_INSTRUCTION}` : base;
}

export interface KnowledgeDecisionReminderInput {
  candidateId: string;
  decision: string;
  status: string;
  factKey: string;
  currentVersion?: number | null;
  brandKnowledgeVersion?: number | null;
  nextStep?: NextStepReminderInput;
}

export interface QuestionPoolDecisionReminderInput {
  poolId: string;
  decisionId: string;
  revision: number;
  selectedCount: number;
  knowledgeVersion: number;
  nextStep?: NextStepReminderInput;
}

export interface TopicPlanDecisionReminderInput {
  planId: string;
  decisionId: string;
  revision: number;
  selectedCount: number;
  questionPoolId: string;
  questionPoolRevision: number;
  knowledgeVersion: number;
  nextStep?: NextStepReminderInput;
}

export interface ArticleApprovalDecisionReminderInput {
  operationId: string;
  articleId: string;
  status: string;
  revision: number;
  approvedRevision: number | null;
  knowledgeVersion: number;
  nextStep?: NextStepReminderInput;
}

export interface DistributionPlanDecisionReminderInput {
  planId: string;
  operationId: string;
  articleOperationId: string;
  status: string;
  revision: number;
  assignmentCount: number;
  nextStep?: NextStepReminderInput;
}

export interface GeoOperationEventReminderInput {
  workspaceId: string;
  sessionId: string;
  operationId: string;
  revision: number;
  action: string;
  status: string;
  nextStep?: NextStepReminderInput;
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function natural(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function envelope(kind: string, instruction: string, body: string[]): string {
  return [
    OPEN,
    `<${kind}>`,
    '<instruction>',
    instruction,
    '</instruction>',
    ...body,
    `</${kind}>`,
    CLOSE,
  ].join('\n');
}

function reminderVersion(value: number | null | undefined): string {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? String(value) : 'none';
}

/** next-step 引述块：无引述时返回空数组，信封退回收据形态。 */
function nextStepBlock(nextStep: NextStepReminderInput | undefined): string[] {
  if (!nextStep) return [];
  return [
    '<next-step>',
    `<step-id>${escape(nextStep.stepId)}</step-id>`,
    `<tool>${escape(nextStep.tool)}</tool>`,
    `<guidance>${escape(nextStep.guidance)}</guidance>`,
    `<plan-revision>${natural(nextStep.planRevision)}</plan-revision>`,
    '</next-step>',
  ];
}

function knowledgeDecisionItem(input: KnowledgeDecisionReminderInput): string[] {
  return [
      `<candidate-id>${escape(input.candidateId)}</candidate-id>`,
      `<decision>${escape(input.decision)}</decision>`,
      `<status>${escape(input.status)}</status>`,
      `<fact-key>${escape(input.factKey)}</fact-key>`,
      `<current-version>${reminderVersion(input.currentVersion)}</current-version>`,
      `<brand-knowledge-version>${reminderVersion(input.brandKnowledgeVersion)}</brand-knowledge-version>`,
  ];
}

export function buildKnowledgeDecisionReminder(input: KnowledgeDecisionReminderInput): string {
  return envelope(
    'XIAOJING_KNOWLEDGE_DECISION',
    instructionWithNextStep(
      'A structured brand-knowledge decision committed. Continue from the authoritative result; do not re-ask about this candidate.',
      input.nextStep,
    ),
    [
      '<decision-result>',
      ...knowledgeDecisionItem(input),
      '</decision-result>',
      ...nextStepBlock(input.nextStep),
    ],
  );
}

/** 批量确认卡的一次性提交：一条 reminder 汇总全部已裁决候选，避免逐条刷屏。 */
export function buildKnowledgeBatchDecisionReminder(
  inputs: KnowledgeDecisionReminderInput[],
  nextStep?: NextStepReminderInput,
): string {
  if (inputs.length === 0) return '';
  return envelope(
    'XIAOJING_KNOWLEDGE_DECISION',
    instructionWithNextStep(
      'Structured brand-knowledge decisions committed in one batch confirmation. Continue the current GEO operation from these authoritative results; do not re-ask about these candidates.',
      nextStep,
    ),
    [
      ...inputs.flatMap((input) => ['<decision-result>', ...knowledgeDecisionItem(input), '</decision-result>']),
      ...nextStepBlock(nextStep),
    ],
  );
}

export function buildQuestionPoolDecisionReminder(input: QuestionPoolDecisionReminderInput): string {
  return envelope(
    'XIAOJING_QUESTION_POOL_DECISION',
    instructionWithNextStep(
      'A structured GEO question-pool selection committed. Continue from this artifact; do not re-ask about the selection.',
      input.nextStep,
    ),
    [
      '<decision-result>',
      `<pool-id>${escape(input.poolId)}</pool-id>`,
      `<decision-id>${escape(input.decisionId)}</decision-id>`,
      `<revision>${natural(input.revision)}</revision>`,
      `<selected-count>${natural(input.selectedCount)}</selected-count>`,
      `<knowledge-version>${natural(input.knowledgeVersion)}</knowledge-version>`,
      '</decision-result>',
      ...nextStepBlock(input.nextStep),
    ],
  );
}

export function buildTopicPlanDecisionReminder(input: TopicPlanDecisionReminderInput): string {
  return envelope(
    'XIAOJING_TOPIC_PLAN_DECISION',
    instructionWithNextStep(
      'A structured GEO topic plan committed. Use only its selected items downstream; do not re-ask about this plan.',
      input.nextStep,
    ),
    [
      '<decision-result>',
      `<plan-id>${escape(input.planId)}</plan-id>`,
      `<decision-id>${escape(input.decisionId)}</decision-id>`,
      `<revision>${natural(input.revision)}</revision>`,
      `<selected-count>${natural(input.selectedCount)}</selected-count>`,
      `<question-pool-id>${escape(input.questionPoolId)}</question-pool-id>`,
      `<question-pool-revision>${natural(input.questionPoolRevision)}</question-pool-revision>`,
      `<knowledge-version>${natural(input.knowledgeVersion)}</knowledge-version>`,
      '</decision-result>',
      ...nextStepBlock(input.nextStep),
    ],
  );
}

export function buildArticleApprovalDecisionReminder(input: ArticleApprovalDecisionReminderInput): string {
  return envelope(
    'XIAOJING_ARTICLE_APPROVAL_DECISION',
    instructionWithNextStep(
      'A structured article review decision committed. Continue the current GEO operation from this authoritative review result — approved articles flow into distribution planning, a rejected article needs regeneration or user guidance; do not re-ask about this article.',
      input.nextStep,
    ),
    [
      '<decision-result>',
      `<operation-id>${escape(input.operationId)}</operation-id>`,
      `<article-id>${escape(input.articleId)}</article-id>`,
      `<status>${escape(input.status)}</status>`,
      `<revision>${natural(input.revision)}</revision>`,
      `<approved-revision>${reminderVersion(input.approvedRevision)}</approved-revision>`,
      `<knowledge-version>${natural(input.knowledgeVersion)}</knowledge-version>`,
      '</decision-result>',
      ...nextStepBlock(input.nextStep),
    ],
  );
}

export function buildDistributionPlanDecisionReminder(input: DistributionPlanDecisionReminderInput): string {
  return envelope(
    'XIAOJING_DISTRIBUTION_PLAN_DECISION',
    instructionWithNextStep(
      'A structured distribution plan confirmation committed. Continue the current GEO operation from this authoritative plan — publish preparation follows the confirmed assignments; do not re-ask about this plan.',
      input.nextStep,
    ),
    [
      '<decision-result>',
      `<plan-id>${escape(input.planId)}</plan-id>`,
      `<operation-id>${escape(input.operationId)}</operation-id>`,
      `<article-operation-id>${escape(input.articleOperationId)}</article-operation-id>`,
      `<status>${escape(input.status)}</status>`,
      `<revision>${natural(input.revision)}</revision>`,
      `<assignment-count>${natural(input.assignmentCount)}</assignment-count>`,
      '</decision-result>',
      ...nextStepBlock(input.nextStep),
    ],
  );
}

export function buildGeoOperationEventReminder(input: GeoOperationEventReminderInput): string {
  const nextStep = nextStepBlock(input.nextStep);
  return envelope(
    'XIAOJING_GEO_OPERATION_EVENT',
    nextStep.length > 0
      ? `A structured GEO workbench action committed. Re-read the operation, then execute the next-step quoted in this envelope as-is — no re-planning, no recap of finished steps, no re-deriving what comes next; stop only at the next confirmation gate.`
      : 'A structured GEO workbench action committed. Re-read the operation, then immediately execute the next planned step — no re-planning, no recap of finished steps; stop only at the next confirmation gate.',
    [
      '<operation-event>',
      `<workspace-id>${escape(input.workspaceId)}</workspace-id>`,
      `<session-id>${escape(input.sessionId)}</session-id>`,
      `<operation-id>${escape(input.operationId)}</operation-id>`,
      `<revision>${natural(input.revision)}</revision>`,
      `<action>${escape(input.action)}</action>`,
      `<status>${escape(input.status)}</status>`,
      '</operation-event>',
      ...nextStep,
    ],
  );
}

/** 决策回执类 reminder：会作为独立用户消息入队唤醒 Agent，renderer 需要投影成自然语言。 */
const DECISION_REMINDER_KINDS = [
  'XIAOJING_KNOWLEDGE_DECISION',
  'XIAOJING_QUESTION_POOL_DECISION',
  'XIAOJING_TOPIC_PLAN_DECISION',
  'XIAOJING_ARTICLE_APPROVAL_DECISION',
  'XIAOJING_DISTRIBUTION_PLAN_DECISION',
  'XIAOJING_GEO_OPERATION_EVENT',
] as const;

export type DecisionReminderKind = (typeof DECISION_REMINDER_KINDS)[number];

export interface ParsedDecisionReminder {
  kind: DecisionReminderKind;
  /** 仅 GEO_OPERATION_EVENT 携带：confirm-step:*、pause/resume/retry/cancel、next-round-*。 */
  action?: string;
}

function unescapeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 识别「整条消息就是一个决策回执 reminder 信封」的用户消息（builder 转义过的
 * 原文直接入队，不另带用户文本）。命中时 renderer 把它投影成自然语言气泡，
 * 信封原文仍保留在 transcript 供 LLM 消费；真实用户输入与其余形态返回 null。
 */
export function parseDecisionReminderText(text: string): ParsedDecisionReminder | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null;
  const kind = trimmed.match(/^<system-reminder>\s*<([A-Z0-9_]+)>/)?.[1];
  if (!kind || !(DECISION_REMINDER_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const action = trimmed.match(/<action>([^<]*)<\/action>/)?.[1];
  return {
    kind: kind as DecisionReminderKind,
    ...(action !== undefined ? { action: unescapeEntities(action) } : {}),
  };
}

export type SessionFileReminderStatus = 'readable' | 'binary' | 'imported';

export interface SessionFilesReminderFile {
  /** 工作区相对路径：`xiaojing_files/<sessionId>/<name>` */
  path: string;
  status: SessionFileReminderStatus;
}

export function buildSessionFilesReminder(files: SessionFilesReminderFile[]): string {
  if (files.length === 0) return '';
  return envelope(
    'XIAOJING_SESSION_FILES',
    'The user attached session files to this message. Read each readable file with read_session_file before judging its purpose, then act on your judgment directly: brand material goes through import_pasted_material (pass the content, displayName = original file name) and stops at the knowledge confirmation gate; conversation context stays in the current reply. A wrong call is cheap to correct at the gate — do not stop at an open-ended question. Once imported, query brand knowledge instead of re-reading the file.',
    [
      '<session-files>',
      ...files.map((file) => `<file status="${file.status}">${escape(file.path)}</file>`),
      '</session-files>',
      '<status-legend>',
      'readable = text file, call read_session_file (head is bounded; continue with offsetChars)',
      'binary = cannot be read directly; if it is brand material, call request_brand_material so the user uploads it on the chat material request card',
      'imported = already imported as brand material; query brand knowledge, do not re-read',
      '</status-legend>',
    ],
  );
}
