import type {
  BrandMaterialProjection,
  MaterialImportEntry,
  MaterialImportStarted,
  MaterialRescanResult,
  MaterialStatusEntry,
} from '../../shared/geo/materials';

export type BrandMaterialProcessResult = MaterialImportEntry<BrandMaterialProjection>;
export type BrandMaterialImportStarted = MaterialImportStarted<BrandMaterialProjection>;
export type BrandMaterialStatusEntry = MaterialStatusEntry<BrandMaterialProjection>;

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

/** 导入/重试的启动结果：存储完成、抽取在后台继续的条目（按输入顺序）。 */
async function importEntries(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  body: Record<string, unknown>,
): Promise<BrandMaterialProcessResult[]> {
  const started = await apiPost<MaterialResponse<BrandMaterialImportStarted>>(
    '/api/xiaojing/materials/import',
    { ...identity, ...body },
  ).then(requireResult);
  return started.entries;
}

export function importBrandMaterialFiles(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  sourcePaths: string[],
): Promise<BrandMaterialProcessResult[]> {
  return importEntries(apiPost, identity, { input: { kind: 'files', sourcePaths } });
}

export function importBrandMaterialText(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  text: string,
  displayName?: string,
): Promise<BrandMaterialProcessResult[]> {
  return importEntries(apiPost, identity, {
    input: { kind: 'pasted-text', text, ...(displayName ? { displayName } : {}) },
  });
}

export function importBrandMaterialWebsite(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  url: string,
): Promise<BrandMaterialProcessResult[]> {
  return importEntries(apiPost, identity, { input: { kind: 'website-url', url } });
}

export function retryBrandMaterial(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  materialId: string,
): Promise<BrandMaterialProcessResult[]> {
  return apiPost<MaterialResponse<BrandMaterialImportStarted>>(
    '/api/xiaojing/materials/retry',
    { ...identity, materialId },
  ).then(requireResult).then((started) => started.entries);
}

/** 删除材料本体（行 + 文件 + 未决候选）；已采纳进确认知识的裁决历史不动。 */
export async function deleteBrandMaterial(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  materialId: string,
): Promise<void> {
  await apiPost<MaterialResponse<{ materialId: string }>>(
    '/api/xiaojing/materials/delete',
    { ...identity, materialId },
  ).then(requireResult);
}

/**
 * 存量材料手动重扫（ADR-0008 T7）：对品牌内已导入的 docx/pptx 旧材料手动
 * 触发一次内嵌图提取（同步一次通过，预算截断幂等可续）。传输层失败以异常
 * 抛出，由调用方映射为 material_request_failed。
 */
export function rescanBrandMaterialImages(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<MaterialRescanResult> {
  return apiPost<MaterialResponse<MaterialRescanResult>>(
    '/api/xiaojing/materials/rescan-images',
    { ...identity },
  ).then(requireResult);
}

export interface MaterialImageContent {
  mediaType: string;
  /** 新建 Uint8Array（ArrayBuffer 支撑），可直接作为 BlobPart 建 object URL。 */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * 材料图片内容取回（ADR-0008 批准预览换 blob 的字节源）：经 Session 控制面
 * 由 Sidecar 转 T2 的 management images/content 端点（Rust 侧 sha256 校验）。
 * 字节以 base64 过控制面（单图 ≤10MB）。
 */
export async function fetchMaterialImageContent(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  imageId: string,
): Promise<MaterialImageContent> {
  const response = await apiPost<{
    success: boolean;
    image?: { imageId: string; mediaType: string; bytesB64: string };
    error?: string;
  }>('/api/xiaojing/material-images/content', { ...identity, imageId });
  if (!response.success || !response.image || response.image.imageId !== imageId) {
    throw new Error(response.error ?? 'material_image_content_failed');
  }
  const binary = atob(response.image.bytesB64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { mediaType: response.image.mediaType, bytes };
}

/**
 * 状态轮询/会话恢复。`materialIds` 提供时只查指定材料（处理中行的周期
 * 轮询）；缺省返回本 Session 最近材料（挂载时重建确认卡与在途行）。
 * 传输层失败以异常抛出，由调用方映射为 material_request_failed。
 */
export function fetchBrandMaterialStatuses(
  apiPost: TabApiPost,
  identity: { workspaceId: string; sessionId: string },
  materialIds?: string[],
): Promise<BrandMaterialStatusEntry[]> {
  return apiPost<{ success: boolean; materials?: BrandMaterialStatusEntry[]; error?: string }>(
    '/api/xiaojing/materials/status',
    {
      ...identity,
      ...(materialIds && materialIds.length > 0 ? { materialIds } : {}),
    },
  ).then((response) => {
    if (!response.success || !Array.isArray(response.materials)) {
      throw new Error(response.error ?? 'material_status_failed');
    }
    return response.materials;
  });
}
