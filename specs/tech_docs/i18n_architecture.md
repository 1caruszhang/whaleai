# UI Internationalization

小鲸同学只翻译产品 UI 与原生通知；用户内容、Agent 输出、workspace 文件和日志原文不做自动翻译。

## Authority

v1 产品决策：只有一种 authored 语言（zh-CN）。Renderer `XiaojingI18nSync`（`src/renderer/i18n/I18nLanguageSync.tsx`）在挂载时无条件固定 `zh-CN`（`document.documentElement.lang` + i18next `changeLanguage`）；Settings 没有语言选项，Renderer 也不监听 `ui-language-changed`，不存在可覆盖该事实的用户面。

Rust `i18n.rs` 仍是**原生通知文案**的 locale owner：`current_locale()` 从 `Xiaojing local-data root/config.json` 读 `uiLanguage`（缺省 `system`，经 `sys-locale` 解析为受支持 locale，再兜底 zh-CN），`notification.rs` 用 `t()` 取短文案。写盘失败不广播成功状态。

设置链路 `cmd_set_ui_language` / `apply_ui_language` / `cmd_sync_ui_language_from_config`（config 锁内写盘 + emit `ui-language-changed`）与 `cmd_get_ui_language_state` 是为未来多语保留的预留能力，v1 无 Renderer 消费者。启用多语时必须成对补齐：Renderer 事件监听替换 `XiaojingI18nSync` 的强制固定、Settings 语言选项、两端资源与 key parity 测试——只写盘不接 UI 视为未启用。

## Resources

- `src/shared/i18n.ts`：locale allowlist 与 normalize。
- `src/renderer/i18n/index.ts`：i18next 初始化和资源注册。
- `src/renderer/i18n/locales/<locale>/`：`common`、`app`、`chat` namespaces。
- `src-tauri/src/i18n.rs`：原生语言状态与通知短文案。

新增 locale 必须同时更新共享 allowlist、两端资源、Settings 选项与 key parity tests。不要在页面中重新实现 system-locale 或把 React state 当磁盘 authority。
