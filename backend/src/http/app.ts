import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { BackendDeps } from '../deps';
import type { AccountRow } from '../domain/types';
import { AppError } from '../errors';
import { createAdminRoutes } from './admin-routes';
import { createAuthRoutes } from './auth-routes';
import { createBillingRoutes } from './billing-routes';
import { createDistributionCallbackRoutes } from './distribution-callback-routes';
import { createGatewayRoutes } from './gateway-routes';
import { createProviderProxyRoutes } from './provider-proxy-routes';

export interface BackendEnv {
  Variables: {
    account: AccountRow;
  };
}

/**
 * 应用工厂：全部依赖注入（db/config/时钟），测试用 `app.request()` 直打
 * HTTP 合约，不起端口。错误统一走 onError：AppError 带语义 code，其余
 * 一律 500 且不外泄内部信息。
 */
export function createBackendApp(deps: BackendDeps): Hono<BackendEnv> {
  const app = new Hono<BackendEnv>();

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.code, message: error.message, ...error.details },
        error.status as ContentfulStatusCode,
      );
    }
    console.error('[backend] unhandled error:', error);
    return c.json({ error: 'internal_error', message: '服务器内部错误。' }, 500);
  });

  app.get('/healthz', c => c.json({ ok: true }));

  app.route('/', createAuthRoutes(deps));
  app.route('/', createBillingRoutes(deps));
  app.route('/', createAdminRoutes(deps));
  app.route('/', createGatewayRoutes(deps));
  app.route('/', createProviderProxyRoutes(deps));
  app.route('/', createDistributionCallbackRoutes(deps));

  return app;
}
