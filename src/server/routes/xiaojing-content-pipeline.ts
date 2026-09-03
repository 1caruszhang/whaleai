import { basename, resolve } from 'node:path';

import type { ArticleOperationSource } from '../../shared/geo/articleGeneration';
import type { DistributionPlanEditInput, DistributionPlanStartInput } from '../../shared/geo/distributionPlan';
import type { TopicPlanWireItem } from '../../shared/geo/topicPlan';
import { toTopicPlanCardProjection } from '../../shared/geo/topicPlan';
import { buildArticleApprovalDecisionReminder, buildDistributionPlanDecisionReminder, buildTopicPlanDecisionReminder } from '../../shared/systemReminder';
import { recordGeoOperationMilestone, quoteGeoNextStepForGateKind } from '../geo/operation-progress';
import { geoServices } from '../geo/service-composition';
import { jsonResponse } from '../utils/http';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';
import {
  getRuntimeSessionIdForRequest,
  requestAccountAccessToken,
  type XiaojingRouteContext,
} from './xiaojing-shared';

export async function handleXiaojingContentPipelineRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  const { workspacePath } = ctx;

  // Topic/type/title planning consumes one confirmed question-pool snapshot.
  // Node owns semantic provider execution; Rust owns artifact revision/CAS
  // and the explicit confirmation gate required by content production.
  if (
    pathname === "/api/xiaojing/topic-plans/latest" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        confirmedOnly?: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "topic_plan_identity_mismatch" },
          403,
        );
      }
      const plan = await geoServices({
        workspaceId,
        sessionId: runtimeSessionId,
      }).topicPlan.latest({ ...payload, workspaceId, sessionId: runtimeSessionId });
      // 轮询响应走卡片瘦身投影：完整投影 ~84KB × 每 3s 一次太浪费；
      // 两个消费方（确认卡轮询、工作台面板）都只读瘦身字段。
      return jsonResponse({
        success: true,
        plan: plan ? toTopicPlanCardProjection(plan) : null,
      });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/topic-plans/generate" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        questionPoolId?: string;
        /** 卡片「重新生成内容计划」按钮：跳过复用强制重规划（真实花费）。 */
        regenerate?: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "topic_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const plan = await geoServices(identity).topicPlan.generate({
        ...payload,
        ...identity,
        forceRegenerate: payload.regenerate === true,
      });
      return jsonResponse({ success: true, plan });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/topic-plans/items" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId: string;
        expectedRevision: number;
        items: TopicPlanWireItem[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "topic_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const result = await geoServices(identity).topicPlan.saveItems({
        ...payload,
        ...identity,
      });
      return jsonResponse({ success: true, result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/topic-plans/regenerate" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId: string;
        expectedRevision: number;
        itemIds: string[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "topic_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const result = await geoServices(identity).topicPlan.regenerate(
        {
          ...payload,
          ...identity,
        },
      );
      return jsonResponse({ success: true, result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/topic-plans/confirm" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId: string;
        expectedRevision: number;
        selectedItemIds: string[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "topic_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const confirmation = await geoServices(
        identity,
      ).topicPlan.confirm({
        ...payload,
        ...identity,
      });
      const notification = await sendXiaojingMessage({
        text: buildTopicPlanDecisionReminder({
          planId: confirmation.planId,
          decisionId: confirmation.decisionId,
          revision: confirmation.revision,
          selectedCount: confirmation.selectedItemIds.length,
          questionPoolId: confirmation.questionPoolId,
          questionPoolRevision: confirmation.questionPoolRevision,
          knowledgeVersion: confirmation.knowledgeVersion,
          nextStep: await quoteGeoNextStepForGateKind(identity, 'topic-plan'),
        }),
        requestAccountToken: requestAccountAccessToken(request),
      });
      await recordGeoOperationMilestone(identity, 'topic-plan-confirmed');
      return jsonResponse({
        success: true,
        confirmation,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  // Direct article generation is an exact, brand-scoped operation. It may
  // expand only a confirmed TopicPlan selection or an explicit direct
  // count/theme/constraint spec; it never invokes baseline/distribution.
  if (
    pathname === "/api/xiaojing/articles/latest" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const operation = await geoServices({
        workspaceId,
        sessionId: runtimeSessionId,
      }).article.latest({ workspaceId, sessionId: runtimeSessionId });
      return jsonResponse({ success: true, operation });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/operation/get" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId ||
        !payload.operationId?.trim()
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const operation = await geoServices({
        workspaceId,
        sessionId: runtimeSessionId,
      }).article.operation({
        workspaceId,
        sessionId: runtimeSessionId,
        operationId: payload.operationId,
      });
      return jsonResponse({ success: true, operation });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/start" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        source: ArticleOperationSource;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const operation = await geoServices(identity).article.start({
        ...identity,
        source: payload.source,
      });
      return jsonResponse({ success: true, operation });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/retry" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        articleId: string;
        expectedRevision: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      // fire-and-forget：单篇重生成可达 1–2 分钟，同步等待会撞 Rust 代理
      // ~100s 超时；卡片每 3s 轮询 /articles/latest 自行追上状态。
      const article = await geoServices(identity).article.retryStart({
        ...payload,
        ...identity,
      });
      return jsonResponse({ success: true, article });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/body" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        articleId: string;
        revision?: number;
        approved?: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const body = await geoServices(identity).article.body({
        ...payload,
        ...identity,
      });
      return jsonResponse({ success: true, body });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/edit" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        articleId: string;
        expectedRevision: number;
        title: string;
        body: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const article = await geoServices(identity).article.edit({
        ...payload,
        ...identity,
      });
      return jsonResponse({ success: true, article });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/discard" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        articleId: string;
        expectedRevision: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const article = await geoServices(identity).article.discard({
        ...payload,
        ...identity,
      });
      return jsonResponse({ success: true, article });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/articles/approve" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        articleId: string;
        expectedRevision: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "article_generation_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const article = await geoServices(identity).article.approve({
        ...payload,
        ...identity,
      });
      // The review decision is durably committed. Wake the Agent with a
      // hidden receipt so it continues into distribution planning; delivery
      // is best-effort and cannot roll back or obscure the decision.
      const notification = await sendXiaojingMessage({
        text: buildArticleApprovalDecisionReminder({
          operationId: article.operationId,
          articleId: article.id,
          status: article.status,
          revision: article.revision,
          approvedRevision: article.approvedRevision,
          knowledgeVersion: article.knowledgeVersion,
          nextStep: await quoteGeoNextStepForGateKind(
            identity,
            'article-approval',
          ),
        }),
        requestAccountToken: requestAccountAccessToken(request),
      });
      await recordGeoOperationMilestone(identity, 'articles-approved');
      return jsonResponse({
        success: true,
        article,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  // Distribution discovery consumes only persisted baseline evidence and
  // exact approved article revisions. Node evaluates the real read-only
  // resource catalog; Rust owns the plan snapshot, revision CAS and gate.
  if (
    pathname === "/api/xiaojing/distribution-plans/context" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        articleOperationId?: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "distribution_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const context = await geoServices(
        identity,
      ).distribution.context({
        ...identity,
        articleOperationId: payload.articleOperationId,
      });
      return jsonResponse({ success: true, context });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/distribution-plans/latest" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "distribution_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const plan =
        await geoServices(identity).distribution.latest(identity);
      return jsonResponse({ success: true, plan });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/distribution-plans/start" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        source: DistributionPlanStartInput;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "distribution_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const plan = await geoServices(identity).distribution.start(
        {
          ...identity,
          source: payload.source,
        },
      );
      return jsonResponse({ success: true, plan });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/distribution-plans/edit" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId: string;
        expectedRevision: number;
        edit: DistributionPlanEditInput;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "distribution_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const plan = await geoServices(identity).distribution.edit({
        ...identity,
        planId: payload.planId,
        expectedRevision: payload.expectedRevision,
        edit: payload.edit,
      });
      return jsonResponse({ success: true, plan });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/distribution-plans/confirm" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId: string;
        expectedRevision: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "distribution_plan_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const plan = await geoServices(
        identity,
      ).distribution.confirm({
        ...identity,
        planId: payload.planId,
        expectedRevision: payload.expectedRevision,
      });
      // The confirmation is durably committed. Wake the Agent with a hidden
      // receipt so it continues into publish preparation; delivery is
      // best-effort and cannot roll back or obscure the decision.
      const notification = await sendXiaojingMessage({
        text: buildDistributionPlanDecisionReminder({
          planId: plan.id,
          operationId: plan.operationId,
          articleOperationId: plan.articleOperationId,
          status: plan.status,
          revision: plan.revision,
          assignmentCount: plan.assignments.length,
          nextStep: await quoteGeoNextStepForGateKind(
            identity,
            'distribution-plan',
          ),
        }),
        requestAccountToken: requestAccountAccessToken(request),
      });
      await recordGeoOperationMilestone(identity, 'distribution-confirmed');
      return jsonResponse({
        success: true,
        plan,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("revision_conflict") ? 409 : 400,
      );
    }
  }

  return null;
}
