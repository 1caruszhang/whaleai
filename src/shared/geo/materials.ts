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
  /**
   * 材料投影的最近状态变更时刻（geo-plan-normalization 票 08）：服务端
   * 投影自始至终携带（Rust BrandMaterial.updated_at），共享类型此前未
   * 声明。终态行的该字段即「完成时刻」——Rust 在写终态的同一条 UPDATE
   * 里更新它；卡片时间戳只读这一字段，不造第二时间源。
   */
  updatedAt?: string;
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

/**
 * 单份文档的存量重扫结果（ADR-0008 T7）：只做图片腿——不 begin/finish
 * attempt、不产出知识候选，材料终态与画像事实原样保留。
 */
export interface MaterialRescanDocumentSummary {
  materialId: string;
  displayName: string;
  /** 本次新入池张数。 */
  pooled: number;
  /** sha256 已在池中（预扫命中或存储层唯一键去重）的张数。 */
  deduplicated: number;
  /** 因格式白名单/尺寸/打标/入库失败未入池的张数（降级，不报错）。 */
  degraded: number;
  /** 本份材料的时间预算耗尽，仍有图片未处理；再次触发可继续。 */
  budgetExhausted: boolean;
  /** 单份失败（如原始字节读不回）的固定错误码；成功时省略。 */
  errorCode?: MaterialErrorCode;
}

/** 存量材料手动重扫（workspace 内全部 docx/pptx）的一次通过结果。 */
export interface MaterialRescanResult {
  documents: MaterialRescanDocumentSummary[];
  /** 总时间预算耗尽，仍有文档未启动；幂等重扫可再次触发继续。 */
  budgetExhausted: boolean;
}
