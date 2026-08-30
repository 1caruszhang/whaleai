/**
 * Explicit real-provider smoke for material image tagging. Never part of the
 * default test command.
 *
 * Run intentionally with both the credentialed project and the extra opt-in:
 *   ARK_API_KEY=... RUN_XIAOJING_PROVIDER_SMOKE=1 \
 *     npm run test:credentialed -- material-image
 *
 * 固化 ADR-0008 的 lite spike 回归（2026-08-31 经生产网关 /gw/ark 实测
 * image_url 输入可用）：真模型 + 合成 PNG 走 describeImage 全链，断言
 * 打标响应可解析成「一句中文描述 + 类型分类」。无 ARK 凭证时跳过。
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createGeoProviderCapabilities } from "./provider-capabilities";
import {
  buildImageTaggingPrompt,
  parseImageTaggingResponse,
  probeImageDimensions,
} from "./material-image";

const explicitlyEnabled = process.env.RUN_XIAOJING_PROVIDER_SMOKE === "1";
const gatewayBaseUrl = process.env.XIAOJING_GATEWAY_BASE_URL?.trim();
const accountAccessToken = process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN?.trim();
const arkApiKey = process.env.ARK_API_KEY?.trim();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 无第三方依赖的合法单色 PNG（含 CRC），尺寸过入池门槛。 */
function solidPng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(type.length + data.length);
    body.set(Buffer.from(type, "ascii"), 0);
    body.set(data, type.length);
    const out = new Uint8Array(body.length + 8);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(body, 4);
    new DataView(out.buffer).setUint32(out.length - 4, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit truecolor, no interlace
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = 198;
      raw[offset + 1] = 40;
      raw[offset + 2] = 40;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(chunk("IHDR", ihdr)),
    Buffer.from(chunk("IDAT", new Uint8Array(deflateSync(raw)))),
    Buffer.from(chunk("IEND", new Uint8Array(0))),
  ]);
}

describe.runIf(explicitlyEnabled)(
  "Xiaojing material image tagging smoke",
  () => {
    it.skipIf(!(gatewayBaseUrl && accountAccessToken) && !arkApiKey)(
      "tags a real image through the lite model image_url input",
      { timeout: 240_000 },
      async () => {
        const bytes = solidPng(256, 256);
        expect(probeImageDimensions(bytes, "png")).toEqual({
          width: 256,
          height: 256,
        });

        const capabilities = createGeoProviderCapabilities(
          gatewayBaseUrl && accountAccessToken
            ? { gatewayBaseUrl, accountAccessToken }
            : { arkApiKey },
        );
        const prompt = buildImageTaggingPrompt();
        const raw = await capabilities.keywordSearch.describeImage!({
          system: prompt.system,
          prompt: prompt.prompt,
          bytes,
          mediaType: "image/png",
        });

        expect(raw.trim().length).toBeGreaterThan(0);
        const tag = parseImageTaggingResponse(raw);
        expect(tag).not.toBeNull();
        expect(tag?.description.trim().length).toBeGreaterThan(0);
        expect([
          "product-photo",
          "scene",
          "people",
          "chart",
          "screenshot",
          "icon-decoration",
        ]).toContain(tag?.category);
      },
    );
  },
);
