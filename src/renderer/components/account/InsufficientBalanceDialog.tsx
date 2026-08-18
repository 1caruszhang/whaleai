import { CircleAlert } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';

interface InsufficientBalanceDialogProps {
  requiredPoints: number;
  currentPoints: number;
  onClose: () => void;
}

/**
 * 发起计费操作余额不足时的拦截弹窗（票 06）：如实展示「需 X 点 / 当前
 * Y 点」并给出充值引导；具体操作的 permit 预扣在票 07 接线。
 */
export default function InsufficientBalanceDialog({
  requiredPoints,
  currentPoints,
  onClose,
}: InsufficientBalanceDialogProps) {
  const { t } = useTranslation('common');
  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[210] p-4">
      <div
        role="alertdialog"
        aria-label={t('account.insufficientTitle')}
        className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-3">
          <CircleAlert className="h-5 w-5 shrink-0 text-[var(--warning)]" />
          <h2 className="text-base font-semibold text-[var(--ink)]">
            {t('account.insufficientTitle')}
          </h2>
        </div>
        <p className="mt-3 text-sm leading-6 text-[var(--ink-secondary)]">
          {t('account.insufficientBody', { required: requiredPoints, current: currentPoints })}
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">
          {t('account.insufficientRecharge')}
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
          >
            {t('account.insufficientClose')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
