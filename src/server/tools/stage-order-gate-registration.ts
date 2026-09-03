import type {
  AnyZodRawShape,
  InferShape,
  SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GEO_STAGE_ORDER_GATED_TOOLS,
  stageToolOrderRejection,
  type GeoStageOrderRejection,
} from "../geo/stage-order-gate";

/**
 * 顺序闸注册助手（票 01，spec 2026-09-03）：闸从五个阶段工具 handler 头部
 * 的同构插桩上移到注册缝——阶段工具经 stageOrderGatedTool 注册即在 handler
 * 一切工作之前自动过闸，新增阶段工具不再依赖「记得插桩」的人肉纪律（闸表
 * 已派生自 GEO_NEXT_STEP_GUIDES 值域减白名单，进 Guides 即自动入闸）。
 *
 * 闸的完整口径矩阵（裁决理由自票 05 五处插桩注释收拢于此，插桩删除后这里
 * 是唯一沉淀处；闸怎么判见 stage-order-gate.ts，本模块只管闸在哪里被调用）：
 *
 * - 闸先于 handler 一切工作：越序调用在任何业务工作（含缺省产品线回读、
 *   纯入参解析、执行段 begin 里程碑）之前被结构化拒绝——业务层放行越序
 *   调用而状态机纹丝不动，叙事与状态就此分叉（f74ce69e 实证）。
 * - prepare_publish 只读预览也闸：越序预览同样制造叙事与状态分叉（模型
 *   拿着预览数据向用户描述未到阶段的发布）。
 * - 拒绝不 throw 成 isError 单行文本：结构化指路信封（三态 requires_
 *   operation / out_of_order / unavailable，nextStep 引述或 heldStep 指引）
 *   直接作为工具内容返回，模型一次读明白、一次重试到位。
 * - 白名单两工具不闸（GEO_STAGE_ORDER_UNGATED_TOOLS，各有理由）：
 *   request_brand_material＝计划外补材料是合法入口；choose_next_round_
 *   knowledge＝知识段用户答复记录，无产物无花费，与材料类同口径。只读
 *   查询不进 Guides 值域、天然不闸：保护「先重读操作状态」纪律畅通。
 * - 唯一登记的行为偏离（spec 决策 2）：generate_articles 的「互斥入参
 *   错误 × 越序调用」交叉点从 isError 校验错变为闸拒绝信封——闸先于纯
 *   入参解析无条件统一成立，越序＋坏入参时给指路信封比给校验错更有用。
 * - 注册期 fail-loud：派生集外的工具名经本助手注册立即 throw——闸覆盖面
 *   是构造事实，误用在 createXiaojingGeoServer 构造期早死，不等到运行时。
 *
 * identity 经参数注入：调用方传既有 stageIdentity（闭包读 xiaojing-geo-tool
 * 的模块级 context 引用），wrapper 过闸与 handler 业务工作解析到同一份会话
 * 身份，不动组合根——stageToolOrderRejection 只要 identity，自带操作服务
 * 访问与 fail-closed（操作状态读不到时同样返回结构化拒绝，绝不半执行）。
 */

/** 阶段工具的注册材料：名/描述/schema/handler——除 identity（注入）与
 * 闸（本模块包上）之外，与裸 tool() 的注册参数同构。 */
export interface StageOrderGatedToolDef<Schema extends AnyZodRawShape> {
  name: string;
  description: string;
  schema: Schema;
  handler: (input: InferShape<Schema>) => Promise<CallToolResult>;
}

/** SDK 动态 import 到手的 `tool`（仅类型引用，模块顶层不触发 SDK 冷启动
 * 税；实例由调用方在 createXiaojingGeoServer 构造现场传入）。 */
export type StageToolFn = typeof tool;

/**
 * 顺序闸拒绝的工具结果（票 #05，自 xiaojing-geo-tool.ts 随迁）：结构化
 * 指路信封直接作为工具内容返回——当前步 + 应调工具 + 一句话指引，模型
 * 一次读明白、一次重试到位，不 throw 成 isError 单行文本。闸只覆盖派生
 * 表内的有后果阶段工具（GEO_STAGE_ORDER_GATED_TOOLS）；只读查询与白名单
 * 工具不经此路径。
 */
function stageOrderGateResult(rejection: GeoStageOrderRejection) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(rejection) }],
  };
}

/**
 * 注册一个被顺序闸包裹的阶段工具：内部完成闸调用＋拒绝信封构造，闸命中
 * 时 handler 不执行。toolFn 即 SDK 动态 import 到手的 `tool`；def＝名/
 * 描述/schema/handler；resolveIdentity 每次工具调用时解析会话身份（传
 * 既有 stageIdentity）。派生集外的工具名在此 throw（fail-loud）。
 */
export function stageOrderGatedTool<Schema extends AnyZodRawShape>(
  toolFn: StageToolFn,
  def: StageOrderGatedToolDef<Schema>,
  resolveIdentity: () => { workspaceId: string; sessionId: string },
): SdkMcpToolDefinition<Schema> {
  if (!GEO_STAGE_ORDER_GATED_TOOLS.includes(def.name)) {
    throw new Error(
      `stageOrderGatedTool: '${def.name}' is outside the derived stage-order gate table (GEO_NEXT_STEP_GUIDES value domain minus GEO_STAGE_ORDER_UNGATED_TOOLS). Read-only/material tools register with the plain tool() instead; widening the gate is a conscious decision that must update the derivation pin in stage-order-gate.unit.test.ts.`,
    );
  }
  return toolFn(
    def.name,
    def.description,
    def.schema,
    async (input) => {
      const rejection = await stageToolOrderRejection(
        resolveIdentity(),
        def.name,
      );
      if (rejection) return stageOrderGateResult(rejection);
      return def.handler(input);
    },
    { alwaysLoad: true },
  );
}
