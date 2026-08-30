import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchMaterialImageContent } from "@/api/brandMaterialClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import { scanMaterialImagePlaceholders } from "../../../shared/geo/materialImagePlaceholder";
import Markdown, { type MaterialImageResolution } from "../Markdown";

/**
 * 文章正文渲染预览（ADR-0008 Decision 6）：批准卡与工作台批准稿共用的
 * 渲染态。正文按 markdown 渲染；`material-image://` 占位符经材料内容取回
 * 接口换本地 blob 显示——预览不依赖 OSS 发布，占位符是否入图在批准前
 * 即可验收。
 *
 * 生命周期纪律：object URL 只在本组件登记（urlsRef），占位符随修订消失
 * 或组件卸载时 revoke，不泄漏 Blob。取回失败按图降级为可读失败占位，
 * 不阻塞正文其余部分渲染（与发布链路 fail-closed 不同：预览是本地投影）。
 */
type MaterialImageEntry =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; reason?: string };

export default function ArticleBodyPreview({
  body,
  workspaceId,
  className,
}: {
  body: string;
  workspaceId: string;
  className?: string;
}) {
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
  // effect 依赖；镜像写放在 effect 里（useGateCardRefresh 同款），声明先于
  // 取数 effect，同轮 commit 内先刷新再消费。
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
          const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
          urlsRef.current.set(imageId, url);
          setEntries((current) => new Map(current).set(imageId, { status: "ready", url }));
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

  // 卸载时统一回收本组件创建的全部 object URL。
  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  // 解析器身份随取回结果变化，驱动 Markdown（memo）重渲染出图片。
  const resolveMaterialImage = useCallback(
    (imageId: string): MaterialImageResolution => {
      const entry = entries.get(imageId);
      if (!entry) return { kind: "failed", reason: "占位符不受控，未入候选池" };
      if (entry.status === "ready") return { kind: "ready", url: entry.url };
      if (entry.status === "failed") return { kind: "failed", reason: entry.reason };
      return { kind: "loading" };
    },
    [entries],
  );

  return (
    <div className={className} data-article-body-preview>
      <Markdown raw resolveMaterialImage={resolveMaterialImage}>
        {body}
      </Markdown>
    </div>
  );
}
