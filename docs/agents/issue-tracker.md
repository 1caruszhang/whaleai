# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues (`1caruszhang/whaleai`). Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

> **本机现状（2026-08-31）**：`gh` CLI 已安装（`C:\Program Files\GitHub CLI\gh.exe`，新开 shell 才在 PATH 里）。尚未交互式登录：git 凭据管理器里的存量 token 缺 `read:org` 作用域，`gh auth login --with-token` 会拒收。在那之前，gh 命令按需附带 `GH_TOKEN`（从 `git credential fill` 现取现用，不落盘）：
>
> ```bash
> pw=$(printf "protocol=https\nhost=github.com\n\n" | GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 git credential fill | sed -n 's/^password=//p')
> GH_TOKEN="$pw" gh issue list   # …用完 unset pw
> ```
>
> 做一次交互式 `gh auth login`（浏览器流）后删除本段，gh 即恢复无感使用。

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: linked to the map as a GitHub sub-issue, or added to a task list in the map body with `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: GitHub's native issue dependencies (`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, database id not `#number`). Fallback: `Blocked by: #<n>` line at the top of the child body.
- **Frontier query**: open children of the map, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`. **Resolve**: comment the answer, close, append a pointer to the map's Decisions-so-far.
