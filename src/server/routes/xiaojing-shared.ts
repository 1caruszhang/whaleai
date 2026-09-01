import { ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT } from '../../shared/geo/articleGeneration';
import type { GeoOperationProjection } from '../../shared/geo/operation';
import {
  buildGeoOperationEventReminder,
} from '../../shared/systemReminder';
import { getSessionId } from '../agent-session';
import { ArticleGenerationService, createArticlePort } from '../geo/article-generation';
import { GeoBaselineService, createGeoBaselinePort } from '../geo/baseline';
import { createDistributionPlanPort, DistributionPlanningService } from '../geo/distribution-plan';
import { createBrandMaterialPort } from '../geo/material-import';
import { recordGeoOperationMilestone, quoteGeoNextStepForAction } from '../geo/operation-progress';
import {
  getXiaojingGeoBillingPermitChannel,
  getXiaojingGeoProviderCapabilities,
} from '../geo/provider-runtime';
import { createQuestionPoolPort, QuestionPoolService } from '../geo/question-pool';
import { createTopicPlanPort, TopicPlanService } from '../geo/topic-plan';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';

export type XiaojingRouteContext = Readonly<{ workspacePath: string }>;

/** Rust 代理/worker 附带的请求级账号 access token 头名（与
 * src-tauri/src/account_auth.rs `ACCOUNT_TOKEN_HEADER` 逐字节一致）。
 * 这是进程内 HTTP 头：Sidecar 只把它作为调网关的 Bearer，绝不转发给
 * 网关以外的上游，也绝不写入日志/数据库/响应。 */
const ACCOUNT_TOKEN_HEADER = 'x-xiaojing-account-token';

/** 提取请求级新鲜账号 token（Rust 侧已按 exp 临期自动 refresh）。 */
export function requestAccountAccessToken(request: Request): string | undefined {
  return request.headers.get(ACCOUNT_TOKEN_HEADER)?.trim() || undefined;
}

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
    getXiaojingGeoBillingPermitChannel(),
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
    Date.now,
    getXiaojingGeoBillingPermitChannel(),
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
    undefined,
    getXiaojingGeoBillingPermitChannel(),
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
    getXiaojingGeoBillingPermitChannel(),
    // 配图候选池（ADR-0008 T4）：材料图片资产直传正文提示词；池空或读取
    // 失败在服务内降级为零配图，不阻塞生成主链。
    async () =>
      createBrandMaterialPort(identity).listImageAssets({
        limit: ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
      }),
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
    undefined,
    getXiaojingGeoBillingPermitChannel(),
  );
  distributionRuntime = { key, service };
  return service;
}

async function notifyGeoOperationWorkbenchEvent(
  sessionId: string,
  operation: GeoOperationProjection,
  action: string,
  requestAccountToken?: string,
): Promise<{ success: boolean; error?: string }> {
  return sendXiaojingMessage({
    text: buildGeoOperationEventReminder({
      workspaceId: operation.workspaceId,
      sessionId,
      operationId: operation.id,
      revision: operation.revision,
      action,
      status: operation.status,
      // 操作事件信封按 action 从持久化计划引述 next-step（ADR-0011）：
      // confirm-step 锚定刚放行的门之后，resume/retry/next-round 取首个
      // 未完成步骤；pause/cancel 不引述。
      nextStep: quoteGeoNextStepForAction(operation, action),
    }),
    requestAccountToken,
  });
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
