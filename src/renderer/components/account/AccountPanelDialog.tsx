import { Coins, FileText, Loader2, LogOut, RefreshCw, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatGraceDeadline } from '@/utils/accountFormat';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useAccountApi, useAccountState } from '@/context/AccountContext';
import ComplianceDocViewer from './ComplianceDocViewer';
import { COMPLIANCE_DOCS, type ComplianceDoc } from './complianceDocs';

/**
 * 左下角设置 → 个人信息（票 06）：手机号 / 点数余额 / 充值引导（对公转账
 * + 联系运营）/ 宽限状态 / 退出登录。只读展示 Rust 投影，不出现任何
 * 凭据或端口类信息。
 */
export default function AccountPanelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common');
  const state = useAccountState();
  const accountApi = useAccountApi();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [viewingDoc, setViewingDoc] = useState<ComplianceDoc | null>(null);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    const failure = await accountApi.refresh();
    setRefreshing(false);
    if (failure) setRefreshError(t('account.panelRefreshFailed'));
  };

  const logout = async () => {
    onClose();
    await accountApi.logout();
  };

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[210] p-4">
      <div
        role="dialog"
        aria-label={t('account.personalInfo')}
        className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ink)]">{t('account.personalInfo')}</h2>
          <button
            type="button"
            aria-label={t('account.close')}
            onClick={onClose}
            className="p-1 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-[var(--ink-muted)]">{t('account.phoneLabel')}</dt>
            <dd className="font-medium tabular-nums text-[var(--ink)]">{state.phone ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-1.5 text-[var(--ink-muted)]">
              <Coins className="h-3.5 w-3.5" />
              {t('account.pointsLabel')}
            </dt>
            <dd className="flex items-center gap-2">
              <span className="text-lg font-semibold tabular-nums text-[var(--accent)]">
                {state.points ?? '—'}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label={t('account.refreshButton')}
                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
              >
                {refreshing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                {refreshing ? t('account.refreshing') : t('account.refreshButton')}
              </button>
            </dd>
          </div>
          {state.offlineGrace.deadlineAt !== null && (
            <div className="flex items-center justify-between">
              <dt className="text-[var(--ink-muted)]">{t('account.graceLabel')}</dt>
              <dd className="text-xs tabular-nums text-[var(--ink-secondary)]">
                {t('account.graceUntil', { deadline: formatGraceDeadline(state.offlineGrace.deadlineAt) })}
              </dd>
            </div>
          )}
        </dl>
        {refreshError && (
          <p role="alert" className="mt-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]">
            {refreshError}
          </p>
        )}

        <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3">
          <p className="text-xs font-semibold text-[var(--ink-secondary)]">{t('account.rechargeGuide')}</p>
          <p className="mt-1.5 text-xs leading-5 text-[var(--ink-muted)]">{t('account.rechargeBody')}</p>
        </div>

        <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3">
          <p className="text-xs font-semibold text-[var(--ink-secondary)]">{t('account.complianceDocsSection')}</p>
          <div className="mt-1.5 space-y-0.5">
            {COMPLIANCE_DOCS.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => setViewingDoc(doc)}
                className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                {doc.title}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--error)]/40 px-3 py-2 text-sm text-[var(--error)] hover:bg-[var(--error)]/10"
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('account.logout')}
          </button>
        </div>
      </div>
      {viewingDoc && <ComplianceDocViewer doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
    </OverlayBackdrop>,
    document.body,
  );
}
