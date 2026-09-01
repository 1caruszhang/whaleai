import type { ArticleProjection } from "../../../shared/geo/articleGeneration";

/** 文章状态的中文展示名：批准卡与文章阶段面板共用的唯一映射（票 #34 补入 discarded）。 */
export const ARTICLE_STATUS_LABELS: Record<
  ArticleProjection["status"],
  string
> = {
  planned: "排队中",
  drafting: "生成中",
  draft_ready: "草稿待审核",
  reviewing: "审校中",
  approved: "已批准",
  generation_failed: "生成失败",
  rejected: "风险阻断",
  discarded: "已弃用",
};
