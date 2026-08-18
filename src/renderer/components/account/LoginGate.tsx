import { Loader2, LockKeyhole, Smartphone } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import xiaojingLogo from '@/assets/brand/xiaojing-logo.png';
import { useAccountApi } from '@/context/AccountContext';
import { useResolvedTheme } from '@/theme';

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 全屏登录门（票 06）：手机号+密码+协议勾选；首登强制改密与宽限超期的
 * 变体由 props 表达。登录/改密全部经 Rust 账号 owner，renderer 不经手
 * token。协议勾选按「首次登录」语义：设备已同意过（Rust 投影）则预勾选。
 */
export function LoginScreen({
  graceExpired,
  agreementAccepted,
}: {
  graceExpired: boolean;
  agreementAccepted: boolean;
}) {
  const { t } = useTranslation('common');
  const resolvedTheme = useResolvedTheme();
  const accountApi = useAccountApi();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedAgreement, setAcceptedAgreement] = useState(agreementAccepted);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!PHONE_PATTERN.test(phone.trim())) {
      setError(t('account.invalidPhone'));
      return;
    }
    if (!password) {
      setError(t('account.missingPassword'));
      return;
    }
    if (!acceptedAgreement) {
      setError(t('account.agreementRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await accountApi.login(phone.trim(), password, true);
    setBusy(false);
    if (failure) setError(failure);
  }, [acceptedAgreement, accountApi, busy, password, phone, t]);

  return (
    <LoginShell>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm">
          <img src={xiaojingLogo} alt="" className="h-11 w-11 object-contain" />
        </div>
        <div>
          <p className="theme-product-wordmark text-xl font-semibold text-[var(--ink)]">
            {resolvedTheme.hero.productName}
          </p>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('account.loginSubtitle')}</p>
        </div>
      </div>

      {graceExpired && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs leading-5 text-[var(--warning)]"
        >
          {t('account.graceExpiredNotice')}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <label className="block text-xs font-medium text-[var(--ink-secondary)]">
          {t('account.phone')}
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 focus-within:border-[var(--focus-border)]">
            <Smartphone className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
            <input
              aria-label={t('account.phone')}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="numeric"
              autoComplete="tel"
              maxLength={11}
              disabled={busy}
              className="w-full bg-transparent text-base text-[var(--ink)] outline-none"
            />
          </div>
        </label>
        <label className="block text-xs font-medium text-[var(--ink-secondary)]">
          {t('account.password')}
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 focus-within:border-[var(--focus-border)]">
            <LockKeyhole className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
            <input
              aria-label={t('account.password')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className="w-full bg-transparent text-base text-[var(--ink)] outline-none"
            />
          </div>
        </label>
        <label className="flex items-start gap-2 pt-1 text-xs leading-5 text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            checked={acceptedAgreement}
            onChange={(event) => setAcceptedAgreement(event.target.checked)}
            disabled={busy}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
          />
          {t('account.agreement')}
        </label>
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs leading-5 text-[var(--error)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !acceptedAgreement}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? t('account.loggingIn') : t('account.loginButton')}
        </button>
      </form>
    </LoginShell>
  );
}

/** 首登强制改密：完成前无法进入工作台（票 06 验收项）。 */
export function ChangePasswordScreen() {
  const { t } = useTranslation('common');
  const accountApi = useAccountApi();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!currentPassword) {
      setError(t('account.missingCurrentPassword'));
      return;
    }
    if (newPassword.trim().length < 8 || newPassword.trim().length > 128) {
      setError(t('account.invalidNewPassword'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('account.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await accountApi.changePassword(currentPassword, newPassword.trim());
    setBusy(false);
    if (failure) setError(failure);
  }, [accountApi, busy, confirmPassword, currentPassword, newPassword, t]);

  return (
    <LoginShell>
      <h1 className="text-xl font-semibold text-[var(--ink)]">{t('account.changePasswordTitle')}</h1>
      <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">{t('account.changePasswordHint')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mt-5 space-y-3"
      >
        <label className="block text-xs font-medium text-[var(--ink-secondary)]">
          {t('account.currentPassword')}
          <input
            type="password"
            aria-label={t('account.currentPassword')}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            disabled={busy}
            className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-base text-[var(--ink)] outline-none focus:border-[var(--focus-border)]"
          />
        </label>
        <label className="block text-xs font-medium text-[var(--ink-secondary)]">
          {t('account.newPassword')}
          <input
            type="password"
            aria-label={t('account.newPassword')}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            disabled={busy}
            className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-base text-[var(--ink)] outline-none focus:border-[var(--focus-border)]"
          />
        </label>
        <label className="block text-xs font-medium text-[var(--ink-secondary)]">
          {t('account.confirmPassword')}
          <input
            type="password"
            aria-label={t('account.confirmPassword')}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            disabled={busy}
            className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-base text-[var(--ink)] outline-none focus:border-[var(--focus-border)]"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 py-2 text-xs leading-5 text-[var(--error)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('account.changePasswordButton')}
        </button>
      </form>
    </LoginShell>
  );
}

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-[var(--paper)] px-6"
      data-account-login-gate
    >
      <div className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-xl">
        {children}
      </div>
    </div>
  );
}
