# UI Internationalization

小鲸同学只翻译产品 UI 与原生通知；用户内容、Agent 输出、workspace 文件和日志原文不做自动翻译。

## Authority

`AppConfig.uiLanguage` 保存 `system | zh-CN | en-US`。Rust `i18n.rs` 在当前 Xiaojing `config.json` 上通过 `config_io` 锁内写入，并 emit `ui-language-changed`。Renderer `I18nLanguageSync` 读取该 projection 并切换 i18next。

`system` 由 Rust `sys-locale` 解析；浏览器开发环境才使用 `navigator.languages` fallback。写盘失败时不广播成功状态。

## Resources

- `src/shared/i18n.ts`：locale allowlist 与 normalize。
- `src/renderer/i18n/index.ts`：i18next 初始化和资源注册。
- `src/renderer/i18n/locales/<locale>/`：`common`、`app`、`chat` namespaces。
- `src-tauri/src/i18n.rs`：原生语言状态与通知短文案。

新增 locale 必须同时更新共享 allowlist、两端资源、Settings 选项与 key parity tests。不要在页面中重新实现 system-locale 或把 React state 当磁盘 authority。
