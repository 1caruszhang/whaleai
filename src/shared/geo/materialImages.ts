/**
 * 材料图片（Material Image）契约（ADR-0008）：品牌材料导入时提取/直传的
 * 图片构成文章配图候选池。本文件只放跨端共享的词表与资产投影——提取、
 * 打标与持久化纪律在 server/geo/material-image.ts 与 Rust 材料存储侧。
 */

/** 可作为独立材料直传进入候选池的图片扩展名（小写）。 */
export const MATERIAL_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
] as const;

export type MaterialImageExtension = (typeof MATERIAL_IMAGE_EXTENSIONS)[number];

export function isMaterialImageExtension(extension: string): boolean {
  return (MATERIAL_IMAGE_EXTENSIONS as readonly string[]).includes(
    extension.toLowerCase(),
  );
}

/**
 * 视觉打标的类型分类（ADR-0008 Decision 2）。存储与跨端传输用稳定 code；
 * `label` 是打标提示词与界面展示用的中文口径。图标装饰不入池（代码层过滤），
 * 因此不会出现在资产表里，但词表保留它以覆盖打标输出的全集。
 */
export const MATERIAL_IMAGE_CATEGORIES = [
  { code: "product-photo", label: "产品实拍" },
  { code: "scene", label: "环境" },
  { code: "people", label: "人物" },
  { code: "chart", label: "图表" },
  { code: "screenshot", label: "截图" },
  { code: "icon-decoration", label: "图标装饰" },
] as const;

export type MaterialImageCategoryCode =
  (typeof MATERIAL_IMAGE_CATEGORIES)[number]["code"];

export function materialImageCategoryLabel(
  code: MaterialImageCategoryCode,
): string {
  return (
    MATERIAL_IMAGE_CATEGORIES.find((item) => item.code === code)?.label ?? code
  );
}

/** 中文标签 → 存储 code（打标模型按提示词输出中文口径）。 */
export function materialImageCategoryCode(
  label: string,
): MaterialImageCategoryCode | null {
  const trimmed = label.trim();
  return (
    MATERIAL_IMAGE_CATEGORIES.find((item) => item.label === trimmed)?.code ??
    null
  );
}

/** 材料图片资产（候选池条目）：原始字节持久化在 Rust 材料库，此处为投影。 */
export interface MaterialImageAsset {
  id: string;
  workspaceId: string;
  sha256: string;
  fileExt: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  /** 视觉打标产出的一句中文描述。 */
  description: string;
  category: MaterialImageCategoryCode;
  /** 提取来源材料的 id 与导入名（生成注入候选清单时展示来源）。 */
  sourceMaterialId: string;
  sourceMaterialName: string;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
}
