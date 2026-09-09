/**
 * 排行竞品不足门与续跑（ADR-0007／票 #45）：Session Sidecar 持有的补名
 * 门、fail-closed 错误码的 UX 投影、以及「名单达标后自动续跑原生成请求」
 * 的共享入口。独立于工具注册文件——decide-batch 裁决路由也要 import 这里
 * 的自动续跑钩子，不能背上工具模块的整条依赖链。
 *
 * 语义纪律：本模块不产名单语义——合并/身份排除一律进口内核
 * `shared/geo/competitorRoster`（票 #43「名单语义只出自内核」）。
 */

import {
  mergeRankingCompetitorTiers,
  RANKING_COMPETITORS_INSUFFICIENT_CODE,
  RANKING_COMPETITORS_REQUIRED_COUNT,
} from '../../shared/geo/competitorRoster';
import type {
  ArticleOperationProjection,
  ArticleOperationSource,
} from '../../shared/geo/articleGeneration';
import {
  brandLayerScopeJson,
  createKnowledgeAuthority,
  inspectBrandScopeStringList,
} from './knowledge-authority';
import { geoServices } from './service-composition';

export interface RankingCompetitorConfirmationChallenge {
  subject: string;
  source: ArticleOperationSource;
  issuedAfterUserMessageId: string;
  /**
   * 票 #45 排行项暂缓：本批被跳过的 ranking 计划项——续跑时 plan 类 source
   * 的 itemIds 替换为这些项，只补生成暂缓部分；direct 源与整批 Err 路径
   * 无此字段（后者 source 原样重发）。
   */
  deferredItemIds?: string[];
}

export interface AuthorizedRankingCompetitorConfirmation
  extends RankingCompetitorConfirmationChallenge {
  userInstruction: string;
}

/** 门卡续跑的 UX 缺口投影（fail-closed 错误码 → 已确认/还差家数 + 指令文案）。 */
export interface RankingCompetitorRequirement {
  kind: "ranking-competitors-required";
  confirmedCount: number;
  missingCount: number;
  instruction: string;
}

export type RankingGenerationResumeOutcome =
  | { kind: "ranking-generation-resumed"; operation: ArticleOperationProjection }
  | { kind: "ranking-generation-still-required"; requirement: RankingCompetitorRequirement };

function normalizedConfirmationText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

/**
 * 续跑单飞的 challenge 身份键：主体＋原请求＋暂缓项集合。围栏消息 id 与
 * confirm 工具附带的 userInstruction 不进键——两条触发路径（工具直接续跑、
 * decide-batch 钩子）读到的是同一张门卡，附带字段不同不能算两张卡。
 */
function rankingChallengeKey(challenge: RankingCompetitorConfirmationChallenge): string {
  return JSON.stringify({
    subject: normalizedConfirmationText(challenge.subject),
    source: challenge.source,
    deferredItemIds: challenge.deferredItemIds ?? [],
  });
}

/** Session-owned、Sidecar 生命周期内的一次排行榜竞品补充门。 */
export class RankingCompetitorConfirmationGate {
  private pending: RankingCompetitorConfirmationChallenge | null = null;
  /**
   * 续跑单飞（票 #45 评审：防双发）——同一 challenge 并发触发时复用同一
   * 次 start；不同 challenge（先后两次门卡）各飞各的，不互相复用结果。
   */
  private resumeInFlight: { key: string; flight: Promise<unknown> } | null = null;
  /**
   * 门卡补搜额度（用户裁决 2026-09-09「补搜免费＋同一门卡只跑一次」）：
   * 补搜不申请计费 permit，成本敞口只能靠次数封顶——每张门卡一次，
   * 门卡清空或换卡才重置。同主体去重刷新暂缓集合不算换卡。
   */
  private topUpClaimed = false;

  issue(challenge: RankingCompetitorConfirmationChallenge): void {
    const pending = this.pending;
    if (
      pending &&
      normalizedConfirmationText(pending.subject) ===
        normalizedConfirmationText(challenge.subject) &&
      JSON.stringify(pending.source) === JSON.stringify(challenge.source)
    ) {
      // 同主体去重不移动围栏（生成重试依赖该语义，见 advanceFence 注）；
      // 但暂缓项集合是批次事实——两次发行的集合不同时按最新发行刷新，
      // 防止续跑按过期 itemIds 补错项。
      if (
        JSON.stringify(pending.deferredItemIds ?? []) !==
        JSON.stringify(challenge.deferredItemIds ?? [])
      ) {
        this.pending = {
          ...pending,
          deferredItemIds: challenge.deferredItemIds
            ? [...challenge.deferredItemIds]
            : undefined,
        };
      }
      return;
    }
    this.pending = structuredClone(challenge);
    this.topUpClaimed = false;
  }

  /**
   * 部分采纳后把围栏推进到刚消费的用户消息：同一条消息不得再授权下一轮
   * 采纳（否则消息里顺带提到的名字都能被后续调用逐个直采纳）。不能走
   * issue()——同主体去重会把它变成空操作（生成重试正是靠该去重不移动围栏）。
   */
  advanceFence(userMessageId: string): void {
    if (this.pending) this.pending.issuedAfterUserMessageId = userMessageId;
  }

  clear(): void {
    this.pending = null;
    this.topUpClaimed = false;
  }

  /**
   * 认领当前门卡的补搜额度：首次认领放行（true），同一挂起门卡再认领
   * 拒绝（false），无挂起门卡不放行——补搜只在门卡语境下有意义。调用方
   * 被拒时回落纯指令文案，聊天补名与材料导入两条通道不受影响。
   */
  claimTopUp(): boolean {
    if (!this.pending || this.topUpClaimed) return false;
    this.topUpClaimed = true;
    return true;
  }

  /**
   * 只读挂起挑战（票 #45）：decide-batch 路由钩子在竞品事实采纳后检查
   * 名单是否达标用的观察口——不移动围栏、不清空、不授权。
   */
  pendingChallenge(): RankingCompetitorConfirmationChallenge | null {
    return this.pending ? structuredClone(this.pending) : null;
  }

  /**
   * 续跑单飞（票 #45 评审）：同一门卡的续跑（confirm 工具与 decide-batch
   * 路由钩子可能并发触发）在飞行中共用一次 start——先到者清门卡并启动，
   * 后到者直接复用其结果，不再发起第二次 start。key 是 challenge 身份，
   * 换了门卡（不同 key）不复用。
   */
  resumeOnce(
    key: string,
    start: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.resumeInFlight?.key === key) return this.resumeInFlight.flight;
    const flight = start().finally(() => {
      if (this.resumeInFlight?.flight === flight) this.resumeInFlight = null;
    });
    this.resumeInFlight = { key, flight };
    return flight;
  }

  authorize(
    input: { names: string[] },
    latestUserMessage: { id: string; content: string } | null,
  ): AuthorizedRankingCompetitorConfirmation {
    const pending = this.pending;
    if (!pending) throw new Error("ranking_competitor_confirmation_not_requested");
    if (
      !latestUserMessage ||
      latestUserMessage.id === pending.issuedAfterUserMessageId
    ) {
      throw new Error("ranking_competitor_confirmation_user_reply_required");
    }
    const latestInstruction = normalizedConfirmationText(
      latestUserMessage.content,
    );
    if (!latestInstruction) {
      throw new Error("ranking_competitor_confirmation_user_reply_required");
    }
    const missingFromUserMessage = input.names.filter(
      (name) =>
        !latestInstruction.includes(normalizedConfirmationText(name)),
    );
    if (missingFromUserMessage.length > 0) {
      throw new Error(
        `ranking_competitor_confirmation_name_not_user_stated:${missingFromUserMessage.join("、")}`,
      );
    }
    return {
      ...structuredClone(pending),
      userInstruction: latestUserMessage.content,
    };
  }
}

const rankingCompetitorGatesBySession = new Map<
  string,
  RankingCompetitorConfirmationGate
>();

/**
 * `createXiaojingGeoServer()` 每个 Agent turn 都会重建 MCP server；竞品不足门
 * 必须由 Session Sidecar 持有，不能绑在单轮 server factory 闭包里。按
 * Session : Sidecar = 1 : 1，一个 sidecar 进程生命周期内最多只有一个 session
 * 键，Map 不需要淘汰机制。
 */
export function sessionRankingCompetitorGate(
  sessionId: string,
): RankingCompetitorConfirmationGate {
  const key = sessionId.trim();
  if (!key) throw new Error("ranking_competitor_confirmation_session_required");
  const existing = rankingCompetitorGatesBySession.get(key);
  if (existing) return existing;
  const gate = new RankingCompetitorConfirmationGate();
  rankingCompetitorGatesBySession.set(key, gate);
  return gate;
}

/**
 * 门卡自动补搜的共享叙述（票 #45 评审去重）：fail-closed 路径与排行项
 * 暂缓路径两处信封共用同一段「已自动补查到 X 家…」文案与 topUp 字段
 * 投影。补搜无结果（null 或两层皆 0）时 suffix 为空串，调用方回落纯指令
 * 文案；resumeVerb 区分「继续生成」与「续跑暂缓项」。
 */
export function rankingTopUpNarrative(
  topUp: { proposed: number; potentialProposed: number } | null,
  resumeVerb: string,
): {
  topUp: { proposed: number; potentialProposed: number } | null;
  suffix: string;
} {
  if (!topUp || topUp.proposed + topUp.potentialProposed <= 0) {
    return { topUp: null, suffix: "" };
  }
  return {
    topUp: { proposed: topUp.proposed, potentialProposed: topUp.potentialProposed },
    suffix: `已自动联网补查到 ${topUp.proposed} 家直接竞品与 ${topUp.potentialProposed} 家潜在竞品候选`
      + `（见知识确认卡，逐项确认或删除；确认后达标将自动${resumeVerb}）。`
      + `也可以直接在聊天中回复要补充并确认的竞品名称。`,
  };
}

/**
 * 排行竞品事实「被采纳」的触发判定（票 #45 评审收口）：decide-batch 路由
 * 用它识别本次裁决是否改变了品牌 scope 的竞品类事实。只认采纳类决策
 * （adopt-new/adopt-edited）——reject/keep 不改变权威值，不该触发续跑
 * 重算；谓词精确匹配两层竞品键，scope 排除产品线（roster 只消费品牌层）。
 */
export function competitorFactAdopted(
  decision: string,
  current: { key: { predicate?: unknown; scopeJson?: unknown } } | null | undefined,
): boolean {
  if (decision !== "adopt-new" && decision !== "adopt-edited") return false;
  const key = current?.key;
  if (!key || typeof key.predicate !== "string") return false;
  const predicate = key.predicate.toLowerCase();
  if (
    predicate !== "enterprise-profile.competitors"
    && predicate !== "enterprise-profile.potentialcompetitors"
  ) {
    return false;
  }
  return brandLayerScopeJson(key.scopeJson);
}

const RANKING_DEFICIT_DEFAULT_GUIDANCE =
  "请用户直接在聊天中回复要补充并确认的竞品名称。";

/**
 * 缺口句式单源：「当前已确认 X 家竞品，还差 Y 家。」＋后续指引。门卡纯指令
 * 文案用缺省指引；自动补搜有结果时调用方传入补搜叙述替换（空串同缺省）。
 */
export function rankingDeficitInstruction(
  confirmedCount: number,
  missingCount: number,
  guidance = "",
): string {
  return `当前已确认 ${confirmedCount} 家竞品，还差 ${missingCount} 家。${guidance || RANKING_DEFICIT_DEFAULT_GUIDANCE}`;
}

/**
 * ranking 生成因竞品不足 fail-closed 时的 UX 补名入口（票 #43：文案留工具
 * 层，错误码常量自名单内核进口——错误语义与 resolveRankingRoster 的抛错
 * 单源）。
 */
export function rankingCompetitorRequirement(error: unknown): RankingCompetitorRequirement | null {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    new RegExp(`${RANKING_COMPETITORS_INSUFFICIENT_CODE}:(\\d+)`).exec(message);
  if (!match) return null;
  const confirmedCount = Math.min(
    RANKING_COMPETITORS_REQUIRED_COUNT - 1,
    Math.max(0, Number(match[1])),
  );
  const missingCount = RANKING_COMPETITORS_REQUIRED_COUNT - confirmedCount;
  return {
    kind: "ranking-competitors-required",
    confirmedCount,
    missingCount,
    instruction: rankingDeficitInstruction(confirmedCount, missingCount),
  };
}

/**
 * 门卡续跑共享入口（票 #45）：确认卡裁决（decide-batch 路由钩子）与
 * confirm_ranking_competitors 工具共用同一份续跑逻辑，防双发。名单达标后
 * 清门卡并以「暂缓项受限」的 source 续跑原生成请求——plan 类 source 的
 * itemIds 替换为 challenge.deferredItemIds（只补生成暂缓的排行项），direct
 * 源原样重发。续跑再抛不足（补充名与品牌身份互斥等边缘）时按旧围栏重挂
 * 门卡并返回新缺口，不抛错。
 */
export async function resumePendingRankingGeneration(options: {
  gate: RankingCompetitorConfirmationGate;
  challenge: RankingCompetitorConfirmationChallenge;
  startOperation: (
    source: ArticleOperationSource,
  ) => Promise<ArticleOperationProjection>;
  /** 续跑再不足时重挂门卡的围栏消息 id（沿用原围栏；缺省用原 challenge 值）。 */
  fenceUserMessageId?: string;
}): Promise<RankingGenerationResumeOutcome> {
  const { gate, challenge } = options;
  const source: ArticleOperationSource =
    challenge.deferredItemIds?.length && challenge.source.kind === "confirmed-topic-plan"
      ? { ...challenge.source, itemIds: challenge.deferredItemIds }
      : challenge.source;
  // 单飞经门卡持有（票 #45 评审防双发）：同一门卡并发触发的续跑共用一次
  // start——键只取 challenge 身份，工具路径附带的 userInstruction 与围栏
  // 消息 id 不参与（否则工具×钩子两路径键必不同，单飞形同虚设）。
  const outcome = await gate.resumeOnce(rankingChallengeKey(challenge), async () => {
    gate.clear();
    try {
      const operation = await options.startOperation(source);
      return { kind: "ranking-generation-resumed" as const, operation };
    } catch (error) {
      const requirement = rankingCompetitorRequirement(error);
      if (!requirement) throw error;
      // 重挂门卡（同主体去重会让 issue 空转，这里 pending 已清空必然生效），
      // 围栏推进到最新用户消息：续跑失败后的补名仍需新的用户回复授权。
      gate.issue({
        subject: challenge.subject,
        source: challenge.source,
        issuedAfterUserMessageId:
          options.fenceUserMessageId ?? challenge.issuedAfterUserMessageId,
        ...(challenge.deferredItemIds ? { deferredItemIds: challenge.deferredItemIds } : {}),
      });
      return { kind: "ranking-generation-still-required" as const, requirement };
    }
  }) as RankingGenerationResumeOutcome;
  return outcome;
}

/**
 * 确认卡裁决后的自动续跑钩子（票 #45）：decide-batch 路由在竞品事实被
 * 采纳后调用——重算合并名单（内核投影：身份排除＋两层合并），达标且有
 * 挂起门卡时清门卡并自动续跑原生成请求（plan 类按暂缓项受限）。fire-
 * and-forget 由路由侧控制；本函数自身全容错，任何异常只记日志不抛出。
 * authority/startOperation 可注入，单测不落库不打网关。
 */
export async function resumeRankingGenerationAfterKnowledgeDecision(input: {
  workspaceId: string;
  sessionId: string;
  accountToken?: string;
  gate: RankingCompetitorConfirmationGate;
  authority?: Pick<
    ReturnType<typeof createKnowledgeAuthority>,
    "inspect"
  >;
  startOperation?: (
    source: ArticleOperationSource,
  ) => Promise<ArticleOperationProjection>;
}): Promise<{ resumed: boolean }> {
  try {
    const pending = input.gate.pendingChallenge();
    if (!pending) return { resumed: false };
    const authority = input.authority ?? createKnowledgeAuthority({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    const [fullNames, shortNames, relatedBrands, competitors, potential] =
      await Promise.all([
        inspectBrandScopeStringList(authority, pending.subject, "enterprise-profile.fullname"),
        inspectBrandScopeStringList(authority, pending.subject, "enterprise-profile.shortnames"),
        inspectBrandScopeStringList(authority, pending.subject, "enterprise-profile.relatedbrands"),
        inspectBrandScopeStringList(authority, pending.subject, "enterprise-profile.competitors"),
        inspectBrandScopeStringList(authority, pending.subject, "enterprise-profile.potentialcompetitors"),
      ]);
    const merged = mergeRankingCompetitorTiers(
      competitors,
      potential,
      {
        workspaceBrandName: pending.subject,
        fullNames,
        shortNames,
        relatedBrands,
      },
    );
    if (merged.length < RANKING_COMPETITORS_REQUIRED_COUNT) return { resumed: false };
    const startOperation = input.startOperation ?? ((source: ArticleOperationSource) => {
      const services = geoServices(
        { workspaceId: input.workspaceId, sessionId: input.sessionId },
        { accountToken: input.accountToken },
      );
      return services.article.start({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        source,
      });
    });
    const outcome = await resumePendingRankingGeneration({
      gate: input.gate,
      challenge: pending,
      startOperation,
    });
    if (outcome.kind === "ranking-generation-still-required") return { resumed: false };
    console.log(`[articles] ranking generation auto-resumed after competitor confirmation (deferred=${pending.deferredItemIds?.length ?? 0})`);
    return { resumed: true };
  } catch (error) {
    console.log(`[articles] ranking auto-resume skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { resumed: false };
  }
}
