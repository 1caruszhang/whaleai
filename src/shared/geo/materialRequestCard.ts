import { unwrapToolResultText } from '../toolResult';

/**
 * 材料请求卡（ADR 0005）：agent 判断需要品牌材料时经
 * request_brand_material 工具在聊天流里发出的结构化卡片。卡体承载用户
 * 发起上传的全部路径与进行中行；卡片不提交结构化决策（裁决发生在导入
 * 产出的知识批量确认卡上），requiresUserDecision 只标记「不可被过程
 * 折叠」的渲染语义。
 */
export interface MaterialRequestCardData {
  kind: 'material-request-card';
  requiresUserDecision: true;
  /** agent 撰写的一行理由，说明为什么此刻需要材料；展示在卡头。 */
  reason: string;
}

export const MATERIAL_REQUEST_REASON_MAX_CHARS = 300;

export function buildMaterialRequestCardData(reason: string): MaterialRequestCardData {
  const normalized = reason.trim().slice(0, MATERIAL_REQUEST_REASON_MAX_CHARS);
  return {
    kind: 'material-request-card',
    requiresUserDecision: true,
    reason: normalized.length > 0 ? normalized : '请补充品牌材料',
  };
}

export function parseMaterialRequestCard(
  raw: string,
): MaterialRequestCardData | null {
  try {
    // MCP 结果可能是 content blocks 包装（`[{type:'text',text:...}]`），先剥壳。
    const parsed = JSON.parse(unwrapToolResultText(raw)) as MaterialRequestCardData;
    if (
      parsed?.kind === 'material-request-card'
      && parsed.requiresUserDecision === true
      && typeof parsed.reason === 'string'
      && parsed.reason.length > 0
      && parsed.reason.length <= MATERIAL_REQUEST_REASON_MAX_CHARS
    ) {
      return parsed;
    }
  } catch {
    // 未知工具结果走通用渲染。
  }
  return null;
}
