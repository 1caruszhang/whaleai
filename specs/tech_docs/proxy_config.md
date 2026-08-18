# Proxy Configuration

代理设置的磁盘 authority 是当前 Xiaojing 数据根中的 `config.json`。Rust `config_io` 在文件锁内合并写入，`proxy_config` 负责解析、校验和向子进程投影。

## Scope

- `generalRequests`：小鲸拥有的普通 HTTP 调用。
- Provider scope：按固定 capability slot/provider id 决定是否向目标 Session Sidecar 注入代理。

localhost/loopback 永远进入 bypass；代理配置不能改变 Rust 与 Session Sidecar 的本机控制面。未配置时继承进程既有网络环境，不读取 shell 初始化文件。

Node 中的应用自有请求使用集中 helper，并携带 timeout、取消和 SSRF 校验。Provider SDK 只能获得 admission 后生成的环境快照；配置变化通过磁盘事实和 generation replacement 生效。

日志只记录 owner、scope 和路径选择，不记录代理口令或完整 URL。默认测试使用本地 fake server，不访问真实网络。
