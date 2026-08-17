import type { GeoContentType } from "../../../shared/geo/portContract";

/** 五类内容的中文展示名：产物面板与聊天卡片共用的唯一映射。 */
export const CONTENT_TYPE_LABELS: Record<GeoContentType, string> = {
  guide: "指南",
  showcase: "品牌详情",
  ranking: "对比清单",
  news: "深度新闻",
  news_light: "轻量新闻",
};
