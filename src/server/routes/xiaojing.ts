import { handleXiaojingContentPipelineRoute } from './xiaojing-content-pipeline';
import { handleXiaojingEffectsRoute } from './xiaojing-effects';
import { handleXiaojingGeoOperationsRoute } from './xiaojing-geo-operations';
import { handleXiaojingKnowledgeRoute } from './xiaojing-knowledge';
import { handleXiaojingQuestionPoolsRoute } from './xiaojing-question-pools';
import type { XiaojingRouteContext } from './xiaojing-shared';

/**
 * `/api/xiaojing/*` 业务路由的唯一入口：按域拆成五个模块顺序匹配，
 * 任一模块命中即返回；全部未命中返回 null 交回 index.ts 的 404 兜底。
 */
export async function handleXiaojingRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  return (await handleXiaojingGeoOperationsRoute(pathname, request, ctx))
    ?? (await handleXiaojingKnowledgeRoute(pathname, request, ctx))
    ?? (await handleXiaojingQuestionPoolsRoute(pathname, request, ctx))
    ?? (await handleXiaojingContentPipelineRoute(pathname, request, ctx))
    ?? (await handleXiaojingEffectsRoute(pathname, request, ctx))
    ?? null;
}
