import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApiErrorMessage } from '@/lib/api';
import {
  adjustAdminAccount,
  createAdminAccount,
  topupAdminAccount,
} from '@/lib/accounts';

/**
 * 账号列表页的三个操作对话框（票 47）：
 * - 建号：手机号 + 初始密码 + 可选用户名，客户端校验口径与既有 SSR 建号
 *   表单一致（手机号格式、密码 ≥8 位、用户名 ≤64 字符）；开通即赠点由
 *   后端 grant 流水落账。
 * - 充值：金额（元）+ 来源备注，接既有 POST /admin/ledger/topup
 *   （1 元 = 10 点，最小粒度 0.1 元）。
 * - 调点：可正可负 + 必填备注，接既有 POST /admin/ledger/adjust。
 * 成功后由调用方失效列表查询并关闭对话框；服务端语义错误（ApiError）
 * 原样展示，字段级校验在提交前本地拦截。
 */

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;
const DELTA_PATTERN = /^[+-]?\d{1,8}$/;

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

function SubmitError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  );
}

export interface CreateAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 建号成功后：父组件失效列表并关闭对话框。 */
  onCreated: () => void;
}

export function CreateAccountDialog({ open, onOpenChange, onCreated }: CreateAccountDialogProps) {
  const [phone, setPhone] = useState('');
  const [initialPassword, setInitialPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    phone?: string;
    initialPassword?: string;
    displayName?: string;
  }>({});
  const [submitError, setSubmitError] = useState('');

  const createMutation = useMutation({
    mutationFn: createAdminAccount,
    onSuccess: () => {
      reset();
      onCreated();
    },
    onError: error => {
      setSubmitError(adminApiErrorMessage(error, '建号失败，请稍后重试。'));
    },
  });

  function reset() {
    setPhone('');
    setInitialPassword('');
    setDisplayName('');
    setFieldErrors({});
    setSubmitError('');
  }

  /** 与既有 SSR 建号表单同口径：手机号格式、密码 ≥8 位、用户名 ≤64 字符。 */
  function validate(): boolean {
    const errors: typeof fieldErrors = {};
    if (!PHONE_PATTERN.test(phone.trim())) errors.phone = '手机号格式不正确';
    if (initialPassword.length < 8) errors.initialPassword = '初始密码至少 8 位';
    if (Array.from(displayName.trim()).length > 64) errors.displayName = '用户名最长 64 字符';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError('');
    if (!validate()) return;
    const name = displayName.trim();
    createMutation.mutate({
      phone: phone.trim(),
      initialPassword,
      ...(name === '' ? {} : { displayName: name }),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>开通账号</DialogTitle>
          <DialogDescription>
            手机号用于登录；开通即赠点，用户名可选且不参与登录。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="create-phone">手机号</Label>
            <Input
              id="create-phone"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={fieldErrors.phone !== undefined}
              value={phone}
              onChange={event => setPhone(event.target.value)}
            />
            <FieldError message={fieldErrors.phone} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="create-password">初始密码（至少 8 位，首登强制改密）</Label>
            <Input
              id="create-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={fieldErrors.initialPassword !== undefined}
              value={initialPassword}
              onChange={event => setInitialPassword(event.target.value)}
            />
            <FieldError message={fieldErrors.initialPassword} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="create-display-name">用户名（可选，最长 64 字符）</Label>
            <Input
              id="create-display-name"
              aria-invalid={fieldErrors.displayName !== undefined}
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
            />
            <FieldError message={fieldErrors.displayName} />
          </div>
          <SubmitError message={submitError} />
          <DialogFooter>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? '开通中…' : '开通账号'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 充值/调点对话框（票 47 列表页与票 49 详情页共用）：只依赖账号的最小
 * 形状（id + phone），列表行与详情页账号投影都能满足。
 */
export interface AccountActionDialogProps {
  account: { id: string; phone: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 操作成功后：父组件失效列表并关闭对话框。 */
  onDone: () => void;
}

/** 充值入账对话框：金额（元，最小粒度 0.1 元 = 1 点）+ 来源备注。 */
export function TopupDialog({ account, open, onOpenChange, onDone }: AccountActionDialogProps) {
  const [amountYuan, setAmountYuan] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ amountYuan?: string; note?: string }>({});
  const [submitError, setSubmitError] = useState('');

  const topupMutation = useMutation({
    mutationFn: (points: number) =>
      topupAdminAccount(account.id, points, `充值 ¥${yuanFromCents(points * 10)}：${note.trim()}`),
    onSuccess: () => {
      reset();
      onDone();
    },
    onError: error => {
      setSubmitError(adminApiErrorMessage(error, '充值失败，请稍后重试。'));
    },
  });

  function reset() {
    setAmountYuan('');
    setNote('');
    setFieldErrors({});
    setSubmitError('');
  }

  function validate(): number | null {
    const errors: typeof fieldErrors = {};
    const trimmed = amountYuan.trim();
    let cents = 0;
    if (!AMOUNT_PATTERN.test(trimmed)) {
      errors.amountYuan = '充值金额必须是正数（最多两位小数）。';
    } else {
      cents = Math.round(Number(trimmed) * 100);
      if (cents <= 0) {
        errors.amountYuan = '充值金额必须是正数（最多两位小数）。';
      } else if (cents % 10 !== 0) {
        errors.amountYuan = '充值金额最小粒度为 0.1 元（1 元 = 10 点）。';
      }
    }
    if (note.trim().length === 0) errors.note = '来源备注不能为空。';
    else if (Array.from(note.trim()).length > 500) errors.note = '来源备注最长 500 字。';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return null;
    return cents / 10;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError('');
    const points = validate();
    if (points === null) return;
    topupMutation.mutate(points);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>充值 · {account.phone}</DialogTitle>
          <DialogDescription>1 元 = 10 点，最小粒度 0.1 元；金额与备注同落流水。</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="topup-amount">充值金额（元）</Label>
            <Input
              id="topup-amount"
              inputMode="decimal"
              placeholder="如 200"
              aria-invalid={fieldErrors.amountYuan !== undefined}
              value={amountYuan}
              onChange={event => setAmountYuan(event.target.value)}
            />
            <FieldError message={fieldErrors.amountYuan} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="topup-note">来源备注（对公转账截图 / 流水说明）</Label>
            <Input
              id="topup-note"
              aria-invalid={fieldErrors.note !== undefined}
              value={note}
              onChange={event => setNote(event.target.value)}
            />
            <FieldError message={fieldErrors.note} />
          </div>
          <SubmitError message={submitError} />
          <DialogFooter>
            <Button type="submit" disabled={topupMutation.isPending}>
              {topupMutation.isPending ? '入账中…' : '确认入账'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 调点对话框：可正可负（负数只动可用余额），必须带备注。 */
export function AdjustDialog({ account, open, onOpenChange, onDone }: AccountActionDialogProps) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ delta?: string; note?: string }>({});
  const [submitError, setSubmitError] = useState('');

  const adjustMutation = useMutation({
    mutationFn: (value: number) => adjustAdminAccount(account.id, value, note.trim()),
    onSuccess: () => {
      reset();
      onDone();
    },
    onError: error => {
      setSubmitError(adminApiErrorMessage(error, '调点失败，请稍后重试。'));
    },
  });

  function reset() {
    setDelta('');
    setNote('');
    setFieldErrors({});
    setSubmitError('');
  }

  function validate(): number | null {
    const errors: typeof fieldErrors = {};
    const trimmed = delta.trim();
    let value = 0;
    if (!DELTA_PATTERN.test(trimmed)) {
      errors.delta = '调整点数必须是整数（可带 +/-）。';
    } else {
      value = Number.parseInt(trimmed, 10);
      if (value === 0) errors.delta = '调整点数不能为 0。';
      else if (Math.abs(value) > 10_000_000) errors.delta = '单次调整不能超过 10,000,000 点。';
    }
    if (note.trim().length === 0) errors.note = '调点必须带备注。';
    else if (Array.from(note.trim()).length > 500) errors.note = '备注最长 500 字。';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return null;
    return value;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError('');
    const value = validate();
    if (value === null) return;
    adjustMutation.mutate(value);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>调点 · {account.phone}</DialogTitle>
          <DialogDescription>调整点数（正负整数），负数只动可用余额；备注落流水。</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="adjust-delta">调整点数</Label>
            <Input
              id="adjust-delta"
              inputMode="numeric"
              placeholder="如 50 或 -50"
              aria-invalid={fieldErrors.delta !== undefined}
              value={delta}
              onChange={event => setDelta(event.target.value)}
            />
            <FieldError message={fieldErrors.delta} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adjust-note">备注（必填，落流水）</Label>
            <Input
              id="adjust-note"
              aria-invalid={fieldErrors.note !== undefined}
              value={note}
              onChange={event => setNote(event.target.value)}
            />
            <FieldError message={fieldErrors.note} />
          </div>
          <SubmitError message={submitError} />
          <DialogFooter>
            <Button type="submit" disabled={adjustMutation.isPending}>
              {adjustMutation.isPending ? '调整中…' : '确认调整'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 分 → 元的两位小数展示（与 SSR 充值备注口径一致）。 */
function yuanFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
