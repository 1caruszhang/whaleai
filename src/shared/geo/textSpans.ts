/**
 * 文本区间剔除的共享原语：跳过若干 `[start, end)` 半开区间重建文本。
 * 消费方：materialImagePlaceholder 的配额裁剪（删除超配占位符）与
 * articleGeneration 的品牌指称盲区剔除（门检查时移除加粗块/图片语法/
 * 链接 URL）。区间按起点排序、重叠安全（cursor 只前进）。
 */
export function removeSpans(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let result = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) result += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + text.slice(cursor);
}
