import type { GeoNotificationLocator } from '../../shared/geo/notification';

export interface NotificationClickPayload {
  notificationId?: string;
  tabId?: string;
  sessionId?: string;
  workspacePath?: string;
  geoLocator?: GeoNotificationLocator;
}

/**
 * GEO 通知深链的落点表面（票 32）：监测告警落在品牌「效果」整页的具体
 * 监测计划 run 视图；其余卡片落在对应聊天 Tab 并定位到闸门卡。
 */
export type GeoNotificationLanding = "effect-monitor" | "chat-gate";

export type NotificationClickRoute =
  | { type: "select-tab"; tabId: string; sessionId?: string }
  | { type: "open-session"; sessionId: string; workspacePath: string }
  | {
      type: "open-geo";
      notificationId?: string;
      locator: GeoNotificationLocator;
      landing: GeoNotificationLanding;
    }
  | { type: "none" };

const GEO_CARDS = new Set<GeoNotificationLocator['card']>([
  'geo-operation',
  'article-generation',
  'publish-execution',
  'post-publish-monitoring',
]);

function normalizedGeoLocator(locator: GeoNotificationLocator | undefined): GeoNotificationLocator | null {
  if (!locator || !GEO_CARDS.has(locator.card)) return null;
  const workspaceId = locator.workspaceId?.trim();
  const sessionId = locator.sessionId?.trim();
  const operationId = locator.operationId?.trim();
  const artifactKind = locator.artifact?.kind?.trim();
  const artifactId = locator.artifact?.id?.trim();
  const stepId = locator.stepId?.trim();
  if (!workspaceId || !sessionId || !operationId || !artifactKind || !artifactId) return null;
  return {
    workspaceId,
    sessionId,
    operationId,
    card: locator.card,
    ...(stepId ? { stepId } : {}),
    artifact: { kind: artifactKind, id: artifactId },
  };
}

export function resolveNotificationClickRoute(
  payload: NotificationClickPayload | null | undefined,
  tabMatches: (tabId: string, sessionId?: string) => boolean,
): NotificationClickRoute {
  const geoLocator = normalizedGeoLocator(payload?.geoLocator);
  if (geoLocator) {
    const notificationId = payload?.notificationId?.trim();
    const landing: GeoNotificationLanding =
      geoLocator.card === "post-publish-monitoring" ? "effect-monitor" : "chat-gate";
    return notificationId
      ? { type: "open-geo", notificationId, locator: geoLocator, landing }
      : { type: "open-geo", locator: geoLocator, landing };
  }
  const tabId = payload?.tabId?.trim();
  const sessionId = payload?.sessionId?.trim();
  if (tabId && tabMatches(tabId, sessionId)) {
    return sessionId
      ? { type: "select-tab", tabId, sessionId }
      : { type: "select-tab", tabId };
  }

  const workspacePath = payload?.workspacePath?.trim();
  if (sessionId && workspacePath) {
    return { type: "open-session", sessionId, workspacePath };
  }

  return { type: "none" };
}
