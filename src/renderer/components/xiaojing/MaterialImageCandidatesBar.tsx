import { ChevronDown, ImageOff, Images, Loader2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchMaterialImageAssets,
  fetchMaterialImageContent,
} from '@/api/brandMaterialClient';
import { useTabApi } from '@/context/TabContext';
import {
  materialImageCategoryLabel,
  type MaterialImageAsset,
} from '../../../shared/geo/materialImages';

/**
 * 配图候选只读预览条（材料图片候选池的唯一可视化入口）：挂在材料请求卡
 * （宿主卡）上的品牌级折叠条，覆盖全部入池来源（纯图片上传 / docx、pptx
 * 内嵌图 / 存量重扫）。默认收起，头部一行「配图候选 N 张 · 本次新增 M」；
 * 展开为缩略图网格（服务端已按入池时间倒序，卡内限高内滚——默认视口约见
 * 最新 12 张，其余滚动查看），每张经材料图片内容取回换本地 blob + 一句
 * 中文描述 + 类型标签。
 *
 * 纯只读：无移出/勾选/写操作（ADR-0008 延后的筛图界面不在此重开）。池空
 * 整条不渲染；清单刷新由卡片侧 `refreshKey` 驱动（挂载基线 + 既有 3s 轮询
 * tick + 重扫完成），零手动刷新按钮。
 *
 * 「本次新增」为组件快照 diff：首次成功取数确立基线 id 集，其后每次取数
 * 统计不在基线中的新 id 数——重挂载（转录重放）重新建基线，不带增量后缀。
 *
 * 生命周期纪律（ArticleBodyPreview 同款）：object URL 只在本组件登记
 * （urlsRef），收起或资产离场即 revoke，卸载统一回收，不泄漏 Blob；取回
 * 失败的格子降级为可读失败占位，不阻塞网格其余部分。
 */
type MaterialImageBlobEntry =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'failed'; reason?: string };

interface MaterialImageCandidatesBarProps {
  identity: { workspaceId: string; sessionId: string } | null;
  /** 卡片侧驱动的刷新信号（轮询 tick / 重扫完成时递增）；初始 0 触发基线取数。 */
  refreshKey: number;
  /** 未入池图的一行汇总留痕（现有 outcome 口径，如重扫降级计数）；缺省用固定口径。 */
  unpooledNote?: string | null;
}

const DEFAULT_UNPOOLED_NOTE =
  '打标降级、尺寸过小或格式不支持的图片不会进入候选池（未入池图不逐张展示）。';

export default memo(function MaterialImageCandidatesBar({
  identity,
  refreshKey,
  unpooledNote,
}: MaterialImageCandidatesBarProps) {
  const { apiPost } = useTabApi();
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<MaterialImageAsset[] | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [entries, setEntries] = useState<Map<string, MaterialImageBlobEntry>>(
    () => new Map(),
  );
  /** 首次成功取数的 id 基线：之后的「本次新增」= 不在基线中的新 id 数。 */
  const baselineIdsRef = useRef<Set<string> | null>(null);
  const apiPostRef = useRef(apiPost);
  const entriesRef = useRef(entries);
  const urlsRef = useRef(new Map<string, string>());
  // react_stability_rules：apiPost/取回结果经 ref 读取，不进取数 effect
  // 依赖；镜像写放在独立 effect 里（ArticleBodyPreview 同款），声明先于
  // 取数 effect，同轮 commit 内先刷新再消费。
  useEffect(() => {
    apiPostRef.current = apiPost;
    entriesRef.current = entries;
  });

  const workspaceId = identity?.workspaceId ?? null;
  const sessionId = identity?.sessionId ?? null;
  const identityKey =
    workspaceId && sessionId ? `${workspaceId}::${sessionId}` : null;

  // 身份变化（换 Session/品牌）即重建投影，避免跨品牌串池。重置走 React 官方
  // 「prop 变化时调整 state」模式：渲染期条件守卫 + setState，不放 effect
  // （react-hooks/set-state-in-effect：effect 体内同步 setState 造成级联渲染）。
  // 守卫保证仅身份真正变化的那次渲染执行重置，其余渲染零开销。
  const [prevIdentityKey, setPrevIdentityKey] = useState<string | null>(
    identityKey,
  );
  if (identityKey !== prevIdentityKey) {
    setPrevIdentityKey(identityKey);
    setAssets(null);
    setNewCount(0);
    setEntries(new Map());
  }

  // 清单取数：挂载（refreshKey=0）与卡片侧刷新信号各取一次。传输/业务失败
  // 静默保留上一份投影（下个信号再试）；首次失败时整条不渲染。
  useEffect(() => {
    if (!workspaceId || !sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const images = await fetchMaterialImageAssets(apiPostRef.current, {
          workspaceId,
          sessionId,
        });
        if (cancelled) return;
        setAssets(images);
        if (!baselineIdsRef.current) {
          // 首次成功取数确立基线：历史池不算「本次新增」。
          baselineIdsRef.current = new Set(images.map((asset) => asset.id));
          setNewCount(0);
        } else {
          setNewCount(
            images.filter((asset) => !baselineIdsRef.current!.has(asset.id)).length,
          );
        }
      } catch {
        // 保留上一份投影；池状态未知时不渲染入口。
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, sessionId, refreshKey]);

  // 身份变化的清尾——对外部系统的回收是 effect 本分（无 setState）：基线 ref
  // 重建 + 旧投影 blob 全量回收。entries 已在渲染期重置，回收后不存在指向已
  // revoke URL 的存活条目；声明先于缩略图 effect，同轮 flush 内先清再取。
  useEffect(() => {
    baselineIdsRef.current = null;
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, [workspaceId, sessionId]);

  const orderedAssets = useMemo(() => assets ?? [], [assets]);
  const idsKey = useMemo(
    () => orderedAssets.map((asset) => asset.id).join(','),
    [orderedAssets],
  );

  // 缩略图字节取回：只在展开时进行；收起即回收全部 blob（再展开重新取）。
  useEffect(() => {
    if (!workspaceId || !sessionId) return;
    if (!open) {
      // 收起：网格卸载，blob 即刻回收，不留悬空 object URL。
      setEntries((current) => {
        if (current.size === 0) return current;
        for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
        urlsRef.current.clear();
        return new Map();
      });
      return;
    }
    let cancelled = false;
    const wanted = new Set(idsKey === '' ? [] : idsKey.split(','));
    // 清掉不再在池清单里的条目（快照刷新后离场的资产）：blob 即刻回收。
    setEntries((current) => {
      let next: Map<string, MaterialImageBlobEntry> | null = null;
      for (const [imageId, entry] of current) {
        if (wanted.has(imageId)) continue;
        if (!next) next = new Map(current);
        if (entry.status === 'ready') {
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
      setEntries((current) =>
        current.has(imageId)
          ? current
          : new Map(current).set(imageId, { status: 'loading' }),
      );
      void (async () => {
        try {
          const { bytes, mediaType } = await fetchMaterialImageContent(
            apiPostRef.current,
            { workspaceId, sessionId },
            imageId,
          );
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
          urlsRef.current.set(imageId, url);
          setEntries((current) => new Map(current).set(imageId, { status: 'ready', url }));
        } catch (cause) {
          if (cancelled) return;
          const reason = cause instanceof Error ? cause.message : String(cause);
          setEntries((current) => new Map(current).set(imageId, { status: 'failed', reason }));
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [open, idsKey, workspaceId, sessionId]);

  // 卸载时统一回收本组件创建的全部 object URL。
  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  if (!identity || !assets || assets.length === 0) return null;

  return (
    <div
      data-material-image-candidates-bar
      className="mt-2 rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2"
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={open ? '收起配图候选' : '展开配图候选'}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:text-[var(--accent)]"
      >
        <Images className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">
          {`配图候选 ${assets.length} 张${newCount > 0 ? ` · 本次新增 ${newCount}` : ''}`}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="mt-2">
          <div
            role="region"
            aria-label="配图候选缩略图"
            data-material-image-candidates-grid
            className="grid max-h-[19rem] auto-rows-min grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 overflow-y-auto pr-1"
          >
            {orderedAssets.map((asset) => {
              const entry = entries.get(asset.id);
              return (
                <figure
                  key={asset.id}
                  data-material-image-candidate={asset.id}
                  className="min-w-0 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5"
                >
                  {entry?.status === 'ready' ? (
                    <img
                      src={entry.url}
                      alt={asset.description}
                      className="h-20 w-full rounded object-cover"
                      loading="lazy"
                    />
                  ) : entry?.status === 'failed' ? (
                    <div
                      data-material-image-candidate-failed={asset.id}
                      className="flex h-20 w-full flex-col items-center justify-center gap-1 rounded bg-[var(--paper-inset)] text-xs text-[var(--ink-muted)]"
                    >
                      <ImageOff className="h-4 w-4" aria-hidden="true" />
                      <span className="px-1 text-center">图片加载失败</span>
                    </div>
                  ) : (
                    <div className="flex h-20 w-full items-center justify-center rounded bg-[var(--paper-inset)]">
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]" aria-hidden="true" />
                    </div>
                  )}
                  <figcaption
                    className="mt-1 truncate text-xs leading-4 text-[var(--ink)]"
                    title={asset.description}
                  >
                    {asset.description}
                  </figcaption>
                  <span className="mt-0.5 inline-block rounded bg-[var(--paper-inset)] px-1 py-0.5 text-xs leading-none text-[var(--ink-muted)]">
                    {materialImageCategoryLabel(asset.category)}
                  </span>
                </figure>
              );
            })}
          </div>
          <p
            data-material-image-unpooled-note
            className="mt-1.5 text-xs leading-4 text-[var(--ink-muted)]"
          >
            {unpooledNote ?? DEFAULT_UNPOOLED_NOTE}
          </p>
        </div>
      )}
    </div>
  );
});
