import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchMaterialImageContent } from "@/api/brandMaterialClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import { scanMaterialImagePlaceholders } from "../../../shared/geo/materialImagePlaceholder";

/**
 * 材料图片占位符 → 本地 blob 的取回与生命周期（ADR-0008 批准预览）。
 * 从 ArticleBodyPreview 抽出：全屏 HTML 预览与卡内轻量预览共用同一套
 * 取回/回收纪律——object URL 只在本 hook 登记，占位符随正文消失或宿主
 * 卸载时 revoke；取回失败降级为可读失败态，不阻塞其余图片。
 */
export type MaterialImageEntry =
  | { status: "loading" }
  | { status: "ready"; url: string; blob: Blob }
  | { status: "failed"; reason?: string };

export function useMaterialImages(
  body: string,
  workspaceId: string,
): Map<string, MaterialImageEntry> {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  const imageIds = useMemo(
    () =>
      Array.from(
        new Set(
          scanMaterialImagePlaceholders(body).placeholders.map(
            (placeholder) => placeholder.imageId,
          ),
        ),
      ),
    [body],
  );
  const idsKey = imageIds.join(",");

  const [entries, setEntries] = useState<Map<string, MaterialImageEntry>>(
    () => new Map(),
  );
  const apiPostRef = useRef(apiPost);
  const sessionIdRef = useRef(sessionId);
  const entriesRef = useRef(entries);
  const urlsRef = useRef(new Map<string, string>());
  // react_stability_rules：apiPost/sessionId/取回结果经 ref 读取，不进取数
  // effect 依赖；镜像写放在 effect 里（useGateCardRefresh 同款）。
  useEffect(() => {
    apiPostRef.current = apiPost;
    sessionIdRef.current = sessionId;
    entriesRef.current = entries;
  });

  useEffect(() => {
    const wanted = new Set(idsKey === "" ? [] : idsKey.split(","));
    let cancelled = false;

    // 清掉不再被正文引用的条目（编辑删占位符/聊天修订后）：blob 即刻回收。
    setEntries((current) => {
      let next: Map<string, MaterialImageEntry> | null = null;
      for (const [imageId, entry] of current) {
        if (wanted.has(imageId)) continue;
        if (!next) next = new Map(current);
        if (entry.status === "ready") {
          const url = urlsRef.current.get(imageId);
          if (url) {
            URL.revokeObjectURL(url);
            urlsRef.current.delete(imageId);
          }
        }
        next.delete(imageId);
      }
      return next ?? current;
    });

    for (const imageId of wanted) {
      if (entriesRef.current.has(imageId)) continue;
      if (!hasRealSession) {
        const reason = "暂无会话，无法取回材料图片";
        setEntries((current) =>
          current.has(imageId)
            ? current
            : new Map(current).set(imageId, { status: "failed", reason }),
        );
        continue;
      }
      setEntries((current) =>
        current.has(imageId)
          ? current
          : new Map(current).set(imageId, { status: "loading" }),
      );
      void (async () => {
        try {
          const { bytes, mediaType } = await fetchMaterialImageContent(
            apiPostRef.current,
            { workspaceId, sessionId: sessionIdRef.current ?? "" },
            imageId,
          );
          if (cancelled) return;
          const blob = new Blob([bytes], { type: mediaType });
          const url = URL.createObjectURL(blob);
          urlsRef.current.set(imageId, url);
          setEntries((current) =>
            new Map(current).set(imageId, { status: "ready", url, blob }),
          );
        } catch (cause) {
          if (cancelled) return;
          const reason = cause instanceof Error ? cause.message : String(cause);
          setEntries((current) =>
            new Map(current).set(imageId, { status: "failed", reason }),
          );
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [hasRealSession, idsKey, workspaceId]);

  // 卸载时统一回收本 hook 创建的全部 object URL。
  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  return entries;
}

/** entries 集合中全部已就绪图片的 blob URL（iframe 预览内嵌用）。 */
export function readyImageUrls(
  entries: ReadonlyMap<string, MaterialImageEntry>,
): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [imageId, entry] of entries) {
    if (entry.status === "ready") urls.set(imageId, entry.url);
  }
  return urls;
}

/** Blob → data: URL。分块拼接避免 String.fromCharCode 展开超参；
 * btoa/Blob 在 WebView 与测试 node 环境都可用。 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** entries 中已就绪图片的 data: URL 表（导出/复制用）。blob: URL 只在本
 * 应用会话内有效，导出文件在会话外打开会全部裂图——导出/复制必须把图片
 * 字节以 data: URL 内嵌进文档，文件才真正自包含（预览 = 导出的载体差异：
 * 同一生成器，仅图片寻址不同）。 */
export async function readyImageDataUrls(
  entries: ReadonlyMap<string, MaterialImageEntry>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const [imageId, entry] of entries) {
    if (entry.status !== "ready") continue;
    urls.set(imageId, await blobToDataUrl(entry.blob));
  }
  return urls;
}

export function useMaterialImageResolver(
  entries: ReadonlyMap<string, MaterialImageEntry>,
): (imageId: string) =>
  | { kind: "ready"; url: string }
  | { kind: "failed"; reason?: string }
  | { kind: "loading" } {
  return useCallback(
    (imageId: string) => {
      const entry = entries.get(imageId);
      if (!entry) return { kind: "failed", reason: "占位符不受控，未入候选池" };
      if (entry.status === "ready") return { kind: "ready", url: entry.url };
      if (entry.status === "failed") return { kind: "failed", reason: entry.reason };
      return { kind: "loading" };
    },
    [entries],
  );
}
