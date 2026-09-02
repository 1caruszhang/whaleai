import type { ReactNode } from 'react';

/**
 * 卡片时间戳两态（geo-plan-normalization 票 08）：交互卡片的时间槽只有
 * 两种真实语义——进行中（未落定）显示「生成中」状态词、绝不出钟点；落定
 * 后显示完成时刻。完成时刻只取权威投影的时间字段（材料行 =
 * BrandMaterial.updatedAt，主确认卡 = 候选 resolvedAt 的最大值），不在
 * 渲染侧造第二时间源；落定但拿不到权威时刻时整个时间槽缺席（宁缺毋假）。
 * 材料请求卡与知识批量确认卡共用本组件钉死同一语义与展示口径。
 */
export type CardTimestampState = 'generating' | 'settled';

/**
 * 未落定态的缺省文案。与文章状态词表（articleStatusLabels 的 drafting →
 * 生成中）同一词汇，但不直接引用该表——那会把手材料抽取行的文案耦合到
 * 文章状态枚举的演化上；卡片两态的单一来源在这里（i18n 卡片经
 * generatingLabel 覆盖翻译）。
 */
export const CARD_TIMESTAMP_GENERATING_LABEL = '生成中';

/** 落定态的缺省文案模板（非 i18n 卡片零配置使用）。 */
export function cardTimestampCompletedLabel(time: string): string {
  return `完成于 ${time}`;
}

/**
 * 完成时刻的展示格式：与聊天消息时间戳（Message.tsx 的 formatTimestamp）
 * 同一口径——本地时区 `YYYY-MM-DD HH:mm:ss`。缺失或不可解析输入返回
 * 空串，调用方据此隐藏时间槽。
 */
export function formatCardCompletionTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad2 = (value: number) => String(value).padStart(2, '0');
  const day = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-');
  const clock = [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join(':');
  return `${day} ${clock}`;
}

interface CardStatusTimeProps {
  state: CardTimestampState;
  /** 落定态的完成时刻：权威投影时间字段的原样 ISO 串（data-completed-at
   * 透出以便测试与排查追溯数据源）。 */
  completedAt?: string | null;
  /** 未落定态文案；缺省用共享常量。 */
  generatingLabel?: string;
  /** 落定态文案（接收格式化后的完成时刻）；缺省「完成于 {time}」。 */
  completedLabel?: (time: string) => ReactNode;
}

/** 两态时间槽。纯展示叶子组件：无状态、无副作用，文案可由宿主卡片覆盖。 */
export default function CardStatusTime({
  state,
  completedAt,
  generatingLabel,
  completedLabel,
}: CardStatusTimeProps) {
  if (state === 'generating') {
    return (
      <span
        data-card-timestamp="generating"
        className="shrink-0 text-xs leading-5 text-[var(--ink-subtle)]"
      >
        {generatingLabel ?? CARD_TIMESTAMP_GENERATING_LABEL}
      </span>
    );
  }
  const time = formatCardCompletionTime(completedAt);
  if (!time) return null;
  return (
    <span
      data-card-timestamp="settled"
      data-completed-at={completedAt}
      className="shrink-0 text-xs leading-5 text-[var(--ink-subtle)]"
    >
      {completedLabel ? completedLabel(time) : cardTimestampCompletedLabel(time)}
    </span>
  );
}
