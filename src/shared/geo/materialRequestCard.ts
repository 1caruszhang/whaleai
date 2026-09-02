import { unwrapToolResultText } from '../toolResult';

/**
 * 材料请求卡（ADR 0005）：agent 判断需要品牌材料时经
 * request_brand_material 工具在聊天流里发出的结构化卡片。卡体承载用户
 * 发起上传的全部路径与进行中行；卡片不提交结构化决策（裁决发生在导入
 * 产出的知识批量确认卡上），requiresUserDecision 只标记「不可被过程
 * 折叠」的渲染语义。
 */
/**
 * 跳过出口锚定的操作身份（geo-plan-normalization 票 07）：卡片发出时
 * 服务端查得的本会话停在材料收集步骤的操作。跳过动作是 revision CAS 的
 * 计划替换，需要完整操作身份——workspaceId/sessionId 由渲染侧 Tab 上下文
 * 提供（与上传路径同一身份源），这里只嵌 operationId 与发出时刻的
 * revision；若期间操作被推进，CAS 冲突会让跳过安全失败而不是覆盖。
 */
export interface MaterialRequestSkipTarget {
  operationId: string;
  expectedRevision: number;
}

export interface MaterialRequestCardData {
  kind: 'material-request-card';
  requiresUserDecision: true;
  /** agent 撰写的一行理由，说明为什么此刻需要材料；展示在卡头。 */
  reason: string;
  /**
   * 跳过出口的操作锚点（票 07）：null/缺省 = 计划外补材料入口（或存量
   * 转录卡片）——卡片照常承载上传，不呈现跳过动作。
   */
  skipTarget?: MaterialRequestSkipTarget | null;
}

export const MATERIAL_REQUEST_REASON_MAX_CHARS = 300;

/**
 * 材料收集触发契约（geo-plan-normalization 票 03 / Implementation
 * Decision 2，2026-09-02）：计划放行后执行到材料收集步骤即调用材料请求
 * 卡，不在调用现场重新权衡品牌知识是否够用——知识充分性只在起点推导
 * 判断一次，结果由计划形状承载（计划含材料收集步骤，执行中才走到该
 * 步）。触发条件不携带「品牌无已确认知识/知识明显撑不起目标」的现场
 * 限定词，拆除「更新知识」轮次里 next-step 信封与工具描述打架的同型
 * 冲突。同一话术必须逐字出现在三处：request_brand_material 工具描述、
 * next-step 单表的 collect-materials 条目、系统提示词材料段；改话术
 * 三处同改，由 MCP 集成测试（xiaojing-geo-material-contract）断言三处
 * 一致——模式对齐 QUESTION_POOL_REUSE_CONTRACT。
 */
export const MATERIAL_COLLECTION_CONTRACT =
  '计划放行后执行到材料收集步骤即调用材料请求卡，不在调用现场重新权衡品牌知识是否够用——知识充分性只在起点推导判断一次，结果由计划形状承载';

export function buildMaterialRequestCardData(
  reason: string,
  skipTarget: MaterialRequestSkipTarget | null = null,
): MaterialRequestCardData {
  const normalized = reason.trim().slice(0, MATERIAL_REQUEST_REASON_MAX_CHARS);
  return {
    kind: 'material-request-card',
    requiresUserDecision: true,
    reason: normalized.length > 0 ? normalized : '请补充品牌材料',
    skipTarget,
  };
}

function isMaterialRequestSkipTarget(
  value: unknown,
): value is MaterialRequestSkipTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.operationId === 'string'
    && target.operationId.length > 0
    && typeof target.expectedRevision === 'number'
    && Number.isInteger(target.expectedRevision)
    && target.expectedRevision >= 1
  );
}

export function parseMaterialRequestCard(
  raw: string,
): MaterialRequestCardData | null {
  try {
    // MCP 结果可能是 content blocks 包装（`[{type:'text',text:…}]`），先剥壳。
    const parsed = JSON.parse(unwrapToolResultText(raw)) as MaterialRequestCardData;
    if (
      parsed?.kind === 'material-request-card'
      && parsed.requiresUserDecision === true
      && typeof parsed.reason === 'string'
      && parsed.reason.length > 0
      && parsed.reason.length <= MATERIAL_REQUEST_REASON_MAX_CHARS
      && (parsed.skipTarget === undefined
        || parsed.skipTarget === null
        || isMaterialRequestSkipTarget(parsed.skipTarget))
    ) {
      return parsed;
    }
  } catch {
    // 未知工具结果走通用渲染。
  }
  return null;
}
