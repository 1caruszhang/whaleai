import {
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  FileUp,
  Link,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchBrandMaterialStatuses,
  importBrandMaterialFiles,
  importBrandMaterialText,
  importBrandMaterialWebsite,
  retryBrandMaterial,
  type BrandMaterialProcessResult,
  type BrandMaterialStatusEntry,
} from '@/api/brandMaterialClient';
import { useTabApi, useTabState } from '@/context/TabContext';
import { isPendingSessionId } from '../../../shared/constants';
import type { KnowledgeCandidatesCardData } from '../../../shared/geo/knowledgeCard';
import KnowledgeBatchCard from './KnowledgeBatchCard';

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
  /**
   * 挂载恢复接管的在途行：原 Sidecar 的后台队列可能已随进程消失，
   * 允许用户直接重试，避免永远停在 processing。
   */
  recoverable?: boolean;
}

interface XiaojingChatMaterialImportProps {
  workspaceId: string;
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
    return { status: 'processing', materialId: entry.material.id, errorCode: undefined };
  }
  return { status: 'failed', materialId: undefined, errorCode: entry.errorCode };
}

function rowPatchFromStatus(entry: BrandMaterialStatusEntry): Partial<MaterialRow> {
  const { material, card } = entry;
  if (material.status === 'failed') {
    return { status: 'failed', errorCode: material.lastErrorCode ?? 'material_processing_failed' };
  }
  if (material.status === 'awaiting-confirmation' || material.status === 'processed') {
    return {
      status: 'success',
      materialId: material.id,
      candidateCount: card?.candidates.length ?? 0,
      errorCode: undefined,
    };
  }
  return {};
}

/**
 * 聊天输入区的品牌材料导入入口（票 27）：粘贴/官网 URL/文件选择的全部发起
 * 动作都在这里，处理结果与知识确认卡直接渲染在聊天内，工作台不再挂材料面板。
 */
export default memo(function XiaojingChatMaterialImport({
  workspaceId,
}: XiaojingChatMaterialImportProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [formOpen, setFormOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [cards, setCards] = useState<KnowledgeCandidatesCardData[]>([]);
  const nextRowIdRef = useRef(0);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const processing = rows.some((row) => row.status === 'processing');
  const canSubmit = hasRealSession && !processing;

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
    if (!sessionId) return;
    const processingIds = rowsRef.current
      .filter((row) => row.status === 'processing' && row.materialId)
      .map((row) => row.materialId as string);
    if (processingIds.length === 0) return;
    try {
      const entries = await fetchBrandMaterialStatuses(
        apiPost,
        { workspaceId, sessionId },
        processingIds,
      );
      applyStatusEntries(entries);
    } catch {
      // 下个周期重试；行保持 processing。
    }
  }, [apiPost, applyStatusEntries, sessionId, workspaceId]);

  useEffect(() => {
    if (!hasRealSession) return;
    const timer = window.setInterval(() => { void pollOnce(); }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasRealSession, pollOnce]);

  // 会话恢复：重建本 Session 的确认卡（含已裁决的只读卡），并接管仍在
  // 处理中的材料行——入口重挂载不再丢失权威候选的入口。cleanup 时回滚
  // 「已恢复」标记：被取消的恢复不算完成，重挂载（含 StrictMode 重放）
  // 会重新执行，保持 setup/cleanup 对称。
  const recoveredSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasRealSession || !sessionId || recoveredSessionRef.current === sessionId) return;
    recoveredSessionRef.current = sessionId;
    let cancelled = false;
    (async () => {
      try {
        const entries = await fetchBrandMaterialStatuses(apiPost, { workspaceId, sessionId });
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
                recoverable: true,
              }, ...current];
            });
          }
        }
      } catch {
        // 恢复失败不阻塞入口；下次挂载或身份变化时再试。
      } finally {
        if (cancelled) recoveredSessionRef.current = null;
      }
    })();
    return () => { cancelled = true; };
  }, [apiPost, hasRealSession, sessionId, upsertCard, workspaceId]);

  const chooseFiles = useCallback(async () => {
    if (!canSubmit || !sessionId) return;
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
    }));
    setRows((current) => [...pendingRows, ...current]);
    try {
      const entries = await importBrandMaterialFiles(
        apiPost,
        { workspaceId, sessionId },
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
  }, [apiPost, canSubmit, nextKey, sessionId, workspaceId]);

  const submitText = useCallback(async () => {
    const text = pasteText.trim();
    if (!canSubmit || !sessionId || !text) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'pasted-text', label: '粘贴资料', status: 'processing' }, ...current]);
    try {
      const [entry] = await importBrandMaterialText(apiPost, { workspaceId, sessionId }, text);
      replaceRow(key, rowPatchFromEntry(entry));
      if (entry?.ok) {
        setPasteText('');
        setFormOpen(false);
      }
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, nextKey, pasteText, replaceRow, sessionId, workspaceId]);

  const submitWebsite = useCallback(async () => {
    const url = websiteUrl.trim();
    if (!canSubmit || !sessionId || !url) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'website-url', label: '官网资料', status: 'processing' }, ...current]);
    try {
      const [entry] = await importBrandMaterialWebsite(apiPost, { workspaceId, sessionId }, url);
      replaceRow(key, rowPatchFromEntry(entry));
      if (entry?.ok) {
        setWebsiteUrl('');
        setFormOpen(false);
      }
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, nextKey, replaceRow, sessionId, websiteUrl, workspaceId]);

  const retryOne = useCallback(async (row: MaterialRow) => {
    if (!canSubmit || !sessionId || !row.materialId) return;
    replaceRow(row.key, { status: 'processing', errorCode: undefined, recoverable: false });
    try {
      const [entry] = await retryBrandMaterial(
        apiPost,
        { workspaceId, sessionId },
        row.materialId,
      );
      replaceRow(row.key, rowPatchFromEntry(entry));
    } catch {
      replaceRow(row.key, { status: 'failed', errorCode: 'material_request_failed' });
    }
  }, [apiPost, canSubmit, replaceRow, sessionId, workspaceId]);

  return (
    <section
      aria-label="品牌材料导入"
      data-chat-material-import
      className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-1"
    >
      <button
        type="button"
        onClick={() => setFormOpen((open) => !open)}
        aria-expanded={formOpen}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
        导入品牌材料
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 transition-transform ${formOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {formOpen && (
        <div className="mt-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3">
          {!hasRealSession && (
            <p className="mb-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
              请先在当前聊天发送一条消息，建立真实 Session 后再导入材料。
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs leading-4 text-[var(--ink-muted)]">
              原材料先安全保存，再生成待确认事实；完成后确认卡片会出现在聊天里。
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
              disabled={!hasRealSession}
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
              disabled={!hasRealSession}
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
            <article key={row.key} className="rounded-lg bg-[var(--paper-elevated)] p-2.5 text-sm">
              <div className="flex items-start gap-2">
                {row.status === 'processing'
                  ? <Loader2 aria-label="处理中" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
                  : row.status === 'success'
                    ? <CheckCircle2 aria-label="成功" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
                    : <XCircle aria-label="失败" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {row.status === 'processing' && '正在保存并抽取…（完成后自动弹出确认卡）'}
                    {row.status === 'success' && `已生成 ${row.candidateCount ?? 0} 条待确认事实`}
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
                      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />仅重试此项
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
