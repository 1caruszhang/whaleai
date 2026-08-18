import type { BackendConfig } from './config';
import type { SqlClient } from './db/client';

/** 应用依赖注入根：测试注入临时 SQLite、假时钟与短 TTL，不读环境变量。 */
export interface BackendDeps {
  db: SqlClient;
  config: BackendConfig;
  /** epoch 毫秒；生产为 Date.now，测试可控。 */
  now: () => number;
  /**
   * 上游 HTTP 客户端注入点（网关代理，票 04）：测试注入 mock 上游，
   * 不触真实网络；缺省用全局 fetch。
   */
  fetchImpl?: typeof globalThis.fetch;
}
