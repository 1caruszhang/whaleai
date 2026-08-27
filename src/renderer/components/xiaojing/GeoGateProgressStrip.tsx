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
 *
 * 执行段真实进度：工作步骤 running 时，条下追加一条确定进度的细条
 * （如「生成文章 3/5」），由 Sidecar 逐篇回报驱动；这样长耗时执行期
 * 条本身也在动，而不只在确认门放行时跳变。
 */

import type {
  GeoOperationConfirmationKind,
  GeoOperationStep,
  GeoOperationStepStatus,
} from "../../../shared/geo/operation";
import {
  formatGeoStepProgressNote,
  runningGeoOperationStep,
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

/**
 * 状态行文案（停靠条与进度卡共用）：轻量模式执行期优先报真实工作步骤
 * （如「正在生成文章 3/5」），把未到的确认门标成「当前」会误导用户以为
 * 在等他操作；有确认门的计划报 `N/M 道闸门 · 当前：…`，无门计划回退
 * `N/M 步`。fullCard（计划边界完整卡）保持步数——步骤重放就在卡内。
 */
export function formatGeoOperationProgressLine(
  steps: GeoOperationStep[],
  options: { fullCard?: boolean } = {},
): string {
  const running = runningGeoOperationStep(steps);
  if (!options.fullCard && running) {
    return `正在${formatGeoStepProgressNote(running)}`;
  }
  const gateSegments = deriveGateSegments(steps);
  if (!options.fullCard && gateSegments.length > 0) {
    const gateDone = gateSegments.filter(isGateDone).length;
    const currentGate = findCurrentGate(gateSegments);
    return `${gateDone}/${gateSegments.length} 道闸门${
      currentGate ? ` · 当前：${currentGate.title}` : ""
    }`;
  }
  const completed = steps.filter(
    (step) => step.status === "succeeded" || step.status === "skipped",
  ).length;
  return `${completed}/${steps.length} 步`;
}

function segmentTooltip(segment: GeoGateSegment, done: boolean, isCurrent: boolean): string {
  if (done) return `${segment.title} · 已放行`;
  if (segment.status === "awaiting-confirmation") return `${segment.title} · 待确认`;
  if (segment.status === "failed") return `${segment.title} · 失败`;
  if (isCurrent) return `${segment.title} · 进行中`;
  return `${segment.title} · 未到`;
}

/** 执行段确定进度条：running 工作步骤的量化进度（如逐篇 3/5）。 */
function GeoStepProgressLine({ step }: { step: GeoOperationStep }) {
  const progress = step.progress;
  const percent = progress
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : null;
  return (
    <div
      className="flex items-center gap-2"
      data-geo-step-progress={step.id}
      title={`${formatGeoStepProgressNote(step)} · 进行中`}
    >
      <span className="shrink-0 text-xs leading-none text-[var(--accent)]">
        {formatGeoStepProgressNote(step)}
      </span>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--line)]">
        <div
          data-geo-step-progress-fill
          className={`h-full rounded-full bg-[var(--accent)] transition-all duration-500 ${
            percent === null ? "animate-pulse" : ""
          }`}
          style={{ width: `${percent ?? 100}%` }}
        />
      </div>
    </div>
  );
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
  const running = runningGeoOperationStep(steps);

  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      data-geo-gate-progress={operationId}
    >
      <div className="flex items-stretch gap-1" data-geo-gate-segments>
        {segments.map((segment, index) => {
          const done = allDone || index < currentIndex;
          const isCurrent = !allDone && index === currentIndex;
          const awaiting = isCurrent && segment.status === "awaiting-confirmation";
          const failed = segment.status === "failed";
          return (
            <div
              key={segment.id}
              title={segmentTooltip(segment, done, isCurrent)}
              data-geo-gate-segment={segment.id}
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
      {running && <GeoStepProgressLine step={running} />}
    </div>
  );
}
