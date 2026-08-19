/**
 * 账号态 UI 纯格式化 helper（票 06）。侧栏等环境 UI 用掩码手机号；
 * 「个人信息」面板按验收展示完整手机号。
 */

/** 13800001234 → 138****1234：环境 UI（侧栏页脚等）的固定掩码。 */
export function maskPhone(phone: string | null): string {
  if (!phone || phone.length < 7) return phone ?? '—';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 宽限截止时间（epoch 秒）的本地展示。 */
export function formatGraceDeadline(deadlineAt: number | null): string {
  if (deadlineAt === null) return '—';
  return new Date(deadlineAt * 1000).toLocaleString('zh-CN', { hour12: false });
}

/** 点数明细流水时间（ISO 串）的本地展示。 */
export function formatLedgerTime(createdAt: string): string {
  const time = new Date(createdAt);
  if (Number.isNaN(time.getTime())) return createdAt;
  return time.toLocaleString('zh-CN', { hour12: false });
}
