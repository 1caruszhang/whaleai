/**
 * 服务端价目表（票 03）。商业规格红线：permit 申请携带的 单价/基础费 只作
 * 客户口径对账，扣多少永远由本表决定——客户端价目与服务端漂移时申请被拒
 * （price_mismatch），而不是按客户端价格扣点。
 *
 * 定价来源：commercial-beta 决策票 07「结算细则（2026-08-19 用户调价定稿版）」，
 * 与《计费标准》公示文件同源；调价 = 改本表 + 公示文件同步。价目只定单价，
 * 不定批量上限（单位数由路由层做全局合理性校验）。
 *
 * 发布订单（媒介费×1.6 向上取整，渠道单价含 60% 服务费）按渠道逐单变价，
 * 属票 08 的渠道价目面，不进本固定价目表。
 */
export type BillingOperation =
  | 'material_import'
  | 'question_pool'
  | 'baseline_probe'
  | 'topic_planning'
  | 'topic_planning_regen'
  | 'article_generation'
  | 'article_rewrite'
  | 'distribution_planning'
  | 'monitoring_patrol';

export interface OperationPrice {
  /** 固定基础费（点），绑定首个成功单位结转；全部失败随整体退回。 */
  base: number;
  /** 每最小成败单位的点数。 */
  perUnit: number;
}

export const OPERATION_PRICES: Readonly<Record<BillingOperation, OperationPrice>> = {
  // 材料导入/知识抽取：20 点/份，失败份数退。
  material_import: { base: 0, perUnit: 20 },
  // 关键词+问题池生成：15 点/次，整体失败退全款。
  question_pool: { base: 0, perUnit: 15 },
  // 基线探测（效果入口/监测前置）：5 点/问，单问失败退该问。
  baseline_probe: { base: 0, perUnit: 5 },
  // 主题/标题规划：初次 20 点/次。
  topic_planning: { base: 0, perUnit: 20 },
  // 主题/标题规划：重生成 10 点/次。
  topic_planning_regen: { base: 0, perUnit: 10 },
  // 文章生成：20 点/篇，失败篇独立退。
  article_generation: { base: 0, perUnit: 20 },
  // 文章改写（审批门）：10 点/篇。
  article_rewrite: { base: 0, perUnit: 10 },
  // 分发计划（含渠道发现，一次确认）：基础 30 点 + 被动路 5 点/问。
  distribution_planning: { base: 30, perUnit: 5 },
  // 监测巡检：5 点/问/次。
  monitoring_patrol: { base: 0, perUnit: 5 },
};

export function isBillingOperation(operation: string): operation is BillingOperation {
  return Object.hasOwn(OPERATION_PRICES, operation);
}
