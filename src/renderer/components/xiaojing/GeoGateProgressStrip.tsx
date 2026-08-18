/**
 * GeoGateProgressStrip —— 聊天进度卡上的分段闸门进度条。
 *
 * 视觉语言参考 js_ai 的 GeoProgressStrip：等宽圆角分段、当前段脉冲、
 * 全部完成后整条实心。段不来自固定阶段表，而是从当前计划的确认门步骤
 * 派生——全量优化 8 道门，直接意图只显示自己的门子集。计划卡与轻量条
 * 都渲染同一条：停靠认可门时它随计划卡一起出现（「计划」段停在待确认），
 * 放行后原地推进，不作为新元素出现。段下放两字短名，闸门全称与停靠
 * 状态放 title tooltip；「N/M 道闸门 · 当前：…」状态行由
 * GeoOperationEventCard 提供，本组件只负责条形本身。
 */

import type {
  GeoOperationConfirmationKind,
  GeoOperationStep,
  GeoOperationStepStatus,
} from "../../../shared/geo/operation";

const GATE_SHORT_LABEL: Record<GeoOperationConfirmationKind, string> = {
  "plan-ack": "计划",
  "knowledge-change": "知识",
  "next-round-knowledge": "下一轮",
  "question-selection": "选题",
  "baseline-probe": "基线",
  "topic-plan": "内容",
  "article-approval": "文章",
  "distribution-plan": "分发",
  "paid-publish": "发布",
  "external-publish": "发布",
  "monitoring-activation": "监测",
};

export interface GeoGateSegment {
  id: string;
  /** 闸门全称，供 tooltip 与状态行使用。 */
  title: string;
  /** 段下两字短名。 */
  label: string;
  status: GeoOperationStepStatus;
}

/** 段 = 计划中的确认门步骤，保持计划顺序。 */
export function deriveGateSegments(
  steps: GeoOperationStep[],
): GeoGateSegment[] {
  const segments: GeoGateSegment[] = [];
  for (const step of steps) {
    if (!step.confirmation) continue;
    segments.push({
      id: step.id,
      title: step.confirmation.title,
      label: GATE_SHORT_LABEL[step.confirmation.kind],
      status: step.status,
    });
  }
  return segments;
}

export function isGateDone(segment: GeoGateSegment): boolean {
  return segment.status === "succeeded" || segment.status === "skipped";
}

/** 当前门 = 首个未放行的门；全部放行返回 null。 */
export function findCurrentGate(
  segments: GeoGateSegment[],
): GeoGateSegment | null {
  return segments.find((segment) => !isGateDone(segment)) ?? null;
}

function segmentTooltip(segment: GeoGateSegment, done: boolean, isCurrent: boolean): string {
  if (done) return `${segment.title} · 已放行`;
  if (segment.status === "awaiting-confirmation") return `${segment.title} · 待确认`;
  if (segment.status === "failed") return `${segment.title} · 失败`;
  if (isCurrent) return `${segment.title} · 进行中`;
  return `${segment.title} · 未到`;
}

export default function GeoGateProgressStrip({
  operationId,
  steps,
}: {
  operationId: string;
  steps: GeoOperationStep[];
}) {
  const segments = deriveGateSegments(steps);
  if (segments.length === 0) return null;
  const current = findCurrentGate(segments);
  const allDone = current === null;
  const currentIndex = allDone ? segments.length : segments.indexOf(current);

  return (
    <div
      className="mt-2 flex items-stretch gap-1"
      data-geo-gate-progress={operationId}
    >
      {segments.map((segment, index) => {
        const done = allDone || index < currentIndex;
        const isCurrent = !allDone && index === currentIndex;
        const awaiting = isCurrent && segment.status === "awaiting-confirmation";
        const failed = segment.status === "failed";
        return (
          <div
            key={segment.id}
            title={segmentTooltip(segment, done, isCurrent)}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            <div
              className={`h-1 w-full rounded-full transition-colors duration-300 ${
                failed
                  ? "bg-[var(--error)]"
                  : awaiting
                    ? "animate-pulse bg-[var(--warning)]"
                    : done
                      ? "bg-[var(--accent)]"
                      : isCurrent
                        ? "animate-pulse bg-[var(--accent)]"
                        : "bg-[var(--line)]"
              }`}
            />
            <span
              className={`w-full truncate text-center text-xs leading-none ${
                awaiting
                  ? "text-[var(--warning)]"
                  : failed
                    ? "text-[var(--error)]"
                    : done || isCurrent
                      ? "text-[var(--accent)]"
                      : "text-[var(--ink-muted)]"
              }`}
            >
              {segment.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
