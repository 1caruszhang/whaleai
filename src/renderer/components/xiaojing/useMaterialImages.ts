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
  const urlsRef = useRef(new Map<string, string>());
  /** 已发起过取回（或因无会话而终局 failed）的 id，跨 idsKey 累计防重取。 */
  const startedRef = useRef(new Set<string>());

  // react_stability_rules：apiPost/sessionId 经 ref 读取，不进取数 effect
  // 依赖（镜像写放独立 effect，与 useGateCardRefresh 同款）。
  useEffect(() => {
    apiPostRef.current = apiPost;
    sessionIdRef.current = sessionId;
  });

  // 正文占位符集合变化时同步调整 entries：React 官方「输入变化时调整
  // state」的渲染期守卫模式（不放 effect——effect 体内同步 setState 造成
  // 级联渲染，react-hooks/set-state-in-effect；先例 MaterialImageCandidatesBar
  // 的身份重置同款）。收缩不再引用的条目、给缺失 id 补占位（无会话直接
  // failed，与旧语义一致不重试）。setState 后立即重渲染，守卫收敛为零
  // 开销；updater 只读入参与闭包常量，不触碰 ref——渲染期不得有副作用。
  const [syncedIdsKey, setSyncedIdsKey] = useState(idsKey);
  if (
    idsKey !== syncedIdsKey ||
    imageIds.some((imageId) => !entries.has(imageId))
  ) {
    setSyncedIdsKey(idsKey);
    const wanted = new Set(imageIds);
    setEntries((current) => {
      let next: Map<string, MaterialImageEntry> | null = null;
      for (const imageId of current.keys()) {
        if (wanted.has(imageId)) continue;
        next ??= new Map(current);
        next.delete(imageId);
      }
      for (const imageId of imageIds) {
        if (current.has(imageId)) continue;
        next ??= new Map(current);
        next.set(
          imageId,
          hasRealSession
            ? { status: "loading" }
            : { status: "failed", reason: "暂无会话，无法取回材料图片" },
        );
      }
      return next ?? current;
    });
  }

  // 取回与回收（对外部系统）：effect 体内只做 object URL 回收与取回发起，
  // 全部 setState 都在异步回调里。revoke 必须直接在 effect 体内执行——
  // setState updater 必须纯（React 可延迟/重放），把 revoke 夹带进 updater
  // 会让回收时机挂在 update 调度上，与「图片从 DOM 消失」之间出现可观察
  // 竞态；urlsRef 只登记 ready 条目的 URL，幂等可重放。
  useEffect(() => {
    const wanted = new Set(idsKey === "" ? [] : idsKey.split(","));
    for (const [imageId, url] of urlsRef.current) {
      if (wanted.has(imageId)) continue;
      URL.revokeObjectURL(url);
      urlsRef.current.delete(imageId);
    }

    let cancelled = false;
    for (const imageId of wanted) {
      if (startedRef.current.has(imageId)) continue;
      startedRef.current.add(imageId);
      if (!hasRealSession) continue;
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
