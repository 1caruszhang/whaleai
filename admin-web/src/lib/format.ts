/** 运营台展示口径的日期时间格式化（票 47 列表页）。 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO 时间戳 → 本地 `YYYY-MM-DD HH:mm`（北京时区以外的机器也按本地时区展示）。 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
