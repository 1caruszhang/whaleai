import {
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  Link,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';

import {
  importBrandMaterialFiles,
  importBrandMaterialText,
  importBrandMaterialWebsite,
  retryBrandMaterial,
  type BrandMaterialProcessResult,
} from '@/api/brandMaterialClient';
import { useTabApi, useTabState } from '@/context/TabContext';
import { isPendingSessionId } from '../../../shared/constants';

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
}

interface XiaojingMaterialImportPanelProps {
  workspaceId: string;
}

function displayNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 180) || '品牌材料';
}

function resultPatch(result: BrandMaterialProcessResult): Partial<MaterialRow> {
  if (result.ok) {
    return {
      status: 'success',
      materialId: result.material.id,
      candidateCount: result.candidateIds.length,
      errorCode: undefined,
    };
  }
  return {
    status: 'failed',
    materialId: result.materialId,
    errorCode: result.errorCode,
    candidateCount: undefined,
  };
}

export default memo(function XiaojingMaterialImportPanel({
  workspaceId,
}: XiaojingMaterialImportPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [pasteText, setPasteText] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const nextRowIdRef = useRef(0);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const processing = rows.some((row) => row.status === 'processing');
  const canSubmit = hasRealSession && !processing;

  const nextKey = useCallback(() => {
    nextRowIdRef.current += 1;
    return `material-input-${nextRowIdRef.current}`;
  }, []);

  const replaceRow = useCallback((key: string, patch: Partial<MaterialRow>) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  }, []);

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
      const results = await importBrandMaterialFiles(
        apiPost,
        { workspaceId, sessionId },
        paths,
      );
      setRows((current) => current.map((row) => {
        const index = pendingRows.findIndex((pending) => pending.key === row.key);
        return index >= 0
          ? { ...row, ...resultPatch(results[index] ?? { ok: false, errorCode: 'material_processing_failed' }) }
          : row;
      }));
    } catch {
      setRows((current) => current.map((row) => pendingRows.some((pending) => pending.key === row.key)
        ? { ...row, status: 'failed', errorCode: 'material_import_failed' }
        : row));
    }
  }, [apiPost, canSubmit, nextKey, sessionId, workspaceId]);

  const submitText = useCallback(async () => {
    const text = pasteText.trim();
    if (!canSubmit || !sessionId || !text) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'pasted-text', label: '粘贴资料', status: 'processing' }, ...current]);
    try {
      const result = await importBrandMaterialText(apiPost, { workspaceId, sessionId }, text);
      replaceRow(key, resultPatch(result));
      if (result.ok) setPasteText('');
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'material_import_failed' });
    }
  }, [apiPost, canSubmit, nextKey, pasteText, replaceRow, sessionId, workspaceId]);

  const submitWebsite = useCallback(async () => {
    const url = websiteUrl.trim();
    if (!canSubmit || !sessionId || !url) return;
    const key = nextKey();
    setRows((current) => [{ key, kind: 'website-url', label: '官网资料', status: 'processing' }, ...current]);
    try {
      const result = await importBrandMaterialWebsite(apiPost, { workspaceId, sessionId }, url);
      replaceRow(key, resultPatch(result));
      if (result.ok) setWebsiteUrl('');
    } catch {
      replaceRow(key, { status: 'failed', errorCode: 'website_fetch_failed' });
    }
  }, [apiPost, canSubmit, nextKey, replaceRow, sessionId, websiteUrl, workspaceId]);

  const retryOne = useCallback(async (row: MaterialRow) => {
    if (!canSubmit || !sessionId || !row.materialId) return;
    replaceRow(row.key, { status: 'processing', errorCode: undefined });
    try {
      const result = await retryBrandMaterial(
        apiPost,
        { workspaceId, sessionId },
        row.materialId,
      );
      replaceRow(row.key, resultPatch(result));
    } catch {
      replaceRow(row.key, { status: 'failed', errorCode: 'material_processing_failed' });
    }
  }, [apiPost, canSubmit, replaceRow, sessionId, workspaceId]);

  return (
    <section
      aria-label="品牌材料"
      className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">品牌材料</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
            原材料先安全保存，再生成待确认事实。
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void chooseFiles(); }}
          disabled={!canSubmit}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          <FileUp className="h-3.5 w-3.5" />选择文件
        </button>
      </div>

      {!hasRealSession && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          请先在当前聊天发送一条消息，建立真实 Session 后再导入材料。
        </p>
      )}

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

      {rows.length > 0 && (
        <div className="mt-4 space-y-2" role="region" aria-label="材料处理结果">
          {rows.map((row) => (
            <article key={row.key} className="rounded-lg bg-[var(--paper)] p-2.5 text-sm">
              <div className="flex items-start gap-2">
                {row.status === 'processing'
                  ? <Loader2 aria-label="处理中" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
                  : row.status === 'success'
                    ? <CheckCircle2 aria-label="成功" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
                    : <XCircle aria-label="失败" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {row.status === 'processing' && '正在保存并抽取…'}
                    {row.status === 'success' && `已生成 ${row.candidateCount ?? 0} 条待确认事实`}
                    {row.status === 'failed' && `处理失败：${row.errorCode ?? 'material_processing_failed'}`}
                  </p>
                  {row.materialId && (
                    <p className="mt-1 break-all font-mono text-xs text-[var(--ink-subtle)]">
                      materialId: {row.materialId}
                    </p>
                  )}
                </div>
                {row.status === 'failed' && row.materialId && (
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
    </section>
  );
});
