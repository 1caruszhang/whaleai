import { useEffect, useRef } from "react";

export const GATE_CARD_POLL_INTERVAL_MS = 3_000;

interface GateCardRefreshOptions<T> {
  /** 卡片仍在待决（未确认/未批准）时才轮询；裁决后停止。 */
  enabled: boolean;
  /** 只接受同一实体的投影；latest 返回别的实体时忽略（卡片属于旧卡）。 */
  projectionId: string;
  /** 首次渲染投影的变化指纹（多数域用 revision，文章操作用 updatedAt）。 */
  initialFingerprint: string;
  fetchLatest: () => Promise<T | null>;
  /** 投影变化指纹；与上次已见值不同才投递新投影。 */
  fingerprintOf: (projection: T) => string;
  /** 新投影到达时回调（在轮询任务内执行，各卡在此做「服务端胜」合并）。 */
  onChange: (projection: T) => void;
}

/**
 * 聊天闸门卡的既有刷新周期（ADR 0003，票 38）：待决期间每 3s 拉取一次
 * /latest 投影；id 一致且指纹变化时投递新投影，由各卡片在 onChange 里按
 * 条目指纹做「服务端胜」合并——被聊天修订改过的条目以服务端值重渲染，
 * 未改条目保留本地暂存。传输失败静默等下个周期（react_stability_rules：
 * 取数与合并回调经 ref 读取，不进 effect 依赖；回调在轮询任务内执行，
 * 不产生 render 期副作用）。
 */
export function useGateCardRefresh<T extends { id: string }>(
  options: GateCardRefreshOptions<T>,
): void {
  const { enabled, projectionId, initialFingerprint } = options;
  const fetchRef = useRef(options.fetchLatest);
  const fingerprintOfRef = useRef(options.fingerprintOf);
  const onChangeRef = useRef(options.onChange);
  // 取数与合并回调随渲染刷新，但只在 effect 内写入 ref（稳定规则）。
  useEffect(() => {
    fetchRef.current = options.fetchLatest;
    fingerprintOfRef.current = options.fingerprintOf;
    onChangeRef.current = options.onChange;
  });
  const seenRef = useRef(initialFingerprint);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await fetchRef.current();
        if (cancelled || !latest || latest.id !== projectionId) return;
        const fingerprint = fingerprintOfRef.current(latest);
        if (fingerprint === seenRef.current) return;
        seenRef.current = fingerprint;
        onChangeRef.current(latest);
      } catch {
        // 下个周期重试；卡片保持当前投影。
      }
    };
    const timer = window.setInterval(() => { void poll(); }, GATE_CARD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, projectionId]);
}
