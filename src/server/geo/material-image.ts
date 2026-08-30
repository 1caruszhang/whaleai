import {
  MATERIAL_IMAGE_CATEGORIES,
  materialImageCategoryCode,
  type MaterialImageCategoryCode,
} from "../../shared/geo/materialImages";

/**
 * 材料图片入池纪律（ADR-0008 Decision 2）：导入期视觉打标 + 两道代码层
 * 闸（小尺寸、图标装饰），任何一道不过或打标失败都降级为「该图不入池」，
 * 绝不阻塞材料导入本身。
 */

/** 入池最小边长（px）：图标、缩略图、装饰条在打标之前就挡下。 */
export const MATERIAL_IMAGE_MIN_DIMENSION = 200;

/** 送打标的最大字节：超过视觉模型输入上限的图降级不入池（同样不阻塞导入）。 */
export const MATERIAL_IMAGE_MAX_TAGGABLE_BYTES = 10 * 1024 * 1024;

/** 打标描述的入库上限（「一句中文」的宽裕边界；超长截断而不是丢图）。 */
export const MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS = 300;

export interface ImageDimensions {
  width: number;
  height: number;
}

export function materialImageMediaType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readBigEndianUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readLittleEndianUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function probePng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    return null;
  const width = readBigEndianUint32(bytes, 16);
  const height = readBigEndianUint32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (![0x47, 0x49, 0x46, 0x38].every((value, index) => bytes[index] === value))
    return null;
  const width = readLittleEndianUint16(bytes, 6);
  const height = readLittleEndianUint16(bytes, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG 的 SOF 段（帧头）标记集合；C4/C8/CC 是 DHT/JPG/DAC，不是帧头。 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
function probeJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) return null;
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 >= bytes.length) return null;
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function probeWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const riff = [0x52, 0x49, 0x46, 0x46].every(
    (value, index) => bytes[index] === value,
  );
  const webp = [0x57, 0x45, 0x42, 0x50].every(
    (value, index) => bytes[index + 8] === value,
  );
  if (!riff || !webp) return null;
  const fourcc = String.fromCharCode(
    bytes[12],
    bytes[13],
    bytes[14],
    bytes[15],
  );
  if (fourcc === "VP8X") {
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8 ") {
    // 帧头：3 字节 frame tag + 0x9D 0x01 0x2A 同步码，随后 14 位宽/高。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return null;
    const width = readLittleEndianUint16(bytes, 26) & 0x3fff;
    const height = readLittleEndianUint16(bytes, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8L" && bytes[20] === 0x2f) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * 从图片字节头探测像素尺寸（PNG IHDR / JPEG SOF / GIF 逻辑屏幕 /
 * WEBP VP8·VP8L·VP8X）。只读头部、不解码像素；任何缺头、截断、格式
 * 不符都返回 null，由调用方按「尺寸不可判 → 不入池」降级。
 */
export function probeImageDimensions(
  bytes: Uint8Array,
  fileExt: string,
): ImageDimensions | null {
  switch (fileExt.toLowerCase()) {
    case "png":
      return probePng(bytes);
    case "jpg":
    case "jpeg":
      return probeJpeg(bytes);
    case "gif":
      return probeGif(bytes);
    case "webp":
      return probeWebp(bytes);
    default:
      return null;
  }
}

/** 入池尺寸闸：两条边都不低于门槛；探测失败（null）不透传给打标。 */
export function isPoolableDimensions(
  dimensions: ImageDimensions | null,
): boolean {
  if (!dimensions) return false;
  return (
    dimensions.width >= MATERIAL_IMAGE_MIN_DIMENSION &&
    dimensions.height >= MATERIAL_IMAGE_MIN_DIMENSION
  );
}

/**
 * 打标提示词（ark lite 视觉调用契约）：只返回 JSON，描述一句中文，类型
 * 用六分类中文口径——图标装饰由调用方过滤，词表仍覆盖全集供模型选择。
 */
export function buildImageTaggingPrompt(): { system: string; prompt: string } {
  return {
    system: [
      "你是品牌配图候选池的图片打标引擎。看图后只返回 JSON，不要 markdown，不要解释。",
      '格式：{"description":"一句中文描述图片主体与场景","category":"分类"}',
      "category 只能取以下之一：产品实拍、环境、人物、图表、截图、图标装饰。",
      "分类口径：产品实拍=产品/菜品/设备/门店实物；环境=场景空间与活动现场；人物=以人为主体；",
      "图表=数据图表/示意图/流程图；截图=软件界面/网页/聊天记录；图标装饰=logo、二维码、图标、纹理、纯装饰元素。",
    ].join("\n"),
    prompt: "请对这张图片打标。",
  };
}

export interface MaterialImageTag {
  description: string;
  category: MaterialImageCategoryCode;
}

function extractJsonCandidate(raw: string): Record<string, unknown> | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const KNOWN_CATEGORY_CODES = new Set<string>(
  MATERIAL_IMAGE_CATEGORIES.map((item) => item.code as string),
);

/**
 * 按 Unicode 码点（而非 UTF-16 单元）截断：与 Rust 侧 `chars().take(N)`
 * 同口径，含 emoji（代理对）的描述两侧截出同一结果，不会把描述截成
 * 孤立代理项。
 */
function truncateByCodePoints(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : Array.from(value).slice(0, maxLength).join("");
}

/**
 * 解析打标响应。打标失败是降级路径（不入池、不阻塞导入），所以一切
 * 不合格输入都返回 null 而不是抛错；描述超长截断保图。
 */
export function parseImageTaggingResponse(
  raw: string,
): MaterialImageTag | null {
  const parsed = extractJsonCandidate(raw);
  if (!parsed) return null;
  if (typeof parsed.description !== "string") return null;
  const description = parsed.description.trim();
  if (!description) return null;
  if (typeof parsed.category !== "string") return null;
  const category =
    materialImageCategoryCode(parsed.category) ??
    (KNOWN_CATEGORY_CODES.has(parsed.category.trim())
      ? (parsed.category.trim() as MaterialImageCategoryCode)
      : null);
  if (!category) return null;
  return {
    description: truncateByCodePoints(
      description,
      MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS,
    ),
    category,
  };
}
