# 小鲸同学

小鲸同学（Xiaojing）是一个桌面端 GEO 营销工作台。产品只有两个一级入口：主聊天和品牌工作台。主聊天负责与内置模型会话交互；品牌工作台负责素材、知识、问题池、选题、文章、分发、发布和发布后监测。

## 技术结构

- `src/renderer/`：React 19 桌面界面。
- `src/server/`：随 Session 启动的 Node.js Sidecar；每个 Session 恰好一个进程。
- `src/shared/`：前后端共享的纯类型和策略。
- `src-tauri/`：Tauri v2 壳、进程 owner、本地持久化、HTTP/SSE 代理、工作区文件与通知。

应用使用随包提供的 Node.js。生产配置、日志和 Session 元数据只写入 Xiaojing 自己的数据根；不会读取或迁移其他产品的数据目录。

## 本地开发

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run tauri:dev
```

构建前端与 Sidecar：

```bash
npm run build:web
npm run build:server
cargo check --manifest-path src-tauri/Cargo.toml
```

真实 Provider 验证不属于默认测试池；只有显式执行 `npm run test:credentialed` 才会进入凭据测试项目。

## 核心不变量

- `Session : Sidecar = 1 : 1`；Tab、后台补全和 GEO 监测是仅有的进程 owner。
- Renderer 的控制面请求经 Rust 转发；附件是登记过的大载荷数据面。
- BrandWorkspace SQLite 和 Session 元数据各自拥有自己的持久化事实，不能用前端缓存相互覆盖。
- Provider 凭据由 Rust admission 注入 Sidecar，不进入 renderer、日志或仓库。
- 发布后监测由 BrandWorkspace 中的隐藏 schedule 驱动，不形成独立产品入口。

架构边界见 [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md)，交互规范见 [specs/DESIGN.md](specs/DESIGN.md)。`.scratch/` 下的 issue 仅记录历史验收上下文，不代表当前实现。
