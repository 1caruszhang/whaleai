export const MATERIAL_ERROR_CODES = [
  'material_type_unsupported',
  'material_import_failed',
  'material_content_unavailable',
  'material_parse_failed',
  'material_empty',
  'model_failed',
  'model_response_invalid',
  'no_facts_extracted',
  'knowledge_candidate_failed',
  'website_url_rejected',
  'website_redirect_rejected',
  'website_too_many_redirects',
  'website_fetch_failed',
  'website_too_large',
  'website_content_type_unsupported',
  'material_processing_failed',
  'material_identity_mismatch',
] as const;

export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];

export interface BrandMaterialProjection {
  id: string;
  workspaceId: string;
  inputKind: 'file' | 'pasted-text' | 'website-url';
  displayName: string;
  status: 'stored' | 'processing' | 'awaiting-confirmation' | 'processed' | 'failed';
  attemptCount: number;
  lastErrorCode?: string | null;
}

export interface MaterialProcessSuccess<TMaterial = unknown> {
  ok: true;
  material: TMaterial;
  candidateIds: string[];
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
