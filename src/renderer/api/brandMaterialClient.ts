import type {
  BrandMaterialProjection,
  MaterialProcessResult,
} from '../../shared/geo/materials';

export type BrandMaterialProcessResult = MaterialProcessResult<BrandMaterialProjection>;

export type TabApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface MaterialResponse<T> {
  success: boolean;
  result?: T;
  error?: string;
}

async function requireResult<T>(response: MaterialResponse<T>): Promise<T> {
  if (!response.success || response.result === undefined) {
    throw new Error(response.error ?? 'material_operation_failed');
  }
  return response.result;
}

export function importBrandMaterialFiles(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  sourcePaths: string[],
): Promise<BrandMaterialProcessResult[]> {
  return apiPost<MaterialResponse<BrandMaterialProcessResult[]>>(
    '/api/xiaojing/materials/import',
    { ...identity, input: { kind: 'files', sourcePaths } },
  ).then(requireResult);
}

export function importBrandMaterialText(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  text: string,
  displayName?: string,
): Promise<BrandMaterialProcessResult> {
  return apiPost<MaterialResponse<BrandMaterialProcessResult>>(
    '/api/xiaojing/materials/import',
    { ...identity, input: { kind: 'pasted-text', text, displayName } },
  ).then(requireResult);
}

export function importBrandMaterialWebsite(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  url: string,
  signal?: AbortSignal,
): Promise<BrandMaterialProcessResult> {
  return apiPost<MaterialResponse<BrandMaterialProcessResult>>(
    '/api/xiaojing/materials/import',
    { ...identity, input: { kind: 'website-url', url } },
    { signal },
  ).then(requireResult);
}

export function retryBrandMaterial(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  materialId: string,
): Promise<BrandMaterialProcessResult> {
  return apiPost<MaterialResponse<BrandMaterialProcessResult>>(
    '/api/xiaojing/materials/retry',
    { ...identity, materialId },
  ).then(requireResult);
}
