import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 运营台 SPA：base=/admin/——构建产物同域挂在后端 Hono 静态托管的
 * /admin/* 前缀下（票 46），nginx/发布链路零改动。
 */
export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
  server: {
    // 开发代理只接 SPA 会打的 JSON API（登录）；页面 GET 仍由 vite 兜 SPA。
    // 生产形态（静态托管 + API 优先）由后端合约测试与容器冒烟验证。
    proxy: {
      '/admin/login': 'http://127.0.0.1:8787',
    },
  },
});
