import {
  Archive,
  ChevronDown,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import type {
  BrandSession,
  BrandSessionDeletionPreview,
  BrandWorkspace,
} from '@/api/brandWorkspaceClient';
import xiaojingLogo from '@/assets/brand/xiaojing-logo.png';
import type { BrandWorkspaceState } from '@/hooks/useBrandWorkspaces';
import type { Tab } from '@/types/tab';
import { XIAOJING_PRODUCT } from '../../../shared/product';

interface XiaojingSidebarProps {
  brandState: BrandWorkspaceState;
  activeTab: Tab | undefined;
  onOpenWorkspace: (workspace: BrandWorkspace) => Promise<boolean>;
  onOpenSession: (session: BrandSession, workspace: BrandWorkspace) => Promise<boolean>;
  onRenameSession: (session: BrandSession, workspace: BrandWorkspace, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
}

export default memo(function XiaojingSidebar({
  brandState,
  activeTab,
  onOpenWorkspace,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
}: XiaojingSidebarProps) {
  const {
    workspaces,
    currentWorkspace,
    sessions,
    isLoading,
    error,
    createWorkspace,
    switchWorkspace,
    archiveSession,
    previewDeletion,
    confirmDeletion,
  } = brandState;
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [brandName, setBrandName] = useState('');
  const [productLines, setProductLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletionPreview, setDeletionPreview] = useState<BrandSessionDeletionPreview | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const openBrand = useCallback(async (workspace: BrandWorkspace) => {
    if (busy) return;
    setBusy(true);
    setBrandMenuOpen(false);
    try {
      const selected = currentWorkspace?.id === workspace.id
        ? workspace
        : await switchWorkspace(workspace.id);
      await onOpenWorkspace(selected);
    } finally {
      setBusy(false);
    }
  }, [busy, currentWorkspace?.id, onOpenWorkspace, switchWorkspace]);

  const submitBrand = useCallback(async () => {
    if (!brandName.trim() || busy) return;
    setBusy(true);
    try {
      const workspace = await createWorkspace(
        brandName,
        productLines.split(/[，,\n]/).map((value) => value.trim()).filter(Boolean),
      );
      setCreateOpen(false);
      setBrandName('');
      setProductLines('');
      await onOpenWorkspace(workspace);
    } finally {
      setBusy(false);
    }
  }, [brandName, busy, createWorkspace, onOpenWorkspace, productLines]);

  const submitRename = useCallback(async (session: BrandSession) => {
    if (!currentWorkspace || !renameValue.trim() || busy) return;
    setBusy(true);
    try {
      await onRenameSession(session, currentWorkspace, renameValue.trim());
      setRenamingId(null);
      setRenameValue('');
    } finally {
      setBusy(false);
    }
  }, [busy, currentWorkspace, onRenameSession, renameValue]);

  const requestDelete = useCallback(async (session: BrandSession) => {
    if (!currentWorkspace || busy) return;
    setBusy(true);
    setSessionMenuId(null);
    try {
      setDeletionPreview(await previewDeletion(currentWorkspace.id, session.id));
      setDeleteConfirmation('');
    } finally {
      setBusy(false);
    }
  }, [busy, currentWorkspace, previewDeletion]);

  const confirmDelete = useCallback(async () => {
    if (!deletionPreview || deleteConfirmation !== '永久删除' || busy) return;
    setBusy(true);
    try {
      const deleted = await onDeleteSession(deletionPreview.sessionId);
      if (!deleted) return;
      await confirmDeletion(
        deletionPreview.workspaceId,
        deletionPreview.sessionId,
        deletionPreview.confirmationToken,
      );
      setDeletionPreview(null);
      setDeleteConfirmation('');
    } finally {
      setBusy(false);
    }
  }, [busy, confirmDeletion, deleteConfirmation, deletionPreview, onDeleteSession]);

  return (
    <aside aria-label="小鲸同学品牌与会话" className="relative z-40 flex h-screen w-[248px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--global-sidebar-bg)] text-[var(--ink)]" data-xiaojing-sidebar>
      <div className="custom-titlebar h-11 shrink-0" data-tauri-drag-region />
      <div className="flex items-center gap-3 px-4 pb-5 pt-2">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm"><img src={xiaojingLogo} alt="" className="h-9 w-9 object-contain" /></div>
        <div className="min-w-0"><p className="truncate text-base font-semibold tracking-wide">{XIAOJING_PRODUCT.displayName}</p><p className="mt-0.5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">GEO 营销</p></div>
      </div>

      <div className="px-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">当前品牌</p>
          <button type="button" aria-label="创建品牌" onClick={() => setCreateOpen(true)} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"><Plus className="h-3.5 w-3.5" /></button>
        </div>
        <div className="relative">
          <button type="button" onClick={() => setBrandMenuOpen((value) => !value)} aria-expanded={brandMenuOpen} className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-3 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-sm font-semibold text-[var(--accent)]">{currentWorkspace?.name.slice(0, 1) || '鲸'}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{currentWorkspace?.name || '尚未创建品牌'}</span><span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">{currentWorkspace ? `${currentWorkspace.productLines.length} 条产品线` : '从品牌入口开始'}</span></span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--ink-muted)] transition-transform ${brandMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          {brandMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
              {workspaces.map((workspace) => <button key={workspace.id} type="button" onClick={() => void openBrand(workspace)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-xs text-[var(--accent)]">{workspace.name.slice(0, 1)}</span><span className="truncate">{workspace.name}</span></button>)}
              <button type="button" onClick={() => { setBrandMenuOpen(false); setCreateOpen(true); }} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--accent)] hover:bg-[var(--hover-bg)]"><Plus className="h-4 w-4" />创建新品牌</button>
            </div>
          )}
        </div>
        <button type="button" onClick={() => currentWorkspace && void onOpenWorkspace(currentWorkspace)} disabled={!currentWorkspace || busy} className="mt-3 flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"><LayoutDashboard className="h-4 w-4" /><span>品牌概览</span></button>
        <button type="button" onClick={() => currentWorkspace && void onOpenWorkspace(currentWorkspace)} disabled={!currentWorkspace || busy} className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}新建会话</button>
      </div>

      <section className="mt-6 flex min-h-0 flex-1 flex-col" aria-label="Session 列表">
        <div className="flex items-center justify-between px-4 pb-2"><h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">会话</h2><span className="text-xs tabular-nums text-[var(--ink-subtle)]">{sessions.length}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--ink-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载品牌</div>
            : error ? <p className="mx-2 rounded-xl border border-[var(--error)]/30 px-3 py-3 text-xs text-[var(--error)]">{error}</p>
              : sessions.length === 0 ? <div className="mx-2 rounded-xl border border-dashed border-[var(--line)] px-3 py-5 text-center"><MessagesSquare className="mx-auto h-5 w-5 text-[var(--ink-subtle)]" /><p className="mt-2 text-xs text-[var(--ink-muted)]">{currentWorkspace ? '这个品牌还没有会话' : '先创建一个品牌'}</p></div>
                : sessions.map((session) => {
                  const active = activeTab?.view === 'chat' && activeTab.sessionId === session.id;
                  return (
                    <div key={session.id} className="group relative mb-1">
                      {renamingId === session.id ? (
                        <form onSubmit={(event) => { event.preventDefault(); void submitRename(session); }} className="flex items-center gap-1 px-2 py-1"><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={120} className="min-w-0 flex-1 rounded-lg border border-[var(--accent)] bg-[var(--paper-elevated)] px-2 py-1.5 text-sm outline-none" /><button type="button" onClick={() => setRenamingId(null)} className="p-1 text-[var(--ink-muted)]"><X className="h-4 w-4" /></button></form>
                      ) : (
                        <button type="button" onClick={() => currentWorkspace && void onOpenSession(session, currentWorkspace)} aria-current={active ? 'page' : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 pr-9 text-left transition-colors ${active ? 'bg-[var(--accent-warm-subtle)] text-[var(--ink)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]'}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'}`} /><span className="min-w-0 flex-1 truncate text-sm">{session.title || '新会话'}</span></button>
                      )}
                      {renamingId !== session.id && <button type="button" aria-label={`管理会话 ${session.title}`} onClick={() => setSessionMenuId((value) => value === session.id ? null : session.id)} className="absolute right-2 top-1.5 rounded-md p-1 opacity-0 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] group-hover:opacity-100 focus:opacity-100"><MoreHorizontal className="h-4 w-4" /></button>}
                      {sessionMenuId === session.id && currentWorkspace && (
                        <div className="absolute right-2 top-8 z-50 w-36 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                          <button type="button" onClick={() => { setSessionMenuId(null); setRenamingId(session.id); setRenameValue(session.title); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"><Pencil className="h-3.5 w-3.5" />重命名</button>
                          <button type="button" onClick={() => { setSessionMenuId(null); void archiveSession(currentWorkspace.id, session.id, true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"><Archive className="h-3.5 w-3.5" />归档</button>
                          <button type="button" onClick={() => void requestDelete(session)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--error)]/10"><Trash2 className="h-3.5 w-3.5" />永久删除</button>
                        </div>
                      )}
                    </div>
                  );
                })}
        </div>
      </section>
      <div className="border-t border-[var(--line-subtle)] px-4 py-3 text-xs tracking-wide text-[var(--ink-subtle)]">小鲸同学 · 本地品牌工作台</div>

      {createOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <form onSubmit={(event) => { event.preventDefault(); void submitBrand(); }} className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
            <div className="flex items-center justify-between"><h2 className="text-base font-semibold">创建品牌</h2><button type="button" onClick={() => setCreateOpen(false)} className="p-1 text-[var(--ink-muted)]"><X className="h-4 w-4" /></button></div>
            <label className="mt-5 block text-sm text-[var(--ink-secondary)]">品牌名称<input autoFocus value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 outline-none focus:border-[var(--accent)]" /></label>
            <label className="mt-4 block text-sm text-[var(--ink-secondary)]">产品线（可选，用逗号分隔）<textarea value={productLines} onChange={(event) => setProductLines(event.target.value)} className="mt-2 min-h-20 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 outline-none focus:border-[var(--accent)]" /></label>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">取消</button><button type="submit" disabled={!brandName.trim() || busy} className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] disabled:opacity-50">创建并进入</button></div>
          </form>
        </div>
      )}

      {deletionPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--error)]">永久删除“{deletionPreview.title}”</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--ink-secondary)]">将删除 {deletionPreview.scope.sessionRecords} 条 Session 索引和 {deletionPreview.scope.chatTranscripts} 份聊天记录。关联的品牌知识 {deletionPreview.retained.knowledgeFacts} 条、Operation {deletionPreview.retained.operations} 个、产物 {deletionPreview.retained.artifacts} 个、订单 {deletionPreview.retained.publishOrders} 个、观测 {deletionPreview.retained.observations} 条会完整保留。</p>
            <label className="mt-4 block text-sm text-[var(--ink-secondary)]">输入“永久删除”完成二次确认<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 outline-none focus:border-[var(--error)]" /></label>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeletionPreview(null)} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">取消</button><button type="button" onClick={() => void confirmDelete()} disabled={deleteConfirmation !== '永久删除' || busy} className="rounded-lg bg-[var(--error)] px-4 py-2 text-sm font-semibold text-[var(--on-error)] disabled:opacity-50">永久删除</button></div>
          </div>
        </div>
      )}
    </aside>
  );
});
