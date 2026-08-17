export type GeoNotificationCategory =
  | 'awaiting-confirmation'
  | 'operation-failed'
  | 'batch-completed'
  | 'publish-failed'
  | 'monitoring-completed';

export type GeoNotificationCard =
  | 'geo-operation'
  | 'article-generation'
  | 'publish-execution'
  | 'post-publish-monitoring';

export type GeoSessionStatus =
  | 'awaiting-confirmation'
  | 'failed'
  | 'queued'
  | 'running'
  | 'completed'
  | 'ready';

export interface GeoNotificationArtifactLocator {
  kind: string;
  id: string;
}

/** Stable, fully-qualified product identity. No field may mean "latest". */
export interface GeoNotificationLocator {
  workspaceId: string;
  sessionId: string;
  operationId: string;
  card: GeoNotificationCard;
  stepId?: string;
  artifact: GeoNotificationArtifactLocator;
}

export interface GeoNotificationResolution {
  status: 'exact' | 'fallback';
  locator?: GeoNotificationLocator;
  workspace?: {
    id: string;
    name: string;
    productLines: string[];
    rootPath: string;
    createdAt: string;
    updatedAt: string;
  };
  sessionTitle?: string;
  code?: string;
  message?: string;
}

export interface GeoNavigationTarget extends GeoNotificationLocator {
  nonce: number;
}

/**
 * 监测告警通知在「效果」整页的落点（票 32）：只携带精确监测计划 id，
 * 计划的最新时间序列 run 即通知对应的监测结果；任何字段不得表示「最近一条」。
 * workspaceId 用于把落点限定在通知对应的品牌，切到其它品牌时不残留。
 */
export interface GeoEffectNavigationTarget {
  workspaceId: string;
  planId: string;
  nonce: number;
}

export interface GeoNotificationPreferences {
  awaitingConfirmation: boolean;
  operationFailed: boolean;
  batchCompleted: boolean;
  publishFailed: boolean;
  monitoringCompleted: boolean;
}
