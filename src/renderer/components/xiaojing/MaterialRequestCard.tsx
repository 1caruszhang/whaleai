import {
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  FileUp,
  Link,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchBrandMaterialStatuses,
  deleteBrandMaterial,
  importBrandMaterialFiles,
  importBrandMaterialText,
  importBrandMaterialWebsite,
  retryBrandMaterial,
  type BrandMaterialProcessResult,
  type BrandMaterialStatusEntry,
} from '@/api/brandMaterialClient';
import { useCurrentWorkspace } from '@/context/CurrentWorkspaceContext';
import { useTabApi, useTabState } from '@/context/TabContext';
import { isPendingSessionId } from '../../../shared/constants';
import type { KnowledgeCandidatesCardData } from '../../../shared/geo/knowledgeCard';
import { isMaterialImageExtension, MATERIAL_IMAGE_EXTENSIONS } from '../../../shared/geo/materialImages';
import { parseMaterialRequestCard, type MaterialRequestCardData } from '../../../shared/geo/materialRequestCard';
import KnowledgeBatchCard from './KnowledgeBatchCard';

export { parseMaterialRequestCard };

type MaterialInputKind = 'file' | 'pasted-text' | 'website-url';
type MaterialUiStatus = 'processing' | 'success' | 'failed';

interface MaterialRow {
  key: string;
  kind: MaterialInputKind;
  label: string;
  status: MaterialUiStatus;
  materialId?: string;
  candidateCount?: number;
  errorCode?: string;
  /** 独立图片材料行：文案走配图候选池口径而非「待确认事实」口径。 */
  image?: boolean;
  /**
   * 挂载恢复接管的在途行：原 Sidecar 的后台队列可能已随进程消失，
   * 允许用户直接重试，避免永远停在 processing。
   */
  recoverable?: boolean;
}

interface MaterialRequestCardProps {
  data: MaterialRequestCardData;
}

/** 卡片保留上限：与会话恢复的 Rust 端材料列表上限一致。 */
const CARD_RETAIN_LIMIT = 10;
const STATUS_POLL_INTERVAL_MS = 3000;

function displayNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 180) || '品牌材料';
}

function rowPatchFromEntry(entry: BrandMaterialProcessResult | undefined): Partial<MaterialRow> {
  if (!entry) return { status: 'failed', errorCode: 'material_processing_failed' };
  if (entry.ok) {
    return {
      status: 'processing',
      materialId: entry.material.id,
      image: isMaterialImageExtension(entry.material.fileExt),
      errorCode: undefined,
    };
  }
  return { status: 'failed', materialId: undefined, errorCode: entry.errorCode };
}

function rowPatchFromStatus(entry: BrandMaterialStatusEntry): Partial<MaterialRow> {
  const { material, card } = entry;
  const image = isMaterialImageExtension(material.fileExt);
  if (material.status === 'failed') {
    return { status: 'failed', image, errorCode: material.lastErrorCode ?? 'material_processing_failed' };
  }
  if (material.status === 'awaiting-confirmation' || material.status === 'processed') {
    return {
      status: 'success',
      materialId: material.id,
      image,
      candidateCount: card?.candidates.length ?? 0,
      errorCode: undefined,
    };
  }
  return {};
}

/**
 * 材料请求卡（ADR 0005）：agent 经 request_brand_material 判断需要品牌
 * 材料后出现在聊天流里的结构化卡片，承载用户发起上传的全部路径与进行
 * 中行。卡片锚定在发起那轮消息、随 transcript 持久；重放即重挂载、重挂
 * 载即恢复轮询，导入产出仍由卡内的知识批量确认卡裁决。
 */
export default memo(function MaterialRequestCard({ data }: MaterialRequestCardProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  // provider 由 App 按本 Tab 的 workspacePath 精确匹配注入；无匹配品牌时
  // 上传禁用，不做全局补位。
  const currentWorkspace = useCurrentWorkspace();
  const [formOpen, setFormOpen] = useState(true);
  const [pasteText, setPasteText] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [cards, setCards] = useState<KnowledgeCandidatesCardData[]>([]);
  const nextRowIdRef = useRef(0);
  const identity = useMemo(
    () =>
      currentWorkspace?.id && sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId: currentWorkspace.id, sessionId }
        : null,
    [currentWorkspace?.id, sessionId],
  );
  const processing = rows.some((row) => row.status === 'processing');
  const canSubmit = identity !== null && !processing;

  // 卡片是权威候选的投影：按材料去重插入，裁决后保留（变暗只读），
  // 上限与 Rust 会话恢复列表一致。
  const upsertCard = useCallback((card: KnowledgeCandidatesCardData | null) => {
    if (!card?.material?.id) return;
    setCards((current) => {
      const rest = current.filter((existing) => existing.material?.id !== card.material!.id);
      return [card, ...rest].slice(0, CARD_RETAIN_LIMIT);
    });
  }, []);

  const nextKey = useCallback(() => {
    nextRowIdRef.current += 1;
    return `material-input-${nextRowIdRef.current}`;
  }, []);

  const replaceRow = useCallback((key: string, patch: Partial<MaterialRow>) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  }, []);

  const applyStatusEntries = useCallback((entries: BrandMaterialStatusEntry[]) => {
    for (const entry of entries) {
      if (entry.card) upsertCard(entry.card);
      const patch = rowPatchFromStatus(entry);
      if (Object.keys(patch).length === 0) continue;
      setRows((current) => current.map((row) =>
        row.materialId === entry.material.id ? { ...row, ...patch } : row));
    }
  }, [upsertCard]);

  // 状态轮询：处理中的行按 materialId 查询；传输层失败静默，等下个周期。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pollOnce = useCallback(async () => {
    if (!identity) return;
    const processingIds = rowsRef.current
      .filter((row) => row.status === 'processing' && row.materialId)
      .map((row) => row.materialId as string);
    if (processingIds.length === 0) return;
    try {
      const entries = await fetchBrandMaterialStatuses(
        apiPost,
        identity,
        processingIds,
      );
      applyStatusEntries(entries);
    } catch {
      // 下个周期重试；行保持 processing。
    }
  }, [apiPost, applyStatusEntries, identity]);

  useEffect(() => {
    if (!identity) return;
    const timer = window.setInterval(() => { void pollOnce(); }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [identity, pollOnce]);

  // 会话恢复：重建本 Session 的确认卡（含已裁决的只读卡），并接管仍在
  // 处理中的材料行——卡片重挂载（transcript 重放）不再丢失权威候选的
  // 入口。cleanup 时回滚「已恢复」标记：被取消的恢复不算完成，重挂载
  // （含 StrictMode 重放）会重新执行，保持 setup/cleanup 对称。
  const recoveredSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!identity || recoveredSessionRef.current === identity.sessionId) return;
    recoveredSessionRef.current = identity.sessionId;
    let cancelled = false;
    (async () => {
      try {
        const entries = await fetchBrandMaterialStatuses(apiPost, identity);
        if (cancelled) return;
        for (const entry of entries) {
          if (entry.card) upsertCard(entry.card);
          if (entry.material.status === 'processing' || entry.material.status === 'stored') {
            setRows((current) => {
              if (current.some((row) => row.materialId === entry.material.id)) return current;
              return [{
                key: `material-recovered-${entry.material.id}`,
                kind: entry.material.inputKind,
                label: entry.material.displayName,
                status: 'processing',
                materialId: entry.material.id,
                image: isMaterialImageExtension(entry.material.fileExt ?? ''),
                recoverable: true,
              }, ...current];
            });
          }
        }
      } catch {
        // 恢复失败不阻塞卡片；下次挂载或身份变化时再试。
      } finally {
        if (cancelled) recoveredSessionRef.current = null;
      }
    })();
    return () => { cancelled = true; };
  }, [apiPost, identity, upsertCard]);

  const chooseFiles = useCallback(async () => {
    if (!canSubmit || !identity) return;
    let selected: string | string[] | null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      selected = await open({
        title: '选择品牌材料',
        directory: false,
        multiple: true,
        filters: [{
          name: '品牌材料',
          extensions: [
            'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'log',
            'pdf', 'docx', 'xlsx', 'pptx',
            ...MATERIAL_IMAGE_EXTENSIONS,
          ],
        }],
      });
    } catch {
      setRows((current) => [{
        key: nextKey(),
        kind: 'file',
        label: '文件选择',
        status: 'failed',
        errorCode: 'material_file_selection_failed',
      }, ...current]);
      return;
    }
    const paths = typeof selected === 'string' ? [selected] : selected ?? [];
    if (paths.length === 0) return;
    const pendingRows = paths.map((path) => ({
      key: nextKey(),
      kind: 'file' as const,
      label: displayNameFromPath(path),
      status: 'processing' as const,
      image: isMaterialImageExtension(path.split('.').at(-1) ?? ''),
    }));
    setRows((current) => [...pendingRows, ...current]);
    try {
      const entries = await importBrandMaterialFiles(
        apiPost,
        identity,
        paths,
      );
      setRows((current) => current.map((row) => {
        const index = pendingRows.findIndex((pending) => pending.key === row.key);
        return index >= 0 ? { ...row, ...rowPatchFromEntry(entries[index]) } : row;
      }));
      // 与粘贴/URL 一致：只有至少一项存储成功才收起表单，全部失败时留在
      // 表单上方便用户直接重选。
      if (entries.some((entry) => entry?.ok)) setFormOpen(false);
    } catch {
      // 传输层失败（代理超时/IPC/网络）：与业务错误码严格区分。
      setRows((current) => current.map((row) => pendingRows.some((pending) => pending.key === row.key)
        ? { ...row, status: 'failed', errorCode: 'material_request_failed' }
        : row));
    }
  }, [apiPost, canSubmit, identity, nextKey]);

  const submitText = useCallback(async () => {
    const text = pasteText.trim();
    if (!canSubmit || !identity || !text) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'pasted-text', label: '粘贴资料', status: 'processing' }, ...current]);
    try {
      const [entry] = await importBrandMaterialText(apiPost, identity, text);
      replaceRow(key, rowPatchFromEntry(entry));
      if (entry?.ok) {
        setPasteText('');
        setFormOpen(false);
      }
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, identity, nextKey, pasteText, replaceRow]);

  const submitWebsite = useCallback(async () => {
    const url = websiteUrl.trim();
    if (!canSubmit || !identity || !url) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'website-url', label: '官网资料', status: 'processing' }, ...current]);
    try {
      const [entry] = await importBrandMaterialWebsite(apiPost, identity, url);
      replaceRow(key, rowPatchFromEntry(entry));
      if (entry?.ok) {
        setWebsiteUrl('');
        setFormOpen(false);
      }
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, identity, nextKey, replaceRow, websiteUrl]);

  const retryOne = useCallback(async (row: MaterialRow) => {
    if (!canSubmit || !identity || !row.materialId) return;
    replaceRow(row.key, { status: 'processing', errorCode: undefined, recoverable: false });
    try {
      const [entry] = await retryBrandMaterial(
        apiPost,
        identity,
        row.materialId,
      );
      replaceRow(row.key, rowPatchFromEntry(entry));
    } catch {
      replaceRow(row.key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, identity, replaceRow]);

  // 移除材料：删除本体（行 + 文件 + 未决候选）后同步摘掉卡片上该材料的
  // 行与它的知识确认卡；已采纳进确认知识的裁决历史不受影响。
  const removeOne = useCallback(async (row: MaterialRow) => {
    if (!identity || !row.materialId) return;
    try {
      await deleteBrandMaterial(apiPost, identity, row.materialId);
      const materialId = row.materialId;
      setRows((current) => current.filter((existing) => existing.key !== row.key));
      setCards((current) => current.filter((card) => card.material?.id !== materialId));
    } catch (error) {
      // 服务端业务失败带固定码（如 material_processing_active）原样展示；
      // 传输层失败（代理/网络）收敛为 material_request_failed。
      const message = error instanceof Error ? error.message : '';
      replaceRow(row.key, {
        status: 'failed',
        errorCode: message.startsWith('material_') ? message : 'material_request_failed',
      });
    }
  }, [apiPost, identity, replaceRow]);

  return (
    <section
      aria-label="品牌材料导入"
      data-material-request-card
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
    >
      <div className="flex items-start gap-2">
        <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--ink)]">补充品牌材料</p>
          <p className="mt-0.5 break-words text-xs leading-5 text-[var(--ink-secondary)]">{data.reason}</p>
        </div>
        <button
          type="button"
          onClick={() => setFormOpen((open) => !open)}
          aria-expanded={formOpen}
          aria-label={formOpen ? '收起材料上传表单' : '继续添加品牌材料'}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${formOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
          {formOpen ? '收起' : '继续添加'}
        </button>
      </div>

      {!currentWorkspace && (
        <p className="mt-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          当前聊天没有精确匹配的品牌，无法在这里上传材料。
        </p>
      )}

      {formOpen && (
        <div className="mt-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs leading-4 text-[var(--ink-muted)]">
              原材料先安全保存，再生成待确认事实；完成后确认卡片会出现在这里。直接上传的图片与文档里的内嵌图片会自动进入配图候选池。
            </p>
            <button
              type="button"
              onClick={() => { void chooseFiles(); }}
              disabled={!canSubmit}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
            >
              <FileUp className="h-3.5 w-3.5" />选择文件
            </button>
          </div>

          <label className="mt-3 block text-sm font-medium">
            粘贴资料
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              disabled={!identity}
              placeholder="粘贴企业介绍、产品资料或品牌事实"
              className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={() => { void submitText(); }}
            disabled={!canSubmit || !pasteText.trim()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-secondary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-secondary-text)] disabled:opacity-50"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />保存并抽取粘贴资料
          </button>

          <label className="mt-3 block text-sm font-medium">
            官网 URL
            <input
              type="url"
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              disabled={!identity}
              placeholder="https://example.com/about"
              className="mt-1.5 h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={() => { void submitWebsite(); }}
            disabled={!canSubmit || !websiteUrl.trim()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-secondary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-secondary-text)] disabled:opacity-50"
          >
            <Link className="h-3.5 w-3.5" />保存并抽取官网资料
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-2 space-y-2" role="region" aria-label="材料处理结果">
          {rows.map((row) => (
            <article key={row.key} className="rounded-lg bg-[var(--paper-inset)] p-2.5 text-sm">
              <div className="flex items-start gap-2">
                {row.status === 'processing'
                  ? <Loader2 aria-label="处理中" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
                  : row.status === 'success'
                    ? <CheckCircle2 aria-label="成功" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
                    : <XCircle aria-label="失败" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {row.status === 'processing' && (row.image
                      ? '正在保存并识别图片…'
                      : '正在保存并抽取…（完成后自动弹出确认卡）')}
                    {row.status === 'success' && (row.image
                      ? '图片已保存；符合配图要求的图片自动进入配图候选池'
                      : `已生成 ${row.candidateCount ?? 0} 条待确认事实`)}
                    {row.status === 'failed' && `处理失败：${row.errorCode ?? 'material_processing_failed'}`}
                  </p>
                  {row.materialId && (
                    <p className="mt-1 break-all font-mono text-xs text-[var(--ink-subtle)]">
                      materialId: {row.materialId}
                    </p>
                  )}
                </div>
                {(row.status === 'failed' || (row.status === 'processing' && row.recoverable))
                  && row.materialId && (
                    <button
                      type="button"
                      onClick={() => { void retryOne(row); }}
                      disabled={!canSubmit}
                      aria-label={`仅重试 ${row.label}`}
                      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--paper-elevated)] disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />仅重试此项
                    </button>
                  )}
                {row.status !== 'processing' && row.materialId && (
                  <button
                    type="button"
                    onClick={() => { void removeOne(row); }}
                    disabled={!identity}
                    aria-label={`移除 ${row.label}`}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--error)] disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />移除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {cards.length > 0 && (
        <div role="region" aria-label="待确认知识候选" className="mt-2 space-y-3">
          {cards.map((card, index) => (
            <KnowledgeBatchCard key={card.material?.id ?? `card-${index}`} data={card} />
          ))}
        </div>
      )}
    </section>
  );
});
