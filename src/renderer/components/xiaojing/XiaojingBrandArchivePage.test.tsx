import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import XiaojingBrandArchivePage from "./XiaojingBrandArchivePage";

/** ADR-0007：编码已退役，存量审计头以字面构造（读侧兼容是唯一持久契约）。 */
function legacyCompetitorHeader(details: string, evidence: string): string {
  return `[[xiaojing-competitor-details:v1]]${details}
${evidence}`;
}

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/api/brandHistoryClient", () => ({
  loadBrandHistory: mocks.load,
}));

const workspace: BrandWorkspace = {
  id: "brand-17",
  name: "鲸跃科技",
  productLines: ["GEO 工具"],
  rootPath: "/brands/brand-17",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

/**
 * v7（最新）：brand.name 与 v6 同值（不进 diff），新增 fullname 与 products
 * （数组值，验证胶囊渲染）；v6 独有 industry（在 v7 diff 中体现为移除）。
 */
const history = {
  workspaceId: "brand-17",
  knowledgeVersions: [
    {
      version: 7,
      actorSessionId: "session-knowledge",
      createdAt: "2026-08-15T00:00:00Z",
      facts: [
        {
          factKey: "brand.name",
          factVersion: 2,
          normalizedValueJson: '"鲸跃科技"',
          sources: [
            {
              materialId: "material-7",
              excerpt: "公司注册品牌为鲸跃科技",
              origin: "user-approved-material",
              createdAt: "2026-08-15T00:00:00Z",
            },
          ],
        },
        {
          factKey: "enterprise-profile.fullname",
          factVersion: 1,
          normalizedValueJson: '"鲸跃科技（杭州）有限公司"',
          sources: [],
        },
        {
          factKey: "enterprise-profile.products",
          factVersion: 1,
          normalizedValueJson: '["GEO 监测","内容分发"]',
          sources: [],
        },
      ],
      usedBy: [{ kind: "question-pool", id: "pool-7", revision: 3 }],
    },
    {
      version: 6,
      actorSessionId: "session-knowledge",
      createdAt: "2026-08-14T00:00:00Z",
      facts: [
        {
          factKey: "brand.name",
          factVersion: 2,
          normalizedValueJson: '"鲸跃科技"',
          sources: [],
        },
        {
          factKey: "enterprise-profile.industry",
          factVersion: 1,
          normalizedValueJson: '"GEO 营销工具"',
          sources: [],
        },
      ],
      usedBy: [],
    },
  ],
  artifacts: [
    {
      id: "article-7-v2",
      kind: "approved-article",
      revision: 2,
      knowledgeVersion: 7,
      operationId: "operation-17",
      sessionId: "session-article",
      status: "approved",
      sourceRefs: [
        { kind: "knowledge-version", id: "7", revision: 7 },
        { kind: "topic-plan", id: "topic-7", revision: 1 },
      ],
      usedBy: [{ kind: "distribution-plan", id: "distribution-7", revision: 4 }],
      createdAt: "2026-08-15T00:02:00Z",
    },
    {
      id: "pool-7",
      kind: "question-pool",
      revision: 3,
      knowledgeVersion: 7,
      operationId: "operation-11",
      sessionId: "session-pool",
      status: "confirmed",
      sourceRefs: [{ kind: "knowledge-version", id: "7", revision: 7 }],
      usedBy: [],
      createdAt: "2026-08-15T00:01:00Z",
    },
  ],
};

describe("XiaojingBrandArchivePage", () => {
  beforeEach(() => mocks.load.mockReset());

  it("当前档案看板只投影最新版本事实，按语义 widget 分格", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    expect(mocks.load).toHaveBeenCalledWith("brand-17");
    const current = await screen.findByRole("region", { name: "当前档案" });
    expect(screen.getByRole("heading", { name: "品牌档案" })).toBeInTheDocument();
    expect(screen.getByText("当前品牌：鲸跃科技")).toBeInTheDocument();
    // Hero：品牌名 + 已确认状态 + tabular-nums 计数微标签。
    expect(within(current).getByRole("heading", { name: "鲸跃科技" })).toBeInTheDocument();
    expect(within(current).getByText(/已确认 · 知识版本 v7/)).toBeInTheDocument();
    expect(within(current).getByText(/FIELDS · 档案字段/)).toBeInTheDocument();

    // 语义 widget 分格：字段值是主角，数组值渲染为胶囊。
    const identity = within(current).getByRole("region", { name: "品牌身份" });
    expect(within(identity).getByText("品牌全称")).toBeInTheDocument();
    expect(within(identity).getByText("鲸跃科技（杭州）有限公司")).toBeInTheDocument();
    const products = within(current).getByRole("region", { name: "产品矩阵" });
    expect(within(products).getByText("GEO 监测")).toBeInTheDocument();
    expect(within(products).getByText("内容分发")).toBeInTheDocument();
    // 非 Profile 字段落入兜底格，factKey 回退原文。
    expect(within(current).getByRole("region", { name: "其他事实" })).toHaveTextContent("brand.name");

    // 历史版本的事实不混入当前档案（v6 独有的行业字段默认不可见）。
    expect(screen.queryByText("GEO 营销工具")).not.toBeInTheDocument();
  });

  it('已确认竞品在品牌档案中持久显示三元组，证据不泄露内部标记', async () => {
    const evidence = legacyCompetitorHeader('[{"name":"成实外教育","region":"成都","similarBusiness":"民办中学教育"},{"name":"为明教育","region":"成都","similarBusiness":"民办中学教育"}]', '成都民办中学联网竞品证据');
    mocks.load.mockResolvedValue({
      workspaceId: 'brand-17',
      knowledgeVersions: [{
        version: 8,
        actorSessionId: 'session-knowledge',
        createdAt: '2026-08-16T00:00:00Z',
        facts: [{
          factKey: JSON.stringify({
            subject: '鲸跃科技',
            predicate: 'enterprise-profile.competitors',
            scope: {},
            effectiveFrom: null,
            effectiveTo: null,
          }),
          factVersion: 1,
          normalizedValueJson: '["成实外教育","为明教育"]',
          sources: [{
            materialId: 'material-8',
            excerpt: evidence,
            origin: 'user-approved-material',
            createdAt: '2026-08-16T00:00:00Z',
          }],
        }],
        usedBy: [],
      }],
      artifacts: [],
    });

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    const current = await screen.findByRole('region', { name: '当前档案' });
    const competitive = within(current).getByRole('region', { name: '竞品与关联品牌' });
    expect(within(competitive).getByText('成实外教育｜成都｜民办中学教育')).toBeInTheDocument();
    expect(within(competitive).getByText('为明教育｜成都｜民办中学教育')).toBeInTheDocument();

    fireEvent.click(within(competitive).getByRole('button', { name: /证据 1/ }));
    expect(within(competitive).getByText(/成都民办中学联网竞品证据/)).toBeInTheDocument();
    expect(within(competitive).queryByText(/xiaojing-competitor-details/)).not.toBeInTheDocument();
  });

  it("来源证据默认不渲染，点击卡片角落入口显式展开", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    const current = await screen.findByRole("region", { name: "当前档案" });
    expect(screen.queryByText(/公司注册品牌为鲸跃科技/)).not.toBeInTheDocument();

    const other = within(current).getByRole("region", { name: "其他事实" });
    fireEvent.click(within(other).getByRole("button", { name: /证据 1/ }));

    expect(await within(other).findByText(/user-approved-material.*material-7.*公司注册品牌/)).toBeInTheDocument();
  });

  it("版本历史默认收起，每行给 diff 摘要，展开只看 diff 详情", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);
    await screen.findByRole("region", { name: "当前档案" });

    // 默认收起：diff 摘要不可见。
    expect(screen.queryByText("新增 2 · 移除 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /版本历史/ }));
    const ledger = screen.getByRole("region", { name: "版本历史" });

    // v7 vs v6：新增 fullname/products，移除 industry，brand.name 同值不进摘要。
    expect(within(ledger).getByText("新增 2 · 移除 1")).toBeInTheDocument();
    // v6 是首版：全部字段记为新增。
    expect(within(ledger).getByText("新增 2", { exact: true })).toBeInTheDocument();
    // diff 详情未展开前不重复字段内容。
    expect(screen.queryByText("GEO 营销工具")).not.toBeInTheDocument();

    fireEvent.click(within(ledger).getByRole("button", { name: /v7/ }));
    expect(await within(ledger).findByText("移除 行业")).toBeInTheDocument();
    expect(within(ledger).getByText("GEO 营销工具")).toBeInTheDocument();
    expect(within(ledger).getByText("新增 品牌全称")).toBeInTheDocument();
    expect(within(ledger).getByText("新增 核心产品")).toBeInTheDocument();
  });

  it("产物按七类分组为 widget，UUID/Operation/Session 收进技术详情折叠", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    const artifacts = await screen.findByRole("region", { name: "已批准产物" });
    const articles = within(artifacts).getByRole("region", { name: "已批准文章" });
    const pools = within(artifacts).getByRole("region", { name: "问题池" });

    // 组 widget：中文类型名 + 数量 + 最新状态与时间 + 简化血缘。
    expect(within(articles).getByText("最新 已批准")).toBeInTheDocument();
    expect(within(articles).getByText("基于知识 v7")).toBeInTheDocument();
    expect(within(pools).getByText("最新 已确认")).toBeInTheDocument();
    // 工程标识默认不可见。
    expect(screen.queryByText(/article-7-v2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/operation-17/)).not.toBeInTheDocument();

    fireEvent.click(within(articles).getByRole("button", { name: /全部 1 条/ }));
    fireEvent.click(within(articles).getByRole("button", { name: "技术详情" }));

    expect(await within(articles).findByText(/article-7-v2 · revision 2/)).toBeInTheDocument();
    expect(within(articles).getByText(/Operation operation-17 · Session session-article/)).toBeInTheDocument();
    expect(within(articles).getByText("topic-plan · topic-7 · revision 1")).toBeInTheDocument();
    expect(within(articles).getByText("distribution-plan · distribution-7 · revision 4")).toBeInTheDocument();
  });

  it("整页只读：除刷新/重试/展开折叠外无确认或动作入口", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);
    await screen.findByRole("region", { name: "当前档案" });

    for (const action of [/批准/, /确认/, /采纳/, /发布/, /拒绝/, /暂停/, /取消/]) {
      expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
  });

  it("reloads when the followed brand switches", async () => {
    mocks.load.mockResolvedValue({ workspaceId: "brand-17", knowledgeVersions: [], artifacts: [] });

    const { rerender } = render(<XiaojingBrandArchivePage workspace={workspace} />);
    await screen.findByText(/暂无已批准的知识或产物/);

    const other = { ...workspace, id: "brand-31", name: "海蓝品牌" };
    rerender(<XiaojingBrandArchivePage workspace={other} />);

    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("brand-31"));
    expect(screen.getByText("当前品牌：海蓝品牌")).toBeInTheDocument();
    expect(screen.queryByText("当前品牌：鲸跃科技")).not.toBeInTheDocument();
  });

  it("keeps empty and failure states usable", async () => {
    mocks.load
      .mockRejectedValueOnce(new Error("history temporarily unavailable"))
      .mockResolvedValueOnce({ workspaceId: "brand-17", knowledgeVersions: [], artifacts: [] });

    render(<XiaojingBrandArchivePage workspace={workspace} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("history temporarily unavailable");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/暂无已批准的知识或产物/)).toBeInTheDocument();
  });

  it("guides to brand selection when no workspace is active", () => {
    render(<XiaojingBrandArchivePage workspace={null} />);

    expect(screen.getByText(/先在左侧选择品牌/)).toBeInTheDocument();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "当前档案" })).not.toBeInTheDocument();
  });
});
