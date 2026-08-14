# 从链接一键安装 Skill

MyAgents v0.1.66 起支持从 GitHub 链接或 `npx skills add` 命令直接把社区 skill 装到本地。**不再需要** 手动 `git clone` 或 `cp -r ~/.claude/skills/...`。

## GUI 操作

**设置 → 技能 → 新建 → 从链接导入**

在弹出的对话框中粘贴任意一种形式：

```
foo/bar
https://github.com/anthropics/skills
https://github.com/vercel-labs/skills/tree/main/skills/react-best-practices
foo/bar@baz
npx skills add foo/bar --skill baz
https://example.com/x.zip
```

点击 **解析并预览** — MyAgents 会：

1. 解析链接，抽出 GitHub 仓库坐标
2. 从 `codeload.github.com` 下载 zip（默认分支 `main` → `master` 自动回退）
3. 解包到内存，扫描所有 `SKILL.md`
4. 根据内容自动进入三种模式之一：

| 模式 | 触发条件 | 交互 |
|------|---------|------|
| **直接安装** | 仓库只有单个 skill 且无同名冲突 | 一步到位，无需确认 |
| **Claude Plugins 插件选择** | 仓库含 `.claude-plugin/marketplace.json` | 列出所有 plugin 合集，用户选一个 + 勾选要装的 skill |
| **多 skill 选择** | 仓库含多个 `SKILL.md` 且没指定子路径 | 列出所有候选，用户勾选要装的 |
| **冲突确认** | 目标文件夹已存在 | 让用户决定覆盖或取消 |

## CLI 操作

```bash
# 列出已安装
myagents skill list

# 从 GitHub 链接安装
myagents skill add foo/bar
myagents skill add https://github.com/vercel-labs/skills/tree/main/skills/react-best-practices
myagents skill add foo/bar --skill baz
myagents skill add "npx skills add foo/bar --skill baz"     # 整条 npx 命令照抄

# 从 Claude Plugins 市场安装某个插件合集
myagents skill add anthropics/skills --plugin document-skills
myagents skill add anthropics/skills --plugin example-skills

# 装到当前工作区而非全局
myagents skill add foo/bar --scope project

# 覆盖已存在的同名技能
myagents skill add foo/bar --force

# 只验证不落盘
myagents skill add foo/bar --dry-run

# 其他管理命令
myagents skill info my-skill
myagents skill remove my-skill
myagents skill enable my-skill
myagents skill disable my-skill

# 从 ~/.claude/skills 把存量 skill 同步过来
myagents skill sync
```

## 支持的市场

| 市场 | 形态 | 如何在 MyAgents 使用 |
|------|------|---------------------|
| [Anthropic 官方 skills 仓](https://github.com/anthropics/skills) | `.claude-plugin/marketplace.json` | `myagents skill add anthropics/skills --plugin document-skills` |
| [Anthropic 官方 plugins 目录](https://github.com/anthropics/claude-plugins-official) | 同上 | 粘 URL，按提示选插件合集 |
| [Vercel `skills.sh`](https://skills.sh) / [vercel-labs/skills](https://github.com/vercel-labs/skills) | 标准 GitHub 仓库 | 粘 URL 或 `owner/repo` 直接装 |
| [SkillsMP](https://skillsmp.com) | 聚合站（底层指向 GitHub） | 在站上拿到源仓库 URL 后粘给 MyAgents |
| 任意 GitHub 仓库 | 含 `SKILL.md` 即可 | 直接粘链接 |

## 安全约束

| 限制 | 值 | 原因 |
|------|-----|------|
| 仓库 zip 总大小 | 50 MB | 防止下载垃圾仓库阻塞 UI |
| 单文件大小 | 5 MB | skill 资源文件一般远小于此 |
| 文件总数 | 2000 | 防止 zip bomb |
| 下载超时 | 60 秒 | 强制中断挂起请求 |
| Zip-Slip 防御 | 路径必须在目标目录内 | 恶意 zip 防御 |
| 私有仓库 | ❌ 不支持 | 401/403 直接拒绝 |
| GitLab / SSH | ❌ 不支持 | MVP 只覆盖 GitHub |

下载使用 Bun 原生 `fetch()`，自动继承应用的 `HTTP_PROXY` / `NO_PROXY` 代理设置（设置 → 通用 → 代理）。国内用户遇到 GitHub 访问不稳时，在应用代理设置里配一个代理即可。

## 对照 `npx skills add`

我们不委托 `npx skills`，而是原生实现：

| 维度 | `npx skills add -g` | `myagents skill add` |
|------|--------------------|----------------------|
| 安装位置 | `~/.claude/skills/` | `~/.myagents/skills/`（被 MyAgents 直接识别） |
| 外部依赖 | 需要系统 npm/npx | 零依赖（走 Bun 原生 fetch） |
| marketplace.json 支持 | ✗ | ✓（识别插件合集并让用户选） |
| 冲突交互 | 报错退出 | 返回预览让用户选覆盖/重命名 |
| GUI 集成 | ✗ | ✓（设置页 + Dialog） |

URL 语法完全兼容 — 用户从 skills.sh / Claude Code README 复制的任何 `npx skills add ...` 命令都能直接扔进 MyAgents。

## 已知限制（后续迭代）

- 不支持搜索（`myagents skill find <query>`）
- 不支持市场订阅持久化与 `skill update`
- 不支持 GitLab / 私有仓库 / git SSH URL
- 不记录来源 URL/commit，装完就是装完（后续可能加"来源溯源"字段到 SKILL.md frontmatter）

详见调研报告 [`specs/research/research_skill_marketplace_integration.md`](../research/research_skill_marketplace_integration.md)。
