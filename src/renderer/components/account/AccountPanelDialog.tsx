import { Coins, FileText, Loader2, LogOut, ReceiptText, RefreshCw, Save, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatGraceDeadline, formatLedgerTime } from '@/utils/accountFormat';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useAccountApi, useAccountState } from '@/context/AccountContext';
import { fetchAccountLedger, type AccountLedgerEntry } from '@/api/accountClient';
import { fetchDistributionSpendLimits, saveDistributionSpendLimits } from '@/api/distributionSpendLimitsClient';
import {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  MAX_DISTRIBUTION_SPEND_LIMIT_POINTS,
} from '../../../shared/geo/distributionPlan';
import ComplianceDocViewer from './ComplianceDocViewer';
import { COMPLIANCE_DOCS, type ComplianceDoc } from './complianceDocs';

/**
 * 左下角设置 → 个人信息（票 06）：手机号 / 点数余额 / 充值引导（对公转账
 * + 联系运营）/ 点数明细 / 渠道分发限额 / 宽限状态 / 退出登录。不出现任何
 * 凭据或端口类信息。账本不落本地；非敏感分发限额由 config.json 持久化。
 */
export default function AccountPanelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('common');
  const state = useAccountState();
  const accountApi = useAccountApi();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [viewingDoc, setViewingDoc] = useState<ComplianceDoc | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledger, setLedger] = useState<AccountLedgerEntry[] | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [perArticleMaxPoints, setPerArticleMaxPoints] = useState(
    String(DEFAULT_DISTRIBUTION_SPEND_LIMITS.perArticleMaxPoints),
  );
  const [perExecutionMaxPoints, setPerExecutionMaxPoints] = useState(
    String(DEFAULT_DISTRIBUTION_SPEND_LIMITS.perExecutionMaxPoints),
  );
  const [limitsLoading, setLimitsLoading] = useState(true);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsMessage, setLimitsMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchDistributionSpendLimits()
      .then((limits) => {
        if (!active) return;
        setPerArticleMaxPoints(String(limits.perArticleMaxPoints));
        setPerExecutionMaxPoints(String(limits.perExecutionMaxPoints));
      })
      .catch(() => {
        if (active) setLimitsMessage(t('account.distributionLimitsLoadFailed'));
      })
      .finally(() => {
        if (active) setLimitsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const saveLimits = async () => {
    if (limitsSaving) return;
    const perArticle = Number(perArticleMaxPoints);
    const perExecution = Number(perExecutionMaxPoints);
    if (
      !Number.isInteger(perArticle) ||
      !Number.isInteger(perExecution) ||
      perArticle < 1 ||
      perExecution < 1 ||
      perArticle > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS ||
      perExecution > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS
    ) {
      setLimitsMessage(t('account.distributionLimitsInvalid'));
      return;
    }
    setLimitsSaving(true);
    setLimitsMessage(null);
    try {
      const saved = await saveDistributionSpendLimits({
        perArticleMaxPoints: perArticle,
        perExecutionMaxPoints: perExecution,
      });
      setPerArticleMaxPoints(String(saved.perArticleMaxPoints));
      setPerExecutionMaxPoints(String(saved.perExecutionMaxPoints));
      setLimitsMessage(t('account.distributionLimitsSaved'));
    } catch {
      setLimitsMessage(t('account.distributionLimitsSaveFailed'));
    } finally {
      setLimitsSaving(false);
    }
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    const failure = await accountApi.refresh();
    setRefreshing(false);
    if (failure) setRefreshError(t('account.panelRefreshFailed'));
  };

  const loadLedger = async () => {
    if (ledgerLoading) return;
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      setLedger(await fetchAccountLedger());
    } catch (error) {
      setLedger(null);
      setLedgerError(typeof error === 'string' && error.trim() ? error : t('account.ledgerLoadFailed'));
    } finally {
      setLedgerLoading(false);
    }
  };

  const toggleLedger = () => {
    if (ledgerOpen) {
      setLedgerOpen(false);
      return;
    }
    setLedgerOpen(true);
    // 首次展开时拉取；后续重开沿用已载结果，出错时允许重试。
    if (ledger === null && !ledgerLoading) void loadLedger();
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
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
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
              <span className="text-lg font-semibold tabular-nums text-[var(--accent)]">{state.points ?? '—'}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label={t('account.refreshButton')}
                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
              >
                {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {refreshing ? t('account.refreshing') : t('account.refreshButton')}
              </button>
              <button
                type="button"
                onClick={toggleLedger}
                aria-expanded={ledgerOpen}
                aria-label={t('account.ledgerButton')}
                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
              >
                <ReceiptText className="h-3 w-3" />
                {t('account.ledgerButton')}
              </button>
            </dd>
          </div>
          {state.offlineGrace.deadlineAt !== null && (
            <div className="flex items-center justify-between">
              <dt className="text-[var(--ink-muted)]">{t('account.graceLabel')}</dt>
              <dd className="text-xs tabular-nums text-[var(--ink-secondary)]">
                {t('account.graceUntil', {
                  deadline: formatGraceDeadline(state.offlineGrace.deadlineAt),
                })}
              </dd>
            </div>
          )}
        </dl>
        {refreshError && (
          <p
            role="alert"
            className="mt-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)]"
          >
            {refreshError}
          </p>
        )}

        {ledgerOpen && (
          <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3">
            <p className="text-xs font-semibold text-[var(--ink-secondary)]">{t('account.ledgerTitle')}</p>
            {ledgerLoading && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('account.ledgerLoading')}
              </p>
            )}
            {ledgerError && (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p role="alert" className="text-xs text-[var(--error)]">
                  {ledgerError}
                </p>
                <button
                  type="button"
                  onClick={() => void loadLedger()}
                  className="shrink-0 rounded-lg border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
                >
                  {t('account.ledgerRetry')}
                </button>
              </div>
            )}
            {ledger &&
              !ledgerLoading &&
              !ledgerError &&
              (ledger.length === 0 ? (
                <p className="mt-1.5 text-xs text-[var(--ink-muted)]">{t('account.ledgerEmpty')}</p>
              ) : (
                <ul className="mt-1.5 max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {ledger.map((entry) => (
                    <li key={entry.id} className="flex items-start justify-between gap-3 text-xs">
                      <div className="min-w-0">
                        <p className="truncate text-[var(--ink)]">
                          <span className="mr-1.5 rounded border border-[var(--line)] px-1 text-xs text-[var(--ink-muted)]">
                            {t(`account.ledgerKind.${entry.kind}`, {
                              defaultValue: entry.kind,
                            })}
                          </span>
                          {entry.summary}
                        </p>
                        <p className="mt-0.5 tabular-nums text-xs text-[var(--ink-subtle)]">
                          {formatLedgerTime(entry.createdAt)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <p
                          className={
                            entry.delta >= 0 ? 'font-medium text-[var(--success)]' : 'font-medium text-[var(--ink)]'
                          }
                        >
                          {entry.delta >= 0 ? `+${entry.delta}` : entry.delta}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">
                          {t('account.ledgerBalanceAfter', {
                            balance: entry.balanceAfter,
                          })}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3">
          <p className="text-xs font-semibold text-[var(--ink-secondary)]">{t('account.distributionLimitsTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">{t('account.distributionLimitsHint')}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-[var(--ink-muted)]">
              {t('account.perArticleMaxPoints')}
              <input
                type="number"
                min={1}
                max={MAX_DISTRIBUTION_SPEND_LIMIT_POINTS}
                step={1}
                value={perArticleMaxPoints}
                disabled={limitsLoading || limitsSaving}
                onChange={(event) => setPerArticleMaxPoints(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-2 text-sm tabular-nums text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="text-xs text-[var(--ink-muted)]">
              {t('account.perExecutionMaxPoints')}
              <input
                type="number"
                min={1}
                max={MAX_DISTRIBUTION_SPEND_LIMIT_POINTS}
                step={1}
                value={perExecutionMaxPoints}
                disabled={limitsLoading || limitsSaving}
                onChange={(event) => setPerExecutionMaxPoints(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-2 text-sm tabular-nums text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>
          {limitsMessage && (
            <p className="mt-2 text-xs text-[var(--ink-muted)]" role="status">
              {limitsMessage}
            </p>
          )}
          <button
            type="button"
            onClick={() => void saveLimits()}
            disabled={limitsLoading || limitsSaving}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-2 text-xs font-medium text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
          >
            {limitsSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {limitsSaving ? t('account.distributionLimitsSaving') : t('account.distributionLimitsSave')}
          </button>
        </div>

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
