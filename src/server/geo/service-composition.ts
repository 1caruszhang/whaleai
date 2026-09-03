/**
 * GEO 领域服务组合根（spec：2026-09-03 geo-service-composition）。
 *
 * 职责分层：provider-runtime 管「能力怎么造」（secrets → 能力），本模块管
 * 「服务怎么组装」（能力＋端口＋计费＋缓存 → 服务）。五个组装调用方
 * （MCP 工具层、HTTP 面板路由、闸门修订、后台导入队列、图片重扫）全部
 * 向 {@link geoServices} 取服务；构造口径（token、缓存键、配图候选池、
 * 计费通道）不是调用方须知，全部收在本实现里——2026-08-31 零配图事故
 * 的根因正是组装缝漏传构造参数（bug 不在任何领域模块里），此处把三份
 * 自觉收敛为一份构造保证。
 */

import { createHash } from 'node:crypto';

import { ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT } from '../../shared/geo/articleGeneration';
import {
  ArticleGenerationService,
  createArticlePort,
} from './article-generation';
import { GeoBaselineService, createGeoBaselinePort } from './baseline';
import {
  createDistributionPlanPort,
  DistributionPlanningService,
} from './distribution-plan';
import { createKnowledgeAuthority } from './knowledge-authority';
import {
  createBrandMaterialPort,
  MaterialImportService,
} from './material-import';
import {
  createPublishSchedulerPort,
  type PublishSchedulerPort,
} from './publish-scheduler';
import { createQuestionPoolPort, QuestionPoolService } from './question-pool';
import {
  getXiaojingGeoBillingPermitChannelForRequest,
  getXiaojingGeoProviderCapabilitiesForRequest,
} from './provider-runtime';
import { createTopicPlanPort, TopicPlanService } from './topic-plan';

export interface GeoServiceIdentity {
  workspaceId: string;
  sessionId: string;
}

export interface GeoServiceOptions {
  /**
   * 请求级新鲜账号 token（Rust 代理附带、临期已在 Rust 侧刷新）：存在时
   * 优先于启动时 admission 注入的 env token——Sidecar 长跑数小时后 env
   * token 早已过期，必须以请求级为准。缺省回退启动单例。
   */
  accountToken?: string;
  /**
   * 计费通道裁决。`'revision-unbilled'` 显式表达闸门修订不计费（对已付费
   * 产物的修正迭代；spec Decision：未来若要给修订重生成计费，属用户可
   * 感知的花费行为变更，必须走独立领域裁决，不得夹带在重构里）。缺省
   * `'default'`：按 accountToken 同口径解析计费 permit 通道。
   */
  billing?: 'default' | 'revision-unbilled';
  /** 图片重扫的提取预算（毫秒），透传 MaterialImportService；仅重扫场景。 */
  rescanBudgetMs?: number;
}

export interface GeoServiceBundle {
  materialImport: MaterialImportService;
  questionPool: QuestionPoolService;
  topicPlan: TopicPlanService;
  article: ArticleGenerationService;
  distribution: DistributionPlanningService;
  baseline: GeoBaselineService;
  /** 发布预览端口（preview/latest/revise；确认与启动仍 exclusively 走 Rust UI 权威入口）。 */
  publishPreview: PublishSchedulerPort;
}

/**
 * 请求级 token 的缓存键指纹：SHA-256 前 16 hex。原始 token 不进常驻缓存键
 * （生命周期长于请求）；指纹只用于区分轮换前后的 token，碰撞即同 key 复用
 * 同实例。无 token 时为空串——键退化为「工作区:会话:」。
 */
export function accountTokenCacheFingerprint(
  token: string | undefined,
): string {
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * 五个缓存服务的单槽缓存键：「工作区:会话:token 指纹」。token 轮换（或
 * 身份变化）即整槽重建，旧 token 不留缓存闭包（旧实例随槽位丢弃，长跑
 * sidecar 不会攒下过期 token 的服务族）。MCP 与 HTTP 面板两条路径都传
 * 请求级 token（票 B 起同键，不再互相顶槽）；未携带 token 的无头场景键
 * 退化为「工作区:会话:」，与携带方交替调用会顶槽重建——等价于 token
 * 轮换语义，无正确性问题。
 */
function serviceRuntimeKey(
  identity: GeoServiceIdentity,
  token: string | undefined,
): string {
  return `${identity.workspaceId}:${identity.sessionId}:${accountTokenCacheFingerprint(token)}`;
}

let questionPoolRuntime: { key: string; service: QuestionPoolService } | null = null;
let topicPlanRuntime: { key: string; service: TopicPlanService } | null = null;
let articleRuntime: { key: string; service: ArticleGenerationService } | null = null;
let distributionRuntime: { key: string; service: DistributionPlanningService } | null = null;
let baselineRuntime: { key: string; service: GeoBaselineService } | null = null;

/**
 * GEO 领域服务的唯一出生点：一个入口函数按会话身份与少量场景选项返回
 * 整族领域服务，调用方按需取字段。服务构造是惰性的——只有真正取用的
 * 字段才构造（端口构造需要 Sidecar 身份，未取用的服务不得在取包时抛错）。
 *
 * 缓存策略（spec Decision 5）：问题池/内容计划/文章/分发/基线五服务按
 * 「工作区:会话:token 指纹」单槽缓存；材料导入与发布预览端口不缓存
 * （低频调用、场景参数各异/不走网关）。`revision-unbilled` 变体不进
 * 缓存：其构造口径（无计费通道）与 default 不同，不得互相顶槽，闸门
 * 修订只调持久化面方法（revise/latest/saveItems/edit），逐次现构等价。
 */
export function geoServices(
  identity: GeoServiceIdentity,
  options?: GeoServiceOptions,
): GeoServiceBundle {
  const token = options?.accountToken?.trim() || undefined;
  const unbilled = options?.billing === 'revision-unbilled';
  // rescanBudgetMs 在场即图片重扫场景：重扫从不接计费通道（收敛前口径，
  // 与闸门修订同为 unbilled 构造）。
  const unbilledMaterialImport = unbilled || options?.rescanBudgetMs !== undefined;
  const key = serviceRuntimeKey(identity, token);
  // 计费通道惰性解析（与能力同口径）：只有真正构造服务时才触碰通道
  // getter；unbilled 变体恒为 undefined。
  const billingChannel = () =>
    unbilled ? undefined : getXiaojingGeoBillingPermitChannelForRequest(token);

  let questionPool: QuestionPoolService | undefined;
  let topicPlan: TopicPlanService | undefined;
  let article: ArticleGenerationService | undefined;
  let distribution: DistributionPlanningService | undefined;
  let baseline: GeoBaselineService | undefined;
  let materialImport: MaterialImportService | undefined;
  let publishPreview: PublishSchedulerPort | undefined;

  return {
    get questionPool(): QuestionPoolService {
      if (questionPool) return questionPool;
      if (!unbilled && questionPoolRuntime?.key === key) {
        return (questionPool = questionPoolRuntime.service);
      }
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      questionPool = new QuestionPoolService(
        identity,
        createQuestionPoolPort(identity),
        capabilities.keywordSearch,
        capabilities.generation,
        capabilities.embedding,
        billingChannel(),
      );
      if (!unbilled) questionPoolRuntime = { key, service: questionPool };
      return questionPool;
    },
    get topicPlan(): TopicPlanService {
      if (topicPlan) return topicPlan;
      if (!unbilled && topicPlanRuntime?.key === key) {
        return (topicPlan = topicPlanRuntime.service);
      }
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      topicPlan = new TopicPlanService(
        identity,
        createTopicPlanPort(identity),
        capabilities.generation,
        capabilities.embedding,
        undefined,
        billingChannel(),
      );
      if (!unbilled) topicPlanRuntime = { key, service: topicPlan };
      return topicPlan;
    },
    get article(): ArticleGenerationService {
      if (article) return article;
      if (!unbilled && articleRuntime?.key === key) {
        return (article = articleRuntime.service);
      }
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      article = new ArticleGenerationService(
        identity,
        createArticlePort(identity),
        capabilities.generation,
        capabilities.reflection,
        billingChannel(),
        // 配图候选池（ADR-0008 T4）：材料图片资产直传正文提示词；池空或
        // 读取失败在服务内降级为零配图，不阻塞生成主链。三条路径（MCP／
        // HTTP／闸门修订）同接此池——2026-08-31 线上事故的回归钉。
        async () =>
          createBrandMaterialPort(identity).listImageAssets({
            limit: ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
          }),
      );
      if (!unbilled) articleRuntime = { key, service: article };
      return article;
    },
    get distribution(): DistributionPlanningService {
      if (distribution) return distribution;
      if (!unbilled && distributionRuntime?.key === key) {
        return (distribution = distributionRuntime.service);
      }
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      distribution = new DistributionPlanningService(
        identity,
        createDistributionPlanPort(identity),
        capabilities.distribution,
        capabilities.keywordSearch,
        undefined,
        billingChannel(),
      );
      if (!unbilled) distributionRuntime = { key, service: distribution };
      return distribution;
    },
    get baseline(): GeoBaselineService {
      if (baseline) return baseline;
      if (!unbilled && baselineRuntime?.key === key) {
        return (baseline = baselineRuntime.service);
      }
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      baseline = new GeoBaselineService(
        identity,
        createGeoBaselinePort(identity),
        capabilities.keywordSearch,
        Date.now,
        billingChannel(),
      );
      if (!unbilled) baselineRuntime = { key, service: baseline };
      return baseline;
    },
    get materialImport(): MaterialImportService {
      // 不缓存：低频调用、场景参数各异（重扫预算/无预算）。
      if (materialImport) return materialImport;
      const capabilities = getXiaojingGeoProviderCapabilitiesForRequest(token);
      return (materialImport = new MaterialImportService(
        identity,
        createBrandMaterialPort(identity),
        capabilities.extraction,
        createKnowledgeAuthority(identity),
        {},
        capabilities.keywordSearch,
        options?.rescanBudgetMs,
        unbilledMaterialImport
          ? undefined
          : getXiaojingGeoBillingPermitChannelForRequest(token),
      ));
    },
    get publishPreview(): PublishSchedulerPort {
      // 不缓存：纯端口构造，无状态可复用。
      return (publishPreview ??= createPublishSchedulerPort(identity));
    },
  };
}
