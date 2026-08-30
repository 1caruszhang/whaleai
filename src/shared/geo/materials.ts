import type {
  KnowledgeCardCandidate,
  KnowledgeCandidatesCardData,
} from "./knowledgeCard";

export const MATERIAL_ERROR_CODES = [
  'material_type_unsupported',
  'material_import_failed',
  // Renderer 传输层失败（代理超时/IPC/网络）：导入请求本身没有送达业务层，
  // 与服务端业务错误码严格区分。
  'material_request_failed',
  'material_content_unavailable',
  // management hop 的自由文本错误(传输层、SQLite 错误串)与 Rust 材料存储
  // 固定码:显式登记后可被 errorCode() 精确命中,不再落入泛化兜底。
  'material_management_failed',
  'material_management_unavailable',
  'material_source_rejected',
  'material_source_unreadable',
  'material_too_large',
  'material_store_failed',
  'material_hash_mismatch',
  'material_processing_unavailable',
  'material_input_kind_invalid',
  'material_text_size_invalid',
  'material_parse_failed',
  'material_empty',
  'material_not_found',
  'material_delete_failed',
  'material_processing_active',
  'model_failed',
  'model_response_invalid',
  'no_facts_extracted',
  'knowledge_candidate_failed',
  // 计费预扣/回报的 GatewayBillingError（insufficient_balance、网关不可达等）：
  // message 是自由中文文本，errorCode() 按类型归此码，不落泛化兜底。
  'material_billing_failed',
  'website_url_rejected',
  'website_redirect_rejected',
  'website_too_many_redirects',
  'website_fetch_failed',
  'website_too_large',
  'website_content_type_unsupported',
  'material_processing_failed',
  'material_identity_mismatch',
  // 材料图片入池元数据校验（ADR-0008）：分类/尺寸/描述不合入库约束。
  'material_image_invalid',
] as const;

export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];

export interface BrandMaterialProjection {
  id: string;
  workspaceId: string;
  inputKind: 'file' | 'pasted-text' | 'website-url';
  displayName: string;
  /** 小写扩展名：图片扩展名（png/jpg/jpeg/webp/gif）标识独立图片材料。 */
  fileExt: string;
  status: 'stored' | 'processing' | 'awaiting-confirmation' | 'processed' | 'failed';
  attemptCount: number;
  lastErrorCode?: string | null;
}

export interface MaterialProcessSuccess<TMaterial = unknown> {
  ok: true;
  material: TMaterial;
  candidateIds: string[];
  /** 卡片裁决所需的候选投影；失败结果没有该字段。 */
  candidates?: KnowledgeCardCandidate[];
  attemptNumber: number;
}

export interface MaterialProcessFailure {
  ok: false;
  materialId?: string;
  errorCode: MaterialErrorCode;
}

export type MaterialProcessResult<TMaterial = unknown> =
  | MaterialProcessSuccess<TMaterial>
  | MaterialProcessFailure;

/**
 * 导入/重试的异步启动结果（按输入顺序）：存储阶段成功进入后台抽取的
 * 材料，或存储阶段即失败（文件不可读、URL 被拒等）的固定错误码。
 */
export type MaterialImportEntry<TMaterial = unknown> =
  | { ok: true; material: TMaterial }
  | { ok: false; errorCode: MaterialErrorCode };

export interface MaterialImportStarted<TMaterial = unknown> {
  entries: MaterialImportEntry<TMaterial>[];
}

/** 状态轮询/会话恢复的单条结果；非处理中材料附带批量确认卡数据。 */
export interface MaterialStatusEntry<TMaterial = unknown> {
  material: TMaterial;
  card: KnowledgeCandidatesCardData | null;
}
