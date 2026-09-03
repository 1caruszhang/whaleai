import { basename, resolve } from 'node:path';

import { gateAutoConfirms } from '../../shared/geo/autonomy';
import type { QuestionPoolQuestion } from '../../shared/geo/questionPool';
import { buildQuestionPoolDecisionReminder } from '../../shared/systemReminder';
import { currentGeoAutonomyProfile } from '../geo/autonomy-profile';
import { recordGeoOperationMilestone, quoteGeoNextStepForGateKind } from '../geo/operation-progress';
import { geoServices } from '../geo/service-composition';
import { jsonResponse } from '../utils/http';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';
import {
  getRuntimeSessionIdForRequest,
  requestAccountAccessToken,
  type XiaojingRouteContext,
} from './xiaojing-shared';

export async function handleXiaojingQuestionPoolsRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  const { workspacePath } = ctx;

  // Question opportunities are a brand-scoped GeoArtifact operation. The
  // Session route owns provider execution; Rust owns immutable knowledge
  // snapshots, attempt/checkpoint CAS, and append-only user decisions.
  if (pathname === '/api/xiaojing/question-pools/latest' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        productLine?: string;
        pendingOnly?: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'question_pool_identity_mismatch' }, 403);
      }
      const pool = await geoServices({
        workspaceId,
        sessionId: runtimeSessionId,
      }).questionPool.latest({ ...payload, workspaceId, sessionId: runtimeSessionId });
      return jsonResponse({ success: true, pool });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  }

  if (pathname === '/api/xiaojing/question-pools/generate' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        productLine: string;
        targetRegion: string;
        idempotencyKey: string;
        generationParameters?: {
          candidateLimit?: number;
          recentSelectionLimit?: number;
        };
        retry?: boolean;
        /** 卡片「重新生成问题池」按钮：跳过复用强制重新挖掘（真实花费）。 */
        regenerate?: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'question_pool_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const service = geoServices(identity).questionPool;
      const pool = await service.generate({
        ...payload,
        ...identity,
        forceRegenerate: payload.regenerate === true,
      }, request.signal);
      await recordGeoOperationMilestone(identity, 'question-pool-generated');
      // auto profile：问题选择是零成本可逆选择门，基线探测等硬门仍在
      // 下游拦截；按推荐项自动通过并播报，失败则安全退回等待用户选择。
      let autoConfirmed: { decisionId: string; selectedCount: number } | null = null;
      if (
        pool.status === 'awaiting-selection' &&
        gateAutoConfirms(currentGeoAutonomyProfile(), 'question-selection')
      ) {
        const recommended = pool.questions.filter((question) => question.recommended);
        if (recommended.length > 0) {
          try {
            const decision = await service.confirm({
              ...identity,
              poolId: pool.id,
              expectedRevision: pool.revision,
              questions: recommended.map((question) => ({ ...question, selected: true })),
            });
            await sendXiaojingMessage({
              text: buildQuestionPoolDecisionReminder({
                poolId: decision.poolId,
                decisionId: decision.decisionId,
                revision: decision.revision,
                selectedCount: decision.selectedQuestionIds.length,
                knowledgeVersion: decision.knowledgeVersion,
                nextStep: await quoteGeoNextStepForGateKind(
                  identity,
                  'question-selection',
                ),
              }),
              requestAccountToken: requestAccountAccessToken(request),
            });
            await recordGeoOperationMilestone(identity, 'question-pool-confirmed');
            autoConfirmed = {
              decisionId: decision.decisionId,
              selectedCount: decision.selectedQuestionIds.length,
            };
          } catch {
            autoConfirmed = null;
          }
        }
      }
      return jsonResponse({
        success: true,
        pool,
        ...(autoConfirmed ? { autoConfirmed } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('revision_conflict') ? 409 : 400;
      return jsonResponse({ success: false, error: message }, status);
    }
  }

  if (pathname === '/api/xiaojing/question-pools/cancel' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        idempotencyKey: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'question_pool_identity_mismatch' }, 403);
      }
      const pool = await geoServices({
        workspaceId,
        sessionId: runtimeSessionId,
      }).questionPool.cancel(payload.idempotencyKey);
      return jsonResponse({ success: true, pool });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  }

  if (pathname === '/api/xiaojing/question-pools/confirm' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        poolId: string;
        expectedRevision: number;
        questions: QuestionPoolQuestion[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'question_pool_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const decision = await geoServices(identity).questionPool.confirm({
        ...payload,
        ...identity,
      });
      const notification = await sendXiaojingMessage({
        text: buildQuestionPoolDecisionReminder({
          poolId: decision.poolId,
          decisionId: decision.decisionId,
          revision: decision.revision,
          selectedCount: decision.selectedQuestionIds.length,
          knowledgeVersion: decision.knowledgeVersion,
          nextStep: await quoteGeoNextStepForGateKind(
            identity,
            'question-selection',
          ),
        }),
        requestAccountToken: requestAccountAccessToken(request),
      });
      await recordGeoOperationMilestone(identity, 'question-pool-confirmed');
      return jsonResponse({
        success: true,
        decision,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message },
        message.includes('revision_conflict') ? 409 : 400);
    }
  }

  return null;
}
