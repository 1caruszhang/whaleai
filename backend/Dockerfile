# syntax=docker/dockerfile:1
# 鲸杉geo后端镜像（票 12 部署形态）：多阶段构建，运行层无 node_modules、
# 非 root、带 HEALTHCHECK。密钥只经运行时环境变量注入——本文件与镜像层
# 永远不出现任何真实值（红线，见 specs/guides/deploy-api-jingshanai.md）。

# ── 依赖层：npm ci（构建参数 NPM_REGISTRY 可切换 npm 镜像源，如
#    --build-arg NPM_REGISTRY=https://registry.npmmirror.com）──
FROM node:24-slim AS deps
ARG NPM_REGISTRY=""
WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
    && npm ci

# ── 构建层：单文件 bundle（scripts/bundle.mjs，与仓库 sidecar 打包同款
#    esbuild 路径）。类型检查与测试在构建前的 CI/本地执行，不进镜像。──
FROM deps AS build
COPY scripts/bundle.mjs ./scripts/bundle.mjs
COPY src ./src
RUN node scripts/bundle.mjs

# ── 运行层：node 基础镜像 + dist/index.js，仅此而已 ──
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/app/data/xiaojing-backend.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
# 存活探针用 node 内置 fetch 打 /healthz；PORT 与运行时注入的环境变量一致。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8787')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
