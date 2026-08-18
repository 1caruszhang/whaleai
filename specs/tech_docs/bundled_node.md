# Bundled Node

小鲸同学的 Session Sidecar 使用应用内置 Node.js v24，不探测或回退到用户安装的 Node。

## 资源布局

Tauri bundle 只登记以下运行资源：

- `server-dist.js`：由 `npm run build:server` 生成的 Session Sidecar bundle。
- `nodejs/`：当前平台的 Node 可执行文件与小鲸标记。
- `claude-agent-sdk/`：固定版本 SDK 的平台资源。
- `sharp-runtime/`：附件图像处理所需的当前平台资源。
- `shared/`：Sidecar 与桌面壳共享的纯契约。

`scripts/download_nodejs.sh` 只准备当前 Unix host，且 staging 中只保留 `node`。Windows x64 资源与安装包布局由后续打包票据重新定义。

## 启动规则

`src-tauri/src/sidecar/spawn.rs` 从 bundle resources 或开发时的可执行文件相邻目录解析 Node。定位失败立即报错；不得搜索用户 home、shell 配置或系统 Node。

Sidecar 以 Session identity、workspace、management port、generation 和受控 Provider 环境启动。stdout 只用于握手和有界诊断，stderr 由统一日志边界接管。

## 构建

Tauri 的 `beforeBuildCommand` 只运行 web 与 server 构建。最小本地验证顺序为：

```bash
npm run build:web
npm run build:server
cargo check --manifest-path src-tauri/Cargo.toml
```

构建脚本不得读取仓库 `.env`，也不得下载、上传、签署或发布产物。
