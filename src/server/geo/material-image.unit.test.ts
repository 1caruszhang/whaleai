import { describe, expect, it } from "vitest";

import {
  buildImageTaggingPrompt,
  isPoolableDimensions,
  materialImageMediaType,
  MATERIAL_IMAGE_MAX_TAGGABLE_BYTES,
  MATERIAL_IMAGE_MIN_DIMENSION,
  parseImageTaggingResponse,
  probeImageDimensions,
} from "./material-image";

/** 最小 PNG 头：签名 + IHDR 块头（长度/fourcc）即含宽高，其余字节与探测无关。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** JPEG：SOI + 一个量化段 + SOF0（含高宽）+ EOI。 */
function jpegBytes(width: number, height: number): Uint8Array {
  const sof = new Uint8Array([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x22,
    0x00,
  ]);
  const quant = new Uint8Array([0xff, 0xdb, 0x00, 0x02]);
  const bytes = new Uint8Array(2 + quant.length + sof.length + 2);
  bytes.set([0xff, 0xd8], 0);
  bytes.set(quant, 2);
  bytes.set(sof, 2 + quant.length);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 10);
  const w1 = width - 1;
  const h1 = height - 1;
  bytes[24] = w1 & 0xff;
  bytes[25] = (w1 >> 8) & 0xff;
  bytes[26] = (w1 >> 16) & 0xff;
  bytes[27] = h1 & 0xff;
  bytes[28] = (h1 >> 8) & 0xff;
  bytes[29] = (h1 >> 16) & 0xff;
  return bytes;
}

describe("probeImageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    expect(probeImageDimensions(pngBytes(1920, 1080), "png")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("reads JPEG dimensions from the first SOF segment", () => {
    expect(probeImageDimensions(jpegBytes(800, 600), "jpg")).toEqual({
      width: 800,
      height: 600,
    });
    expect(probeImageDimensions(jpegBytes(800, 600), "jpeg")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads GIF logical screen dimensions", () => {
    expect(probeImageDimensions(gifBytes(640, 480), "gif")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads WEBP VP8X canvas dimensions", () => {
    expect(probeImageDimensions(webpVp8xBytes(1024, 768), "webp")).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("returns null for truncated headers, mismatched extensions, and unknown formats", () => {
    expect(
      probeImageDimensions(pngBytes(10, 10).slice(0, 12), "png"),
    ).toBeNull();
    expect(probeImageDimensions(pngBytes(10, 10), "jpg")).toBeNull();
    expect(probeImageDimensions(new Uint8Array(64), "bmp")).toBeNull();
    expect(probeImageDimensions(new Uint8Array(0), "png")).toBeNull();
  });
});

describe("isPoolableDimensions", () => {
  it("requires both sides at or above the minimum dimension", () => {
    expect(isPoolableDimensions({ width: 200, height: 200 })).toBe(true);
    expect(isPoolableDimensions({ width: 199, height: 800 })).toBe(false);
    expect(isPoolableDimensions({ width: 800, height: 199 })).toBe(false);
    expect(isPoolableDimensions(null)).toBe(false);
    expect(MATERIAL_IMAGE_MIN_DIMENSION).toBe(200);
  });
});

describe("materialImageMediaType", () => {
  it("maps every poolable extension to its media type", () => {
    expect(materialImageMediaType("png")).toBe("image/png");
    expect(materialImageMediaType("jpg")).toBe("image/jpeg");
    expect(materialImageMediaType("jpeg")).toBe("image/jpeg");
    expect(materialImageMediaType("webp")).toBe("image/webp");
    expect(materialImageMediaType("gif")).toBe("image/gif");
  });
});

describe("buildImageTaggingPrompt", () => {
  const materialOnly = { sourceMaterialName: "品牌介绍.docx" };

  it("pins the JSON contract and the full category taxonomy", () => {
    const { system } = buildImageTaggingPrompt(materialOnly);
    expect(system).toContain("JSON");
    expect(system).toContain('{"description":"一句中文","category":"分类"}');
    for (const label of [
      "产品实拍",
      "环境",
      "人物",
      "图表",
      "截图",
      "图标装饰",
    ]) {
      expect(system).toContain(label);
    }
  });

  it("injects the source material name and brand name into both turns (票 #21)", () => {
    const { system, prompt } = buildImageTaggingPrompt({
      sourceMaterialName: "品牌介绍.docx",
      brandName: "蒸简单",
    });
    expect(system).toContain("品牌材料来源：《品牌介绍.docx》，品牌：蒸简单");
    // user prompt 不再是光杆一句：带上材料名与品牌名的语境。
    expect(prompt).toContain("《品牌介绍.docx》");
    expect(prompt).toContain("蒸简单");
    expect(prompt).not.toBe("请对这张图片打标。");
  });

  it("omits the brand segment entirely when no brand name is available", () => {
    const { system, prompt } = buildImageTaggingPrompt(materialOnly);
    expect(system).toContain("品牌材料来源：《品牌介绍.docx》");
    // 「品牌：」段与 user prompt 的品牌实名引用都不得出现（泛词「品牌材料」不算）。
    expect(system).not.toContain("，品牌：");
    expect(prompt).toContain("《品牌介绍.docx》");
    expect(prompt).not.toContain("品牌「");
  });

  it("tells the model the reader is the article generator and the description must carry a usage position", () => {
    const { system } = buildImageTaggingPrompt(materialOnly);
    expect(system).toContain("文章生成模型");
    expect(system).toContain("语义相关性");
    expect(system).toContain("用途定位");
    expect(system).toContain("适合菜品介绍段落配图");
  });

  it("classifies storefront/stall/dining-area shots as 环境 and drops the old storefront-as-product wording", () => {
    const { system } = buildImageTaggingPrompt(materialOnly);
    // 口径修正（票 #21）：门店外观/档口/店面/用餐区 → 环境。
    expect(system).toContain("门店外观");
    expect(system).toContain("归环境");
    // 旧口径「产品/菜品/设备/门店实物」会把门店外观带偏成产品实拍——不得残留。
    expect(system).not.toContain("门店实物");
    expect(system).toContain("本体特写");
  });

  it("falls back to a generic material label when the display name is blank", () => {
    const { system, prompt } = buildImageTaggingPrompt({
      sourceMaterialName: "  ",
    });
    expect(system).not.toContain("《》");
    expect(prompt).not.toContain("《》");
  });
});

describe("parseImageTaggingResponse", () => {
  it("parses a Chinese-label category response", () => {
    expect(
      parseImageTaggingResponse(
        '{"description":"门店前台的智能音箱展台实拍","category":"产品实拍"}',
      ),
    ).toEqual({
      description: "门店前台的智能音箱展台实拍",
      category: "product-photo",
    });
  });

  it("parses markdown-fenced and prose-wrapped JSON", () => {
    expect(
      parseImageTaggingResponse(
        '```json\n{"description":"车间流水线全景","category":"环境"}\n```',
      ),
    ).toEqual({ description: "车间流水线全景", category: "scene" });
    expect(
      parseImageTaggingResponse(
        '打标结果：{"description":"工程师调试设备","category":"人物"} 以上。',
      ),
    ).toEqual({ description: "工程师调试设备", category: "people" });
  });

  it("maps every non-icon category code through", () => {
    expect(
      parseImageTaggingResponse('{"description":"a","category":"图表"}')
        ?.category,
    ).toBe("chart");
    expect(
      parseImageTaggingResponse('{"description":"a","category":"截图"}')
        ?.category,
    ).toBe("screenshot");
  });

  it("keeps the icon-decoration category (caller filters it out of the pool)", () => {
    expect(
      parseImageTaggingResponse(
        '{"description":"品牌 logo 圆形图标","category":"图标装饰"}',
      ),
    ).toEqual({
      description: "品牌 logo 圆形图标",
      category: "icon-decoration",
    });
  });

  it("truncates over-long descriptions instead of dropping the image", () => {
    const raw = JSON.stringify({
      description: "长".repeat(400),
      category: "环境",
    });
    const parsed = parseImageTaggingResponse(raw);
    expect(parsed?.description.length).toBe(300);
    expect(parsed?.category).toBe("scene");
  });

  it("truncates by Unicode code points so emoji never split into lone surrogates", () => {
    // 350 个码点 = 700 个 UTF-16 单元；截断按码点计 300，与 Rust 侧
    // chars().take(300) 同口径。
    const raw = JSON.stringify({
      description: "🌊".repeat(350),
      category: "环境",
    });
    const parsed = parseImageTaggingResponse(raw);
    expect(Array.from(parsed?.description ?? "")).toHaveLength(300);
    expect(parsed?.description.includes("\ud83c\udf0a")).toBe(true);
  });

  it("degrades to null on empty description, unknown category, or unparseable output", () => {
    expect(
      parseImageTaggingResponse('{"description":"  ","category":"环境"}'),
    ).toBeNull();
    expect(
      parseImageTaggingResponse('{"description":"描述","category":"风景"}'),
    ).toBeNull();
    expect(parseImageTaggingResponse('{"description":"描述"}')).toBeNull();
    expect(
      parseImageTaggingResponse("模型拒答：无法识别该图片内容。"),
    ).toBeNull();
    expect(parseImageTaggingResponse("")).toBeNull();
  });
});

describe("taggable size gate", () => {
  it("caps taggable image bytes at the documented limit", () => {
    expect(MATERIAL_IMAGE_MAX_TAGGABLE_BYTES).toBe(10 * 1024 * 1024);
  });
});
