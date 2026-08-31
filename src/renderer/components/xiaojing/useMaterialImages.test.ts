import { describe, expect, it } from "vitest";

import {
  blobToDataUrl,
  readyImageDataUrls,
  type MaterialImageEntry,
} from "./useMaterialImages";

describe("material image data URLs (export self-containment)", () => {
  it("converts a blob to a data: URL with base64 payload", async () => {
    // "PNG" 的 ASCII 字节；btoa 结果可反解校验。
    const blob = new Blob([new Uint8Array([0x50, 0x4e, 0x47])], {
      type: "image/png",
    });
    const dataUrl = await blobToDataUrl(blob);
    expect(dataUrl).toBe("data:image/png;base64,UE5H");
  });

  it("chunks large payloads without truncation", async () => {
    const bytes = new Uint8Array(0x8000 + 7);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }
    const dataUrl = await blobToDataUrl(new Blob([bytes], { type: "image/jpeg" }));
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    // 往返解码无损（atob 输出二进制字符串，按字节比对）。
    const decoded = atob(dataUrl.slice("data:image/jpeg;base64,".length));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(bytes.length - 1)).toBe(bytes[bytes.length - 1]);
  });

  it("maps only ready entries; loading/failed are skipped", async () => {
    const entries = new Map<string, MaterialImageEntry>([
      ["img-ready", { status: "ready", url: "blob:x", blob: new Blob(["A"], { type: "image/png" }) }],
      ["img-loading", { status: "loading" }],
      ["img-failed", { status: "failed", reason: "取回失败" }],
    ]);
    const urls = await readyImageDataUrls(entries);
    expect(urls.size).toBe(1);
    expect(urls.get("img-ready")).toBe("data:image/png;base64,QQ==");
  });
});
