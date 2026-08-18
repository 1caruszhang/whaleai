import { memo } from "react";

import type { GeoOperationProjection, GeoOperationStep } from "../../../shared/geo/operation";
import XiaojingGeoBaselinePanel from "./XiaojingGeoBaselinePanel";
import XiaojingPostPublishMonitoringPanel from "./XiaojingPostPublishMonitoringPanel";
import XiaojingRealGeoDashboard from "./XiaojingRealGeoDashboard";
interface GeoOperationGatePanelsProps {
  operation: GeoOperationProjection;
  /** 任一闸门在卡片上确认后，通知宿主卡片刷新操作投影。 */
  onGateConfirmed?: () => void;
}

/**
 * 与右侧工作台 XiaojingGeoOperationPanel 的「当前步骤业务卡片」同一挂载表：
 * 聊天内 GEO 卡片据此把当前步骤的交互面板直接渲染在卡片下方，
 * 用户在卡片上完成确认，工作台只保留只读结果展示。
 */
function activeStep(
  operation: GeoOperationProjection,
): GeoOperationStep | null {
  return (
    operation.steps.find(
      (step) =>
        step.status === "running" ||
        step.status === "awaiting-confirmation" ||
        step.status === "ready" ||
        step.status === "failed",
    ) ??
    operation.steps.find((step) => step.status === "pending") ??
    null
  );
}

export default memo(function GeoOperationGatePanels({
  operation,
}: GeoOperationGatePanelsProps) {
  const step = activeStep(operation);

  // 「下一轮是否更新知识」由 Agent 在聊天里提问并记录（choose_next_round_knowledge），
  // 不是面板闸门；挂材料面板反而会误导。
  if (!step || step.id === "decide-knowledge-refresh") return null;

  // key 绑定步骤：步骤推进即重挂载，面板总是加载当前闸门的最新权威数据。
  const gateKey = `${operation.id}:${step.id}`;

  switch (step.capability) {
    // 票 27：粘贴/URL/文件导入的发起动作收敛到聊天输入区的材料导入入口
    // （会话附件路线保持）；确认卡由工具结果或聊天侧导入区渲染，闸门卡下
    // 不再重复挂导入面板。
    case "brand-material-import":
    case "brand-knowledge":
      return null;
    case "question-opportunities":
      // 题库阶段由 agent 用 run_question_pool 发起，确认卡从该工具结果
      // 渲染（QuestionPoolGateCard）；这里不再自动挂载自取数据的面板。
      return null;
    case "geo-observation":
      return (
        <XiaojingGeoBaselinePanel
          key={gateKey}
          workspaceId={operation.workspaceId}
        />
      );
    case "content-planning":
      // 内容计划由 agent 用 plan_topics 发起，确认卡从该工具结果渲染
      // （TopicPlanGateCard）；这里不再自动挂载自取数据的面板。
      return null;
    case "content-production":
      // 文章由 agent 用 generate_articles 发起，批准卡从该工具结果渲染
      // （ArticleApprovalGateCard）；这里不再自动挂载自取数据的面板。
      return null;
    case "distribution-planning":
      // 分发计划由 agent 用 plan_distribution 发起，确认卡从该工具结果
      // 渲染（DistributionGateCard）；这里不再自动挂载自取数据的面板。
      return null;
    case "publishing":
      // 付费发布由 agent 用 prepare_publish 发起预览，不可逆授权卡从该
      // 工具结果渲染（PublishAuthorizationGateCard，授权走 Rust UI 命令）。
      return null;
    case "monitoring":
      return (
        <XiaojingPostPublishMonitoringPanel
          key={gateKey}
          workspaceId={operation.workspaceId}
        />
      );
    case "geo-dashboard":
      return (
        <XiaojingRealGeoDashboard
          key={gateKey}
          workspaceId={operation.workspaceId}
        />
      );
    default:
      return null;
  }
});
