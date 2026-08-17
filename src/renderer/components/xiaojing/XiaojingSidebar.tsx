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
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type {
  BrandSession,
  BrandSessionDeletionPreview,
  BrandWorkspace,
  BrandWorkspaceDeletionPreview,
} from '@/api/brandWorkspaceClient';
import type { SessionDeleteResult } from '@/api/tauriClient';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToastOptional } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import xiaojingLogo from '@/assets/brand/xiaojing-logo.png';
import type { BrandWorkspaceState } from '@/hooks/useBrandWorkspaces';
import { useResolvedTheme } from '@/theme';
import type { Tab } from '@/types/tab';
import type { GeoSessionStatus } from '../../../shared/geo/notification';

const GEO_STATUS_PRIORITY: readonly GeoSessionStatus[] = [
  'awaiting-confirmation',
  'failed',
  'running',
  'queued',
  'ready',
  'completed',
];

const GEO_STATUS_STYLE: Record<GeoSessionStatus, string> = {
  'awaiting-confirmation': 'bg-[var(--warning)]/12 text-[var(--warning)]',
  failed: 'bg-[var(--error)]/10 text-[var(--error)]',
  running: 'bg-[var(--accent)]/10 text-[var(--accent)]',
  queued: 'bg-[var(--info)]/10 text-[var(--info)]',
  ready: 'bg-[var(--success)]/10 text-[var(--success)]',
  completed: 'bg-[var(--success)]/10 text-[var(--success)]',
};

interface XiaojingSidebarProps {
  brandState: BrandWorkspaceState;
  activeTab: Tab | undefined;
  onOpenWorkspace: (workspace: BrandWorkspace) => Promise<boolean>;
  onOpenSession: (session: BrandSession, workspace: BrandWorkspace) => Promise<boolean>;
  onRenameSession: (session: BrandSession, workspace: BrandWorkspace, title: string) => Promise<void>;
  onDeleteSession: (preview: BrandSessionDeletionPreview) => Promise<SessionDeleteResult>;
  onDeleteBrand: (preview: BrandWorkspaceDeletionPreview) => Promise<SessionDeleteResult>;
  onOpenSettings: () => void;
  onOpenBrandArchive: () => void;
}

export default memo(function XiaojingSidebar({
  brandState,
  activeTab,
  onOpenWorkspace,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onDeleteBrand,
  onOpenSettings,
  onOpenBrandArchive,
}: XiaojingSidebarProps) {
  const { t, i18n } = useTranslation('common');
  const resolvedTheme = useResolvedTheme();
  const themeLocale = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  const toast = useToastOptional();
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
    previewWorkspaceDeletion,
    removeDeletedSessionProjection,
  } = brandState;
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [brandName, setBrandName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletionPreview, setDeletionPreview] = useState<BrandSessionDeletionPreview | null>(null);
  const [brandDeletionPreview, setBrandDeletionPreview] = useState<BrandWorkspaceDeletionPreview | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const workspaceGeoStatus = GEO_STATUS_PRIORITY.find((status) => (
    sessions.some((session) => session.geoStatus === status)
  ));

  const closeCreateDialog = useCallback(() => {
    if (busy) return;
    setCreateOpen(false);
  }, [busy]);
  const closeDeletionDialog = useCallback(() => {
    if (busy) return;
    setDeletionPreview(null);
    setBrandDeletionPreview(null);
    setDeleteError(null);
  }, [busy]);

  useCloseLayer(() => {
    if (!deletionPreview && !brandDeletionPreview) return false;
    closeDeletionDialog();
    return true;
  }, 210);
  useCloseLayer(() => {
    if (!createOpen) return false;
    closeCreateDialog();
    return true;
  }, 200);

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
      // 方案 D：创建只需要品牌名；产品线（领域）由材料导入→知识裁决时
      // 从「行业」事实同步，零产品线品牌因此不会死锁。
      const workspace = await createWorkspace(brandName, []);
      setCreateOpen(false);
      setBrandName('');
      await onOpenWorkspace(workspace);
    } finally {
      setBusy(false);
    }
  }, [brandName, busy, createWorkspace, onOpenWorkspace]);

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
      setDeleteError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast?.error(t('xiaojingSidebar.deletePreviewFailed', { message }));
    } finally {
      setBusy(false);
    }
  }, [busy, currentWorkspace, previewDeletion, t, toast]);

  const confirmDelete = useCallback(async () => {
    if (!deletionPreview || busy) return;
    setBusy(true);
    try {
      const result = await onDeleteSession(deletionPreview);
      if (!result.deleted) {
        setDeleteError(result.message ?? t(
          `xiaojingSidebar.deleteFailed.${result.reason}`,
          { defaultValue: t('xiaojingSidebar.deleteFailed.generic') },
        ));
        return;
      }
      removeDeletedSessionProjection(deletionPreview.workspaceId, deletionPreview.sessionId);
      setDeletionPreview(null);
      setDeleteError(null);
    } finally {
      setBusy(false);
    }
  }, [busy, deletionPreview, onDeleteSession, removeDeletedSessionProjection, t]);

  const requestBrandDelete = useCallback(async (workspace: BrandWorkspace) => {
    if (busy) return;
    setBusy(true);
    setBrandMenuOpen(false);
    try {
      setBrandDeletionPreview(await previewWorkspaceDeletion(workspace.id));
      setDeleteError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast?.error(t('xiaojingSidebar.brandDeletePreviewFailed', { message }));
    } finally {
      setBusy(false);
    }
  }, [busy, previewWorkspaceDeletion, t, toast]);

  const confirmBrandDelete = useCallback(async () => {
    if (!brandDeletionPreview || busy) return;
    setBusy(true);
    try {
      const result = await onDeleteBrand(brandDeletionPreview);
      if (!result.deleted) {
        setDeleteError(result.message ?? t(
          `xiaojingSidebar.deleteFailed.${result.reason}`,
          { defaultValue: t('xiaojingSidebar.deleteFailed.generic') },
        ));
        return;
      }
      setBrandDeletionPreview(null);
      setDeleteError(null);
    } finally {
      setBusy(false);
    }
  }, [brandDeletionPreview, busy, onDeleteBrand, t]);

  return (
    <aside aria-label={t('xiaojingSidebar.ariaLabel')} className="relative z-40 flex h-screen w-[248px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--xiaojing-sidebar-bg)] text-[var(--ink)]" data-xiaojing-sidebar>
      <div className="custom-titlebar h-11 shrink-0" data-tauri-drag-region />
      <div className="flex items-center gap-3 px-4 pb-5 pt-2">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm"><img src={xiaojingLogo} alt="" className="h-9 w-9 object-contain" /></div>
        <div className="min-w-0"><p className="theme-product-wordmark truncate text-base font-semibold">{resolvedTheme.hero.productName}</p><p className="mt-0.5 truncate text-xs font-medium text-[var(--accent)]">{resolvedTheme.hero.slogans[themeLocale]}</p></div>
      </div>

      <div className="px-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">{t('xiaojingSidebar.currentBrand')}</p>
          <button type="button" aria-label={t('xiaojingSidebar.createBrand')} onClick={() => setCreateOpen(true)} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"><Plus className="h-3.5 w-3.5" /></button>
        </div>
        <div className="relative">
          <button type="button" onClick={() => setBrandMenuOpen((value) => !value)} aria-expanded={brandMenuOpen} className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-3 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-sm font-semibold text-[var(--accent)]">{currentWorkspace?.name.slice(0, 1) || '鲸'}</span>
            <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="block min-w-0 flex-1 truncate text-sm font-medium">{currentWorkspace?.name || t('xiaojingSidebar.noBrand')}</span>{workspaceGeoStatus && <span aria-label={t(`xiaojingSidebar.geoStatus.${workspaceGeoStatus}`)} className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold ${GEO_STATUS_STYLE[workspaceGeoStatus]}`}>{t(`xiaojingSidebar.geoStatus.${workspaceGeoStatus}`)}</span>}</span><span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">{currentWorkspace ? t('xiaojingSidebar.productLineCount', { count: currentWorkspace.productLines.length }) : t('xiaojingSidebar.startFromBrand')}</span></span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--ink-muted)] transition-transform ${brandMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          {brandMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
              {workspaces.map((workspace) => <div key={workspace.id} className="group/brand flex w-full items-center gap-1"><button type="button" onClick={() => void openBrand(workspace)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-xs text-[var(--accent)]">{workspace.name.slice(0, 1)}</span><span className="truncate">{workspace.name}</span></button><button type="button" aria-label={t('xiaojingSidebar.deleteBrand', { name: workspace.name })} title={t('xiaojingSidebar.deleteBrand', { name: workspace.name })} onClick={() => void requestBrandDelete(workspace)} className="shrink-0 rounded-md p-1.5 text-[var(--ink-subtle)] opacity-0 hover:bg-[var(--error)]/10 hover:text-[var(--error)] focus-visible:opacity-100 group-hover/brand:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></div>)}
              <button type="button" onClick={() => { setBrandMenuOpen(false); setCreateOpen(true); }} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--accent)] hover:bg-[var(--hover-bg)]"><Plus className="h-4 w-4" />{t('xiaojingSidebar.createNewBrand')}</button>
            </div>
          )}
        </div>
        <button type="button" onClick={() => currentWorkspace && void onOpenWorkspace(currentWorkspace)} disabled={!currentWorkspace || busy} className="mt-3 flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"><LayoutDashboard className="h-4 w-4" /><span>{t('xiaojingSidebar.brandOverview')}</span></button>
        <button type="button" onClick={() => currentWorkspace && void onOpenWorkspace(currentWorkspace)} disabled={!currentWorkspace || busy} className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}{t('xiaojingSidebar.newSession')}</button>

        {/* 票 30：品牌级一级导航。跟随当前选中品牌、不依赖任何 Session；
            「效果」入口由票 31 复用该机制加入。 */}
        <nav aria-label={t('xiaojingSidebar.primaryNav')} className="mt-4" data-xiaojing-primary-nav>
          <button type="button" onClick={onOpenBrandArchive} aria-current={activeTab?.view === 'brand-archive' ? 'page' : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${activeTab?.view === 'brand-archive' ? 'bg-[var(--accent-warm-subtle)] font-medium text-[var(--ink)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'}`}>
            <Archive className="h-4 w-4" />
            <span>{t('xiaojingSidebar.brandArchive')}</span>
          </button>
        </nav>
      </div>

      <section className="mt-6 flex min-h-0 flex-1 flex-col" aria-label={t('xiaojingSidebar.sessions')}>
        <div className="flex items-center justify-between px-4 pb-2"><h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">{t('xiaojingSidebar.sessions')}</h2><span className="text-xs tabular-nums text-[var(--ink-subtle)]">{sessions.length}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--ink-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('xiaojingSidebar.loadingBrand')}</div>
            : error ? <p className="mx-2 rounded-xl border border-[var(--error)]/30 px-3 py-3 text-xs text-[var(--error)]">{error}</p>
              : sessions.length === 0 ? <div className="mx-2 rounded-xl border border-dashed border-[var(--line)] px-3 py-5 text-center"><MessagesSquare className="mx-auto h-5 w-5 text-[var(--ink-subtle)]" /><p className="mt-2 text-xs text-[var(--ink-muted)]">{currentWorkspace ? t('xiaojingSidebar.emptyBrand') : t('xiaojingSidebar.createBrandFirst')}</p></div>
                : sessions.map((session) => {
                  const active = activeTab?.view === 'chat' && activeTab.sessionId === session.id;
                  return (
                    <div key={session.id} className="group relative mb-1">
                      {renamingId === session.id ? (
                        <form onSubmit={(event) => { event.preventDefault(); void submitRename(session); }} className="flex items-center gap-1 px-2 py-1"><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={120} className="min-w-0 flex-1 rounded-lg border border-[var(--accent)] bg-[var(--paper-elevated)] px-2 py-1.5 text-sm outline-none" /><button type="button" aria-label={t('xiaojingSidebar.cancelRename')} onClick={() => setRenamingId(null)} className="p-1 text-[var(--ink-muted)]"><X className="h-4 w-4" /></button></form>
                      ) : (
                        <button type="button" onClick={() => currentWorkspace && void onOpenSession(session, currentWorkspace)} aria-current={active ? 'page' : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 pr-9 text-left transition-colors ${active ? 'bg-[var(--accent-warm-subtle)] text-[var(--ink)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]'}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'}`} /><span className="min-w-0 flex-1 truncate text-sm">{session.title || t('xiaojingSidebar.untitledSession')}</span>{session.geoStatus && <span aria-label={t(`xiaojingSidebar.geoStatus.${session.geoStatus}`)} className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold ${GEO_STATUS_STYLE[session.geoStatus]}`}>{t(`xiaojingSidebar.geoStatus.${session.geoStatus}`)}</span>}</button>
                      )}
                      {renamingId !== session.id && <button type="button" aria-label={t('xiaojingSidebar.manageSession', { title: session.title })} onClick={() => setSessionMenuId((value) => value === session.id ? null : session.id)} className="absolute right-2 top-1.5 rounded-md p-1 opacity-0 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] group-hover:opacity-100 focus:opacity-100"><MoreHorizontal className="h-4 w-4" /></button>}
                      {sessionMenuId === session.id && currentWorkspace && (
                        <div className="absolute right-2 top-8 z-50 w-36 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                          <button type="button" onClick={() => { setSessionMenuId(null); setRenamingId(session.id); setRenameValue(session.title); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"><Pencil className="h-3.5 w-3.5" />{t('xiaojingSidebar.rename')}</button>
                          <button type="button" onClick={() => { setSessionMenuId(null); void archiveSession(currentWorkspace.id, session.id, true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"><Archive className="h-3.5 w-3.5" />{t('xiaojingSidebar.archive')}</button>
                          <button type="button" onClick={() => void requestDelete(session)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--error)]/10"><Trash2 className="h-3.5 w-3.5" />{t('xiaojingSidebar.permanentDelete')}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
        </div>
      </section>
      <div className="border-t border-[var(--line-subtle)] px-3 py-2">
        <button type="button" onClick={onOpenSettings} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs tracking-wide text-[var(--ink-subtle)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]">
          <Settings className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">{t('xiaojingSidebar.footer')}</span>
        </button>
      </div>

      {createOpen && createPortal(
        <OverlayBackdrop onClose={closeCreateDialog} className="z-[200] p-4">
          <form onSubmit={(event) => { event.preventDefault(); void submitBrand(); }} className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
            <div className="flex items-center justify-between"><h2 className="text-base font-semibold">{t('xiaojingSidebar.createBrand')}</h2><button type="button" aria-label={t('xiaojingSidebar.closeCreateBrand')} onClick={closeCreateDialog} className="p-1 text-[var(--ink-muted)]"><X className="h-4 w-4" /></button></div>
            <label className="mt-5 block text-sm text-[var(--ink-secondary)]">{t('xiaojingSidebar.brandName')}<input autoFocus value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 outline-none focus:border-[var(--accent)]" /></label>
            <p className="mt-3 text-xs leading-5 text-[var(--ink-muted)]">{t('xiaojingSidebar.productLineHint')}</p>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={closeCreateDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">{t('xiaojingSidebar.cancel')}</button><button type="submit" disabled={!brandName.trim() || busy} className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] disabled:opacity-50">{t('xiaojingSidebar.createAndEnter')}</button></div>
          </form>
        </OverlayBackdrop>,
        document.body,
      )}

      {brandDeletionPreview && createPortal(
        <OverlayBackdrop onClose={closeDeletionDialog} className="z-[210] p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--error)]">{t('xiaojingSidebar.brandDeleteTitle', { name: brandDeletionPreview.name })}</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--ink-secondary)]">{t('xiaojingSidebar.brandDeleteScope', { ...brandDeletionPreview.scope })}</p>
            <p className="mt-2 text-xs leading-5 text-[var(--error)]">{t('xiaojingSidebar.brandDeleteIrreversible')}</p>
            {deleteError && <p role="alert" className="mt-3 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs leading-5 text-[var(--error)]">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={closeDeletionDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">{t('xiaojingSidebar.cancel')}</button><button type="button" onClick={() => void confirmBrandDelete()} disabled={busy} className="rounded-lg bg-[var(--error)] px-4 py-2 text-sm font-semibold text-[var(--on-error)] disabled:opacity-50">{t('xiaojingSidebar.brandDeleteConfirm')}</button></div>
          </div>
        </OverlayBackdrop>,
        document.body,
      )}

      {deletionPreview && createPortal(
        <OverlayBackdrop onClose={closeDeletionDialog} className="z-[210] p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--error)]">{t('xiaojingSidebar.deleteTitle', { title: deletionPreview.title })}</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--ink-secondary)]">{t('xiaojingSidebar.deleteScope', { ...deletionPreview.scope, ...deletionPreview.retained })}</p>
            {deleteError && <p role="alert" className="mt-3 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs leading-5 text-[var(--error)]">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={closeDeletionDialog} className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">{t('xiaojingSidebar.cancel')}</button><button type="button" onClick={() => void confirmDelete()} disabled={busy} autoFocus className="rounded-lg bg-[var(--error)] px-4 py-2 text-sm font-semibold text-[var(--on-error)] disabled:opacity-50">{t('xiaojingSidebar.permanentDelete')}</button></div>
          </div>
        </OverlayBackdrop>,
        document.body,
      )}
    </aside>
  );
});
