import type { BackendConfig } from './config';
import type { SqlClient } from './db/client';

/** 应用依赖注入根：测试注入临时 SQLite、假时钟与短 TTL，不读环境变量。 */
export interface BackendDeps {
  db: SqlClient;
  config: BackendConfig;
  /** epoch 毫秒；生产为 Date.now，测试可控。 */
  now: () => number;
}
