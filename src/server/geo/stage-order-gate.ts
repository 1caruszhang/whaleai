import type { GeoOperationProjection } from "../../shared/geo/operation";
import { createGeoOperationService } from "./operation";
import {
  currentGeoOperationStep,
  GEO_NEXT_STEP_GUIDES,
  quoteGeoNextStep,
  TERMINAL_OPERATION,
  type GeoNextStepQuotation,
} from "./operation-progress";

/**
 * 顺序闸覆盖的五个有后果阶段工具（票 #05，spec 2026-09-02 决策 4）：它们
 * 触发真实 Provider 花费或推进阶段产物，调用必须与「本会话非终态操作的
 * 当前步骤」对齐——否则业务层放行越序调用而状态机纹丝不动，叙事与状态
 * 就此分叉（f74ce69e 实证）。只读查询与材料类工具不闸：前者保护「先重读
 * 操作状态」纪律畅通，后者是计划外的合法补材料入口。
 */
export const GEO_STAGE_ORDER_GATED_TOOLS = [
  "run_question_pool",
  "plan_topics",
  "generate_articles",
  "plan_distribution",
  "prepare_publish",
] as const;

export type GeoStageOrderGatedTool = (typeof GEO_STAGE_ORDER_GATED_TOOLS)[number];

/** 与 operation.ts::recordConfirmedStep 同一对 Rust UI 确认 authority：付费/
 * 外部发布与监测激活的裁决面在产品界面，不在聊天卡片。 */
const RUST_UI_CONFIRMATION_AUTHORITIES = new Set([
  "publish-scheduler",
  "post-publish-monitor",
]);

/** 当前步不是 agent 工具步时的所停步骤：用户门等放行，或由其他通道推进。 */
export interface GeoStageOrderHeldStep {
  stepId: string;
  title: string;
  /** true = 用户确认门（等用户在聊天卡片上放行）；false = 由用户界面或
   * 自动里程碑等其他通道推进，聊天阶段工具无从插手。 */
  awaitingUser: boolean;
}

/**
 * 顺序闸的拒绝信封（票 #05）：既有失败投影先例（kind/ok/error/hint，参照
 * geoOperationControlFailure）叠 next-step 引述结构（当前步 + 应调工具 +
 * 一句话指引），不造新机制。error 判别三态：
 * requires_operation = 本会话没有非终态操作；out_of_order = 有操作但被调
 * 工具不是任何当前步的应调工具；unavailable = 操作状态读不到（闸 fail-closed，
 * 无状态依据不裁决顺序）。
 */
export type GeoStageOrderRejection =
  | {
      kind: "geo-stage-order-gate";
      ok: false;
      error: "geo_stage_tool_requires_operation";
      /** 被拒的阶段工具名。 */
      tool: string;
      hint: string;
    }
  | {
      kind: "geo-stage-order-gate";
      ok: false;
      error: "geo_stage_tool_out_of_order";
      tool: string;
      /** 当前步是 agent 工具步时：应调工具的引述（next-step 单表同源）。 */
      nextStep?: GeoNextStepQuotation;
      /** 当前步不是 agent 工具步时：所停步骤与等待原因（与 nextStep 互斥）。 */
      heldStep?: GeoStageOrderHeldStep;
      hint: string;
    }
  | {
      kind: "geo-stage-order-gate";
      ok: false;
      error: "geo_stage_order_unavailable";
      tool: string;
      hint: string;
    };

/**
 * 纯裁决：被调工具是否与本会话非终态操作的当前步骤对齐。返回 null = 放行；
 * 返回拒绝信封 = 结构化指路拒绝。
 *
 * 放行口径从宽：任一非终态操作的当前步（计划序上首个未走完步骤）的应调
 * 工具（next-step 单表）恰为被调工具即放行——多操作并存时闸的意义是拒绝
 * 明显越序，不是单选仲裁，先消灭误拒（接管续作、多轮并存）。拒绝引述锚定
 * updatedAt 最新的操作（与按门类引述 quoteNextStepForGate 同一先例）。
 */
export function assessStageToolOrder(
  tool: string,
  operations: readonly GeoOperationProjection[],
): GeoStageOrderRejection | null {
  const active = operations
    .filter((operation) => !TERMINAL_OPERATION.has(operation.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active.length === 0) {
    return {
      kind: "geo-stage-order-gate",
      ok: false,
      error: "geo_stage_tool_requires_operation",
      tool,
      hint: "本会话没有进行中的 GEO 操作：一切有后果的阶段工作都必须先经操作计划，真实 Provider 花费不绕过计划纪律。先用 inspect_geo_operations 核对本会话操作；确属新目标时与用户确认意图后用 start_geo_operation 创建操作；跨会话的未完成轮次经 inspect_brand_context 发现、经用户确认后用 takeover_geo_operation 接管续作。",
    };
  }
  const currents = active.map((operation) =>
    currentGeoOperationStep(operation.steps),
  );
  if (
    currents.some(
      (current) => current && GEO_NEXT_STEP_GUIDES[current.id]?.tool === tool,
    )
  ) {
    return null;
  }
  const newest = active[0];
  const current = currents[0];
  if (!current) {
    // 防御：非终态操作没有未走完步骤（Rust 收口时置终态，正常不可达）。
    return {
      kind: "geo-stage-order-gate",
      ok: false,
      error: "geo_stage_tool_out_of_order",
      tool,
      hint: "顺序闸拒绝：本会话最新的操作没有未走完的计划步骤。先用 inspect_geo_operations 查看其最新状态与 revision，再决定下一步。",
    };
  }
  const nextStep = quoteGeoNextStep(newest);
  if (nextStep) {
    return {
      kind: "geo-stage-order-gate",
      ok: false,
      error: "geo_stage_tool_out_of_order",
      tool,
      nextStep,
      hint: `顺序闸拒绝：当前计划步骤是「${current.title}」，应调工具是 ${nextStep.tool}。按 nextStep 引述执行（引述基于计划 revision ${nextStep.planRevision}，执行前先重读对应操作确认未过期），不要绕行其他阶段工具或自行跳步。`,
    };
  }
  const awaitingUser = current.confirmation !== null;
  const awaitingRustUi =
    awaitingUser &&
    RUST_UI_CONFIRMATION_AUTHORITIES.has(current.confirmation!.authority);
  return {
    kind: "geo-stage-order-gate",
    ok: false,
    error: "geo_stage_tool_out_of_order",
    tool,
    heldStep: {
      stepId: current.id,
      title: current.title,
      awaitingUser,
    },
    // 裁决面按 confirmation authority 区分：publish-scheduler /
    // post-publish-monitor 的授权在产品界面完成，指路不得说成聊天卡片。
    hint: awaitingRustUi
      ? `顺序闸拒绝：当前计划步骤「${current.title}」需要用户在产品界面完成确认（付费发布与监测激活的授权不在聊天卡片上）。请如实告知用户到哪里确认并等待；确认完成前不得调用任何阶段工具推进后续工作。`
      : awaitingUser
        ? `顺序闸拒绝：当前计划步骤「${current.title}」是用户确认门，正等待用户在聊天卡片上放行。请如实告知用户当前停靠点并等待；门放行前不得调用任何阶段工具推进后续工作。`
        : `顺序闸拒绝：当前计划步骤「${current.title}」不由聊天阶段工具推进（由用户界面或自动里程碑收尾）。先用 inspect_geo_operations 查看操作最新状态，待该步骤走完后再按计划继续。`,
  };
}

/**
 * 会话作用域的闸查询：只读本会话的操作（Rust list 的默认口径
 * includeAllSessions=false），接管后的操作归当前会话、自然在列，不误拒
 * 认领来的轮次。读取失败 fail-closed 成结构化拒绝——操作状态读不到就无从
 * 裁决顺序，不能放任有后果的阶段调用；重读指引与「先重读操作状态」纪律
 * 同向。
 */
export async function stageToolOrderRejection(
  identity: { workspaceId: string; sessionId: string },
  tool: GeoStageOrderGatedTool,
): Promise<GeoStageOrderRejection | null> {
  try {
    return assessStageToolOrder(
      tool,
      await createGeoOperationService(identity).list(),
    );
  } catch {
    return {
      kind: "geo-stage-order-gate",
      ok: false,
      error: "geo_stage_order_unavailable",
      tool,
      hint: "顺序闸暂时读不到本会话的操作状态，无法裁决阶段顺序。先用 inspect_geo_operations 重读；仍失败时如实告知用户并暂停阶段推进，不要在无状态依据时调用有后果的阶段工具。",
    };
  }
}
