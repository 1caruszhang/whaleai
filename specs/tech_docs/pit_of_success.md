# Pit of Success

本文只记录小鲸同学仍在执行的高代价不变量。静态可判定的规则由 ESLint、dependency-cruiser、Clippy 和测试直接执行。

## Owner 先于机制

- BrandWorkspace 拥有品牌事实、批准产物、发布与监测状态。
- Session 拥有聊天记录、SDK binding 与一次会话内的未确认工作。
- GeoOperation 拥有一次工作台操作的状态机和 revision。
- Renderer 只消费 projection；任何确认、claim、结算或版本推进都回到 Rust owner。

不要用缓存、前端 guard 或重试掩盖 owner 错位。新增状态前先回答创建、持久化、修改、释放和并发裁决分别属于谁。

## 进程树与 Session Sidecar

所有子进程通过 `process_cmd` 创建。Unix 使用独立 process group；Windows 使用 kill-on-close Job Object。owner 必须保留 `ChildTree`，停止与 Drop 只清理这棵精确进程树，不按全机进程名或 argv 猜测。

一个 Session 只对应一个 Sidecar generation。创建、恢复、替换、owner 交接和删除都在 per-Session lifecycle fence 内完成。任何网络探测、端口文件或 renderer 状态都不能替代锁内裁决。

## 控制面与大载荷

普通 HTTP/SSE 从 Renderer 经 Rust 转发。Rust 在当前 generation 上取得 dispatch lease，完成响应物化后释放。仅 `/refs/:id` 与 `/attachment/*` 使用登记过的原生数据面；它们同时受 CORS、CSP、大小和路径策略约束。

新增 SSE JSON 类型时必须同步更新 renderer 白名单。断开订阅只结束 transport，不取消已经接纳的 turn。

## 磁盘写入

配置写入必须在文件锁内重新读取磁盘并合并，再用同目录临时文件和原子替换发布。Session metadata、transcript 和 BrandWorkspace SQLite 各自保持单一写入 owner。

工作区 IO 只能走 `cmd_workspace_*` 和 `useWorkspaceFileService(workspacePath)`。路径先经 no-follow 解析和系统/凭据目录拒绝；不要把绝对路径交给 Node 路由绕开 Rust。

## Provider 边界

凭据由 Rust 原生存储拥有，只在通过 workspace、Session、generation 与 capability admission 后注入目标 Sidecar。密钥不得进入 Renderer、日志、SQLite、测试夹具或构建环境。

所有默认测试使用空配置和替身，不调用真实 Provider。credentialed 测试必须显式运行。

## GEO 后台执行

发布和监测由 BrandWorkspace 的确定性调度 owner 驱动。模型只提出候选或继续对话，不能推进付费、上传、发布、监测激活或结算。重试必须消费持久化 claim/idempotency key，并再次验证 exact revision。

## 跨语言契约

TS↔Rust（含网关）共享的常量契约——枚举集、版本戳、限值与公式——禁止手写镜像或注释声明同源（ADR-0012）。唯一形态：`*Contract.json` 为裁判，Rust `include_str!` pin 测试与 TS import pin 测试断言严格相等（含顺序）；公式类附用例向量，全部实现跑同一 cases。新增跨语言常量先建 Contract.json 再写两侧常量；同步注释词汇在非测试源文件中由守卫测试断言零命中。

名单语义只出自内核（票 #43）：竞品名单的投影（排行 roster、标题红线、卡面行）、身份判定与归一键只许定义在 `src/shared/geo/competitorRoster.ts`，消费方一律进口，原居所不留转发出口；词法守卫（competitorRosterGuard.test.ts，零豁免）拦「内核导出函数名在别处重定义」，但拦不住换名私建归一/合并逻辑，也拦不住改定义形态——守卫正则只识别 `function X(`／`const X =` 两种形态，class 方法简写、`let`/`var` 绑定、对象属性函数均可绕过；防第二份手抄副本靠跨语言契约 pin 与 review，新增名单语义先改内核再接消费方。

## 验证

删除 owner 后同时删除命令注册、route、类型、测试、配置、资源和文档。`npm run verify:geo-surface` 是失败即退出的全仓门禁；禁止用注释、别名或排除规则保存已删除事实。
