/**
 * 通用闸门修订分发骨架（ADR 0003）：聊天里的显式改/删/增指令经单一受限
 * 工具按闸门类型分发到对应域 owner。本模块持有分发契约、回执投影与工具
 * 纪律文案；知识闸门 handler 在此作为参考实现注册，后续闸门经
 * {@link registerGateRevisionHandler} 接入，无需改动工具契约。
 */

import {
  createKnowledgeAuthority,
  type KnowledgeRevisionInput,
} from './knowledge-authority';

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

/** 分发契约覆盖全部既有闸门；本票只注册知识 handler，其余闸门待接入。 */
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
  return 'revision_rejected';
}

/** 操作列表的结构校验；返回首个错误消息，合法则返回 null。 */
export function validateGateRevisionOperations(
  operations: GateRevisionOperation[],
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
      if (!operation.subject?.trim() || !operation.predicate?.trim()) {
        return `${label} (add) requires a subject and predicate`;
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
  const validationError = validateGateRevisionOperations(operations);
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

/** 卡片决策与聊天修订同源：指令都来自桌面前的用户本人。 */
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
