import { Hono } from 'hono';
import type { BackendDeps } from '../deps';
import { requireAccountAuth } from './auth-routes';
import {
  MAX_PREFERENCE_CODES,
  resolvePreferenceChannelsForCodes,
} from '../domain/preference-channels';
import type { BackendEnv } from './app';

/**
 * 桌面端配置拉取面（账号 token 鉴权，照 /billing/* 的最小只读形态）。
 * GET /config/preference-channels?codes=13,18 —— 偏好召回名单按官方行业
 * 分类码下发（回落语义，用户裁决 2026-09-08）：码集命中行业行 → 只回
 * 行业行（通用不并集）；codes 缺省/为空/无命中 = 只回通用行（兜底）。
 * 行业隔离在本端点完成——桌面端只传自己计划行业的码集，收不到其他
 * 行业行（软隔离：防界面/投影暴露，不防登录用户直接遍历 codes 调用）。
 */
export function createConfigRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const requireAccount = requireAccountAuth(deps);

  routes.get('/config/preference-channels', requireAccount, c => {
    const raw = (c.req.query('codes') ?? '').trim();
    const codes: number[] = [];
    if (raw !== '') {
      const parts = raw.split(',');
      if (parts.length > MAX_PREFERENCE_CODES) {
        return c.json(
          { error: 'validation_error', message: `codes 最多 ${MAX_PREFERENCE_CODES} 个。` },
          400,
        );
      }
      for (const part of parts) {
        const trimmed = part.trim();
        if (!/^\d{1,4}$/.test(trimmed)) {
          return c.json(
            { error: 'validation_error', message: 'codes 必须是逗号分隔的非负整数。' },
            400,
          );
        }
        codes.push(Number.parseInt(trimmed, 10));
      }
    }
    return c.json({ channels: resolvePreferenceChannelsForCodes(deps.db, codes) });
  });

  return routes;
}
