# 偏好召回名单·匹配挑选流程（池快照 + id 绑定 + 名称兜底）设计与实施单

> 2026-09-08 与用户拍板的方案。实现本方案的 session 从本文档出发，不需要
> 重新推导设计。背景见 `distribution_planning.md` 的「偏好名单运营台化」
> 段落（已完成的第一阶段）。

## 一、现状（已实现、未部署、未提交）

偏好召回名单已运营台化并全绿（backend 128/128、桌面全量、typecheck/lint
链），工作区未提交。涉及文件：

- backend：`src/db/migrations.ts`（0010 表+十项种子）、`src/domain/preference-channels.ts`
  （码表/CRUD/按码合并）、`src/http/admin-pages.ts`（管理页：分组表格+添加+删除，
  **无编辑**）、`src/http/config-routes.ts`（`GET /config/preference-channels?codes=`）、
  `backend/tests/preference-channels.test.ts`、README。
- 桌面：`src/shared/geo/channelRecall.ts`（删 `DEFAULT_PREFERENCE_CHANNELS`，
  `resolvePreferenceChannels(base, settings?)` 改参）、`src/server/geo/distribution-plan.ts`
  （`preferenceIndustryCodes` + `fetchPreferenceChannelsFromGateway` 5s 超时/严格解析/
  降级告警）、`src/server/geo/service-composition.ts`（请求级 token 优先注入）、
  面板文案、两侧测试。
- 行业键现状：「品牌所属行业」选择器——backend `PREFERENCE_CATEGORY_NAMES`
  （0=通用、1-25 与自媒体行业分类附录逐条一致、26=工业贸易为媒体附录补位码）；
  桌面 `preferenceIndustryCodes` 双码集计算。**本方案不改行业维度**。

本地预览（当前 session 的后台服务停止后）：

```bash
cd backend && \
ARK_API_KEY=local-preview OSS_ACCESS_KEY_ID=local-preview \
OSS_ACCESS_KEY_SECRET=local-preview OSS_BUCKET=local-preview \
DISTRIBUTION_APP_ID=local-preview DISTRIBUTION_SECRET=local-preview \
npm run dev     # http://127.0.0.1:8787/admin，运营密码见 backend/.env
```

（本地 `.env` 缺上述 6 个上游密钥，用占位值从进程环境注入；本地预览库
`backend/data/xiaojing-backend.sqlite` 可随时删掉重建。）

## 二、上游 API 事实（设计依据，已对官方文档核实）

文档：`C:/Users/Administrator/Desktop/超级媒介API.md`。

1. **无名称搜索**：`/media|we-media/resource` 仅 page/size（size≤200）分页；
   `/resource/query` 仅按 id 列表批查（≤200/次）。→「点击匹配」必须自建池快照。
2. **id 批查便宜**：一次 200 id → 下架校验通道现成（backend
   `DistributionUpstream.queryResource` 已有）。
3. **资源变更回调**（event=1，带 type/id）：backend
   `distribution-callback-routes.ts` 已在用它刷新定价缓存，同一套可增量刷快照。

全池规模 ≈ 2.5 万条（媒体 ~1.6 万 + 自媒体 ~0.9 万），size=200 时约 125 页/类。
快照走 backend 现成 `DistributionUpstream` 签名客户端拉取。

## 三、批准的设计（混合：id 绑定 + 名称兜底）

### 数据模型（backend）

`preference_channels` 扩列（新迁移 0011，ALTER TABLE）：

- `kind TEXT NOT NULL DEFAULT ''`：''=不限（名称兜底行为）、'media'/'we-media'
  （勾选行由资源自带）；
- `resource_id INTEGER`（nullable）：勾选行的池内资源 id；null = 名称条目
  （种子十项与手输口子）。

运行时下发条目形状（桌面 `PreferenceChannelEntry` 扩展）：
`{ name, domain?, exact?, kind?, resourceId? }`——resourceId 在场时桌面按
**id 相等**命中（形态天然正确），不在场时走现有名称匹配（`preferenceEntryMatches`）。
种子十项**不迁移**：运营在页面上渐进删除重绑，无上线日风险。

### 配置流程（运营台，零客户端 JS）

1. 名单页加搜索表单（GET `?q=名称`）：快照内对媒体+自媒体名称做包含匹配
   （服务端 `contains`，结果≤50 条），渲染结果表：名称/形态/价格/在售状态/
   GEO 标记，每行复选框；
2. 勾选 + 选「品牌所属行业」（现有下拉不变）→ 确认 POST：每勾一行落一条
   `(category, kind, resource_id, name=挂牌名, domain=entrance 域名)`；
3. 手输口子保留（现有添加表单改名「手动添加（名称条目）」）；
4. 行内**编辑**补上（照 admin-pages 的 note 卡模式：行内表单改 category；
   名称/资源不可改——要改就删了重选）；
5. 每行显示快照状态：status≠2 标红「已下架」；「校验名单」按钮把全表 id
   分批（200/批）批查刷新状态与名称/价格快照。

### 池快照（backend 新增）

- 新表 `distribution_pool_snapshot(kind, resource_id, name, status, price_cents,
  geo_count, fetched_at, PRIMARY KEY(kind, resource_id))`（并入 0011）；
- 刷新：管理页「刷新池快照」手动触发（首次 ~1 分钟，串行 125 页/类 ×2，
  页间 sleep 限速）；成功后记录快照时间并在页面展示「池快照：YYYY-MM-DD HH:mm」；
  搜索只打本地快照；
- P3（可选）：资源变更回调 event=1 增量刷新对应行；定时刷新（如每日）另议。

### 桌面端（P2，改动很小）

- `PreferenceChannelEntry` 加 `kind?/resourceId?`（shared）；
- `preferenceEntryMatches`：entry.resourceId 非 null → `resource.id === entry.resourceId`
  （`ResourceIdentity` 需带 id/kind，候选环内现成）；否则走现有名称分支；
- 下发解析（`parsePreferenceChannelsResponse`）加 resourceId（正整数校验）与
  kind（白名单 ''|media|we-media）；
- 面板/投影/权重/契约注释随动，形状不变。

## 四、分期

- **P1（大头，纯 backend）**：迁移 0011（扩列+快照表）、快照拉取与刷新、
  搜索/勾选/确认流程、行内编辑、下架状态展示、测试、README
  ——**已完成（2026-09-08），实施修订与用户裁决见第六节**；
- **P2**：桌面 id 命中分支 + 解析扩展 + 测试；
- **P3（可选）**：id 批查校验按钮、回调增量刷新、定时刷新。

## 五、实现纪律与坑（前一轮实测）

1. 跨语言契约守卫（票 #41）：非测试源码注释**禁用「同源」一词**，改写为
   「逐条一致」「同一语义」等；
2. backend `SqlClient.get/all` 必须显式传 params 数组（漏传报
   `params is not iterable`）；
3. 运营台零 JS：搜索用 GET 参数渲染结果区，复选框原生，写操作 POST+PRG 303，
   全部回显过 `esc()`，zod 字符串表单（checkbox 勾选值='on'，缺省=未勾）；
4. 迁移只追加；0010 已在本地库应用过但**未部署**，新改动一律 0011；
   `tokens.test.ts` 有迁移清单硬断言需同步；
5. 测试模式：backend `startTestBackend/app.request` 直打 HTTP + 查库断言零写入；
   桌面照 `distribution-plan.unit.test.ts` 的 fake 注入；
6. `agent-session-streaming.integration.test.ts` 是已知计时型 flaky（全量负载下
   失败用例漂移、隔离运行通过），与本域无关，勿为其返工；
7. 工作区有用户在途的票 #45 改动（`xiaojing-geo-tool*`、`ranking-competitor-gate.ts`、
   `ARCHITECTURE.md` 等），其 typecheck 错误与本域无关，**不要动这些文件**；
8. 名单保密边界（软隔离）语义不变：防界面/投影暴露，不防登录用户直接调 API。

## 六、P1 实施记录与用户裁决（2026-09-08）

P1 全量落地（backend typecheck + 146/146 全绿；本地预览接真实上游实测：
快照 24612 条、勾选/下发/回落全链路走通）。本节记录实施中对第三节批准
设计的修订，**与第三节冲突处以本节为准**；后续 session（P2）从本节出发。

### 下发语义：回落（推翻第一阶段「通用恒生效并集」）

- 用户裁决 2026-09-08：码集命中行业行 → **只发行业行**（通用不并集）；
  无命中/空码集（品牌未填行业）→ 回落只发通用行。行业名单是**完整名单**
  不是增量——给行业配名单时需配全，不配则该行业整体回落通用。
- 去重（实施裁决）：绑定行整体优先且互不去重（媒体+自媒体同名号是两家
  资源）；同核心名的名称行让位给绑定行（勾选落库却被名称行静默吞掉是
  去重要防的无效写入）；名称行之间维持原核心名去重规则。

### 快照与行业过滤

- 迁移拆为 **0011**（preference_channels 扩列 + 快照表）+ **0012**（快照
  补 `category_code`/`geo`）——0011 在 session 内已被本地预览库应用，按
  「迁移只追加」纪律后续新列走 0012。
- `distribution_pool_snapshot` 比第三节列清单**多一列 `domain`**
  （entrance_link 主机名）：勾选确认要落 domain=entrance 域名，而 P1
  确认时不回源，快照是唯一上游权威来源。
- `category_code` 按形态解释（媒体=channel_type 频道类型附录，自媒体=
  industry_category 行业分类附录 1-25；同码不同义，绝不跨形态比较）。
  行业过滤规则移植自桌面 `distributionPlan.ts`（码表/营销类目排除/别名
  表/整串包含∨别名碎片∨2-gram 匹配器，backend 侧
  `src/domain/pool-industry-match.ts`，与桌面逐条一致）。
- **GEO 标记不入选行业候选**（修订 C 方案初版的「恒入选」——用户实测后
  裁决）：GEO 是召回质量信号不是行业归属，恒入选会让行业视图候选混入
  无关渠道（如三农视图出现各行业 GEO 资源）；仅在结果表展示（GEO ×N 列）。
- 刷新加固：单页失败重试 ×2（间隔 5×页延迟）后才放弃，报错文案带类别
  与页号；两类全部拉完才整类替换落库（失败零写入、旧快照保持）；分页
  护栏（1000 页/类）翻满仍收不满（runaway 上游：total 虚报/翻页不终）
  同样整次失败零写入，绝不用残缺快照静默替换旧快照。

### 管理页形态（多轮用户裁决收敛）

- **单行业视图 + 名单常驻**：顶部行业下拉即切换；通用名单恒展开；各
  行业专属名单用原生 `<details>` 按类别默认折叠、点击展开、当前查看的
  行业自动展开。
- **添加只一个动作**：渠道名输入（`<datalist>` 候选=当前行业快照前 500
  个不重名 + 本次搜索结果预渲染）→ 搜索/回车（名称完全一致的行预勾选）
  →「确认添加到本行业」（行业由视图隐藏字段携带，无第二个行业下拉）。
- **手动添加（名称条目）卡片从页面移除**（与勾选流功能重复，用户裁决）；
  `POST /admin/ui/preference-channels` 接口保留（种子类名称条目维护/测试）。
- 零 JS 纪律**唯一例外**：行业下拉一个内联 `onchange` 即时提交（用户
  裁决 2026-09-08——纯 HTML 无「select 变化即刷新候选」机制；无 script
  标签、无依赖）。
- PRG 细化：改行业成功 → 跳**目标行业**视图（行出现在哪操作者看到哪）；
  删除/确认/刷新快照 → 携当前视图行业（表单隐藏字段 viewIndustry）跳回。

### 现状与下一步

- **P2 未做**：桌面端 `preferenceEntryMatches` 尚无 id 相等分支、
  `parsePreferenceChannelsResponse` 尚未解析 resourceId/kind——此刻绑定行
  在桌面按其挂牌名走名称匹配（下发已带 kind/resourceId，桌面解析器忽略
  未知字段，无害）。P2 从第三节「桌面端」小节 + 本节下发语义出发。
- 本地预览：`backend/.env` 已含真实 DISTRIBUTION_APP_ID/SECRET/BASE_URL
  （取自根目录 `.server-deploy.env`）；dev 为 tsx watch 热重载，改后端
  代码即时生效；快照刷新约 1 分钟（页间 120ms 限速）。

### 下午收尾（2026-09-08，已完成）

原「待办（2026-09-08 下午交接）」四项全部执行完毕：

1. **A 方案已落地**：搜索 GET 加 `u=1` 复选框（「包含未分类」）；
   `industryFilterSql` 勾选时并入 `category_code IS NULL / 0 / 100`（100=媒体
   「其他频道」，自媒体附录无此码天然无命中）；营销专区 13/14/15 仍排除
   ——打包卖法不是渠道。`searchPoolSnapshot` 与 datalist 候选（
   `listPoolSnapshotNames`）同参数联动；不勾选时行为与现状完全一致。空态
   提示在不勾时指向开关。测试：u=1 并入 NULL/0/100、营销仍排除、datalist
   联动、复选框状态与提示（backend 149/149 全绿）。
2. **注释已修正**：桌面 `distribution-plan.ts` 偏好拉取处改为「空码集 =
   行业词未填（产品流不可达，Rust 建计划硬门）或词表外行业词（真实可达，
   如 法律服务/殡葬服务 → []，回落通用）」。
3. **0013 辨识修复随本批提交**：快照 `platform`/`fans_number` 两列 + 上游
   解析 + 搜索结果「形态 · 平台 · 粉丝档」辨识列 + 主列表绑定行平台后缀
   （灰显）。
4. 部署方案（scp 直传 78MB 镜像曾超时且触发 SSH 瞬时限流）：**10×8MB 分块
   上传（单块重试）+ 服务器 `cat` 拼回 + sha256 双端校验后再 `up`**；部署后
   生产需重刷池快照一次（约 1 分钟；已配置的名单不受影响）。生产 SSH
   目标 `root@8.137.194.137`（默认密钥，无跳板）。
