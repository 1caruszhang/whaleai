import { Database, Loader2 } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import { loadLatestGeoBaseline } from "@/api/geoBaselineClient";
import { loadLatestPostPublishMonitor } from "@/api/postPublishMonitoringClient";
import type { GeoBaselineProjection } from "../../../shared/geo/baseline";
import type { PostPublishMonitorPlanProjection } from "../../../shared/geo/postPublishMonitoring";
import GeoDiagnosisMatrix from "./GeoDiagnosisMatrix";
import GeoEffectKpiStrip from "./GeoEffectKpiStrip";
import GeoEffectVerdict from "./GeoEffectVerdict";
import {
  baselineSideLabel,
  buildGeoEffectViewModel,
  engineLabel,
  latestSideLabel,
  percentage,
} from "./geoEffectViewModel";

/**
 * 报告视图（老板/客户一页纸）：品牌名 + 生成时间 + 结论条 + KPI + 诊断
 * 矩阵精简版 + 分题 before/after。数据只走 Rust IPC 投影读取（无需会话），
 * 排版配合 index.css 的 @media print 浅色化与控件隐藏，浏览器/WebView
 * 直接打印即可成 PDF；不做文件导出。
 */
export default memo(function XiaojingGeoEffectReport({
  workspace,
}: {
  workspace: BrandWorkspace;
}) {
  const [baseline, setBaseline] = useState<GeoBaselineProjection | null>(null);
  const [plan, setPlan] = useState<PostPublishMonitorPlanProjection | null>(
    null,
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadLatestGeoBaseline(workspace.id),
      loadLatestPostPublishMonitor({
        workspaceId: workspace.id,
        sessionId: null,
      }),
    ])
      .then(([nextBaseline, nextPlan]) => {
        if (!active) return;
        setBaseline(nextBaseline);
        setPlan(nextPlan);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspace.id]);

  const engineId =
    plan?.engineIds[0] ?? baseline?.providerSnapshots[0]?.engineId ?? "doubao";
  const viewModel = useMemo(
    () =>
      buildGeoEffectViewModel({
        baseline,
        plan,
        engineId,
        engineLabel: engineLabel(engineId),
      }),
    [baseline, engineId, plan],
  );
  // 生成时间在挂载时冻结一次，报告重开即刷新。
  const [generatedAt] = useState(() => new Date());

  return (
    <div
      className="geo-effect-report mt-5"
      data-testid="geo-effect-report"
      aria-label="效果报告视图"
    >
      <div className="space-y-4 rounded-2xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card)] p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--geo-dash-border)] pb-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--geo-dash-secondary)]">
              效果报告
            </div>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-[var(--geo-dash-text)]">
              {workspace.name} · GEO 效果报告
            </h2>
            <p className="mt-1 text-xs text-[var(--geo-dash-text-mute)]">
              生成时间：{generatedAt.toLocaleString("zh-CN")}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] px-3 py-1 text-xs font-medium text-[var(--geo-dash-coral)]">
            <Database className="h-3 w-3" />
            真实数据
          </span>
        </header>

        {error && (
          <p
            role="alert"
            className="break-words rounded-lg border border-[var(--geo-dash-border)] bg-[var(--geo-dash-bg-2)] p-2 text-xs leading-5 text-[var(--geo-dash-danger)]"
          >
            效果数据读取失败：{error}
          </p>
        )}
        {busy && (
          <p className="flex items-center gap-1 text-xs text-[var(--geo-dash-text-mute)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取真实效果数据…
          </p>
        )}

        <GeoEffectVerdict verdict={viewModel.verdict} />

        <section aria-label="报告关键指标">
          <GeoEffectKpiStrip kpis={viewModel.kpis} />
        </section>

        <section aria-label="报告问题诊断">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
            问题诊断矩阵（精简）
          </div>
          <GeoDiagnosisMatrix rows={viewModel.rows} compact />
        </section>

        <section aria-label="分题前后对照">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
            分题前后对照
          </div>
          {viewModel.rows.length === 0 ? (
            <p className="mt-3 text-xs leading-5 text-[var(--geo-dash-text-mute)]">
              暂无真实数据。
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {viewModel.rows.map((row) => {
                const hitRate = percentage(row.mentionedRuns, row.totalRuns);
                return (
                  <div
                    key={row.questionId}
                    className="flex items-center gap-3 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate text-[var(--geo-dash-text-dim)]">
                      {row.question}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      <span className="text-[var(--geo-dash-text-mute)]">
                        基线 {baselineSideLabel(row)}
                      </span>
                      <span className="mx-1 text-[var(--geo-dash-text-mute)]">
                        →
                      </span>
                      <span className="text-[var(--geo-dash-text)]">
                        最新 {latestSideLabel(row)}
                      </span>
                    </span>
                    <span className="w-12 shrink-0 text-right font-mono tabular-nums text-[var(--geo-dash-text)]">
                      {hitRate === null ? "—" : `${hitRate}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <footer className="border-t border-[var(--geo-dash-border)] pt-3 text-xs leading-4 text-[var(--geo-dash-text-mute)]">
          数字来源：真实基线探测与监测轮次；疑似负面为复核线索而非判决，完整原文见应用内「效果」页证据样本库。
        </footer>
      </div>
    </div>
  );
});
