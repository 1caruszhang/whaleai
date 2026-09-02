import { compoundAnchorValueEntries } from "../../shared/geo/topicPlan";

/**
 * 锚源复合值 WARN 留痕（用户裁决 2026-09-01）：shared 只负责判定
 * （compoundAnchorValueEntries 不打日志），服务端口径统一在这里——
 * 复合写法说明知识登记口径有歧义，运营侧可据此回头清理事实。
 * topic-plan 的 deriveProfile 与 article-generation 的 direct 标题路径
 * 消费同一批锚源值（industry/业务词/竞品/关联品牌/地域），巡检共用
 * 本入口保证不留盲区。
 */
export function warnCompoundAnchorValues(
  tag: string,
  fields: ReadonlyArray<readonly [field: string, value: string]>,
): void {
  for (const [field, value] of compoundAnchorValueEntries(fields)) {
    console.warn(`[${tag}] ${field} 复合值按分隔符拆分处理：${value}`);
  }
}
