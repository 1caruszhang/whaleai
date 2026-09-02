import { basename, resolve } from 'node:path';

import type { GeoOperationReference } from '../../shared/geo/operation';
import { createGeoOperationService } from '../geo/operation';
import { jsonResponse } from '../utils/http';
import {
  getRuntimeSessionIdForRequest,
  notifyGeoOperationWorkbenchEvent,
  requestAccountAccessToken,
  type XiaojingRouteContext,
} from './xiaojing-shared';

export async function handleXiaojingGeoOperationsRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  const { workspacePath } = ctx;

  if (pathname === '/api/xiaojing/geo-operations/list' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        limit?: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      const operations = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).list({
        includeAllSessions: false,
        limit: payload.limit,
      });
      return jsonResponse({ success: true, operations });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  }

  if (pathname === '/api/xiaojing/geo-operations/get' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      const operation = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).get(payload.operationId);
      if (operation.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_session_mismatch' }, 403);
      }
      return jsonResponse({ success: true, operation });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  }

  if (pathname === '/api/xiaojing/geo-operations/control' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        expectedRevision: number;
        action: 'pause' | 'resume' | 'retry' | 'cancel';
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      if (!['pause', 'resume', 'retry', 'cancel'].includes(payload.action)) {
        return jsonResponse({ success: false, error: 'geo_operation_control_action_invalid' }, 400);
      }
      const operation = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).control({
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
        action: payload.action,
      });
      const notification = await notifyGeoOperationWorkbenchEvent(
        runtimeSessionId,
        operation,
        payload.action,
        requestAccountAccessToken(request),
      );
      return jsonResponse({
        success: true,
        operation,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes('revision_conflict') ? 409 : 400,
      );
    }
  }

  if (
    pathname === '/api/xiaojing/geo-operations/choose-next-round-knowledge'
    && request.method === 'POST'
  ) {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        expectedRevision: number;
        updateKnowledge: boolean;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      if (typeof payload.updateKnowledge !== 'boolean') {
        return jsonResponse({ success: false, error: 'geo_operation_next_round_decision_invalid' }, 400);
      }
      const operation = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).chooseNextRoundKnowledge({
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
        updateKnowledge: payload.updateKnowledge,
      });
      const action = payload.updateKnowledge
        ? 'next-round-update-knowledge'
        : 'next-round-keep-knowledge';
      const notification = await notifyGeoOperationWorkbenchEvent(
        runtimeSessionId,
        operation,
        action,
        requestAccountAccessToken(request),
      );
      return jsonResponse({
        success: true,
        operation,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes('revision_conflict') ? 409 : 400,
      );
    }
  }

  if (
    pathname === '/api/xiaojing/geo-operations/skip-material-collection'
    && request.method === 'POST'
  ) {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        expectedRevision: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      // 跳过出口（geo-plan-normalization 票 07）：材料请求卡的「跳过材料
      // 收集」动作走既有 replace-plan 计划替换，决策回执信封唤醒 agent
      // 从跳过后的下一步续接——与知识分支决策同一条已走通的链路。
      const operation = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).skipMaterialCollection({
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
      });
      const notification = await notifyGeoOperationWorkbenchEvent(
        runtimeSessionId,
        operation,
        'skip-material-collection',
        requestAccountAccessToken(request),
      );
      return jsonResponse({
        success: true,
        operation,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes('revision_conflict') ? 409 : 400,
      );
    }
  }

  if (pathname === '/api/xiaojing/geo-operations/confirm-step' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        operationId: string;
        expectedRevision: number;
        stepId: string;
        artifactRefs?: GeoOperationReference[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'geo_operation_identity_mismatch' }, 403);
      }
      const operation = await createGeoOperationService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).recordConfirmedStep({
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
        stepId: payload.stepId,
        artifactRefs: payload.artifactRefs,
      });
      const notification = await notifyGeoOperationWorkbenchEvent(
        runtimeSessionId,
        operation,
        `confirm-step:${payload.stepId}`,
        requestAccountAccessToken(request),
      );
      return jsonResponse({
        success: true,
        operation,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('revision_conflict')
        ? 409
        : message.includes('requires_rust_ui_authority')
          ? 403
          : 400;
      return jsonResponse({ success: false, error: message }, status);
    }
  }

  return null;
}
