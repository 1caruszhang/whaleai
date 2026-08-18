import type { GeoOperationProjection } from '../../shared/geo/operation';
import {
  buildGeoOperationEventReminder,
} from '../../shared/systemReminder';
import { getSessionId } from '../agent-session';
import { ArticleGenerationService, createArticlePort } from '../geo/article-generation';
import { GeoBaselineService, createGeoBaselinePort } from '../geo/baseline';
import { createDistributionPlanPort, DistributionPlanningService } from '../geo/distribution-plan';
import { recordGeoOperationMilestone } from '../geo/operation-progress';
import { getXiaojingGeoProviderCapabilities } from '../geo/provider-runtime';
import { createQuestionPoolPort, QuestionPoolService } from '../geo/question-pool';
import { createTopicPlanPort, TopicPlanService } from '../geo/topic-plan';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';

export type XiaojingRouteContext = Readonly<{ workspacePath: string }>;

type Identity = { workspaceId: string; sessionId: string };
const identityKey = (identity: Identity) => `${identity.workspaceId}:${identity.sessionId}`;

function getRuntimeSessionIdForRequest(): string {
  return getSessionId();
}

let questionPoolRuntime: { key: string; service: QuestionPoolService } | null = null;
function getXiaojingQuestionPoolService(identity: Identity): QuestionPoolService {
  const key = identityKey(identity);
  if (questionPoolRuntime?.key === key) return questionPoolRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new QuestionPoolService(
    identity,
    createQuestionPoolPort(identity),
    capabilities.keywordSearch,
    capabilities.generation,
    capabilities.embedding,
  );
  questionPoolRuntime = { key, service };
  return service;
}

let baselineRuntime: { key: string; service: GeoBaselineService } | null = null;
function getXiaojingGeoBaselineService(identity: Identity): GeoBaselineService {
  const key = identityKey(identity);
  if (baselineRuntime?.key === key) return baselineRuntime.service;
  const service = new GeoBaselineService(
    identity,
    createGeoBaselinePort(identity),
    getXiaojingGeoProviderCapabilities().keywordSearch,
  );
  baselineRuntime = { key, service };
  return service;
}

let topicRuntime: { key: string; service: TopicPlanService } | null = null;
function getXiaojingTopicPlanService(identity: Identity): TopicPlanService {
  const key = identityKey(identity);
  if (topicRuntime?.key === key) return topicRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new TopicPlanService(
    identity,
    createTopicPlanPort(identity),
    capabilities.generation,
    capabilities.embedding,
  );
  topicRuntime = { key, service };
  return service;
}

let articleRuntime: { key: string; service: ArticleGenerationService } | null = null;
function getXiaojingArticleService(identity: Identity): ArticleGenerationService {
  const key = identityKey(identity);
  if (articleRuntime?.key === key) return articleRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new ArticleGenerationService(
    identity,
    createArticlePort(identity),
    capabilities.generation,
    capabilities.reflection,
  );
  articleRuntime = { key, service };
  return service;
}

let distributionRuntime: { key: string; service: DistributionPlanningService } | null = null;
function getXiaojingDistributionPlanService(identity: Identity): DistributionPlanningService {
  const key = identityKey(identity);
  if (distributionRuntime?.key === key) return distributionRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new DistributionPlanningService(
    identity,
    createDistributionPlanPort(identity),
    capabilities.distribution,
    capabilities.keywordSearch,
  );
  distributionRuntime = { key, service };
  return service;
}

async function notifyGeoOperationWorkbenchEvent(
  workspacePath: string,
  sessionId: string,
  operation: GeoOperationProjection,
  action: string,
): Promise<{ success: boolean; error?: string }> {
  return sendXiaojingMessage(buildGeoOperationEventReminder({
    workspaceId: operation.workspaceId,
    sessionId,
    operationId: operation.id,
    revision: operation.revision,
    action,
    status: operation.status,
  }), undefined, workspacePath);
}

/** Baseline probes run synchronously inside start/retry: confirm the probe
 * gate when evidence is committed, and close the probe step when the run
 * produced usable evidence (succeeded or partial). */
async function recordBaselineMilestones(
  identity: Identity,
  baselineStatus: string,
): Promise<void> {
  await recordGeoOperationMilestone(identity, 'baseline-probe-started');
  if (baselineStatus === 'succeeded' || baselineStatus === 'partial') {
    await recordGeoOperationMilestone(identity, 'baseline-probe-finished');
  }
}

export {
  getRuntimeSessionIdForRequest,
  getXiaojingQuestionPoolService,
  getXiaojingGeoBaselineService,
  getXiaojingTopicPlanService,
  getXiaojingArticleService,
  getXiaojingDistributionPlanService,
  notifyGeoOperationWorkbenchEvent,
  recordBaselineMilestones,
};
