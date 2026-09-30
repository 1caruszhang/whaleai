# 运营台视觉轮：对齐 shadcn-admin 的逐页复刻映射

运营台（admin-web）六票功能验收通过后，用户裁定做一轮视觉整改：**逐页对齐参考项目 shadcn-admin 的外观与动效语言**（壳层可折叠侧栏、页头、路由进度条、骨架屏，登录/仪表盘/账号列表/账号详情四个内容页），但不复刻它的示例功能。本 ADR 是视觉轮三张票（T-A 壳与主题、T-B 登录+仪表盘、T-C 列表+详情）的共同验收输入：每票以本文件对应章节为「对齐到什么程度」的基准。功能与信息架构一律不变，纯样式/动效层改造，backend 零改动。

## 技术底座（一次定死，三票共用）

- **不引入 framer-motion/motion**：shadcn-admin 主分支同样只用 tw-animate-css + Radix data-state 动画，其观感由「动效铺满度」而非 JS 动画库达成；引入 motion 属无谓的新运行时依赖。
- **顶部进度条自实现**：以导航提交信号（location.key）驱动扫描动画 + CSS（壳为声明式 router，无 in-flight 信号可挂），不引 react-top-loading-bar——运营台仅 4 页、切页极快，为一个进度条引入依赖不值。
- **页头搜索框复用现有 command-search（Cmd+K）**：样式对齐 shadcn-admin 的搜索框，点击唤起既有面板；不引 cmdk。
- **logo 复用主应用品牌图** `src/renderer/assets/brand/xiaojing-logo.png`：复制进 `admin-web/src/assets/`（二进制品牌资产镜像，文件头注释注明来源与「改图需两端同步」纪律），替换现渐变「鲸」字文字块。

## 映射清单

### T-A 壳与主题（全局）

| 对齐对象 | 要素 |
|---|---|
| 可折叠侧栏 | 折叠按钮；icon-only 折叠态；宽度过渡 `transition-[width] duration-200 ease-linear`；折叠态图标带 tooltip；激活项高亮与 hover 样式对齐 |
| 页头 Header | 左：页面标题/breadcrumb；搜索框样式（点击唤起现有 Cmd+K 面板）；右：主题开关（日/月双图标 scale/rotate 交叉淡入）+ 用户菜单 |
| 路由进度条 | 顶部加载条，react-router pending 驱动（自实现） |
| Skeleton | 新增 `ui/skeleton` 组件；全站加载态由「…/加载中」文字替换为骨架屏 |
| 主题切换 | class 切换补过渡动画（当前是瞬时翻转） |
| 工具类 | faded-bottom 渐变遮罩、全局按钮 cursor-pointer；保持 specs/DESIGN.md 的可访问性约束（可见 focus、图标按钮可访问名、颜色不作状态唯一载体） |

不做：shadcn-admin 的布局配置抽屉与 4 布局切换（演示功能，用户裁定排除）。

### T-B 登录 + 仪表盘

- **登录页 → shadcn-admin sign-in 页**：居中卡片 + 品牌 logo 图 + 标题；密码可见性切换；错误提示样式（保留 role=alert 语义）；提交按钮 loading 态；卡片入场淡入。
- **仪表盘 → shadcn-admin dashboard**：页头（标题 + 描述 + 右侧操作）；统计卡（圆角色块图标 + 数值 + 增幅/描述，hover 阴影）；折线图卡（图例、渐变面积、tooltip 样式、加载骨架 + 入场动画）；媒介池卡对齐其 Recent Sales 卡样式（degraded 降级状态样式保留）。四卡加载态为骨架屏，卡片入场淡入 + hover 微交互。

### T-C 账号列表 + 账号详情

- **账号列表 → shadcn-admin Users 页**：页头（标题 + 描述 + 「新建账号」按钮）；工具栏（搜索框 + 排序下拉 + 分页）；卡片式表格（圆角 border、行 hover、操作下拉菜单、骨架屏、空态）。9 列内容与品牌 chips 只读展示不变，仅样式对齐。
- **账号详情 → shadcn-admin 详情卡布局**：页头（返回 + 标题 + 操作）；余额总览卡组 + 各区块卡片（充值调点/流水/permit/发布订单/provider/对话计量 + 用户名编辑）；编辑对话框样式对齐；加载骨架屏。

### 不纳入视觉轮

- 偏好名单页：维持 SSR 形态，只补 SPA 入口（票 #58），不做视觉重建。

## Consequences

- 视觉轮三票均为 admin-web 纯前端改动，backend/Rust 零改动，CI 只跑根 `npm test` 相关套件。
- logo 资产在 admin-web 内形成一份镜像副本（非代码，不受跨语言契约守卫约束，但同步纪律写进文件头注释）。
- 验收口径 = 本 ADR 映射表逐项对齐 + 既有测试全绿；每票需补对应页面的渲染回归测试（导航项、骨架屏、折叠态、主题切换动画等可断言项）。
