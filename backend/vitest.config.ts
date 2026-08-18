import { defineConfig } from 'vitest/config';

// 后端合约/单元测试全部走 Hono `app.request()` + 临时 SQLite 文件，
// 不监听端口、不触真实网络（AGENTS.md 默认测试纪律）。
export default defineConfig({
  test: {
    name: 'backend',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
  },
});
