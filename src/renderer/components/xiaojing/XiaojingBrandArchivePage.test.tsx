import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import XiaojingBrandArchivePage from "./XiaojingBrandArchivePage";

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
      ],
      usedBy: [{ kind: "question-pool", id: "pool-7", revision: 3 }],
    },
    {
      version: 6,
      actorSessionId: "session-knowledge",
      createdAt: "2026-08-14T00:00:00Z",
      facts: [
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
  ],
};

describe("XiaojingBrandArchivePage", () => {
  beforeEach(() => mocks.load.mockReset());

  it("loads the current brand archive on mount and projects knowledge version history read-only", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    expect(mocks.load).toHaveBeenCalledWith("brand-17");
    const knowledge = await screen.findByRole("region", { name: "品牌知识版本" });
    expect(screen.getByRole("heading", { name: "品牌档案" })).toBeInTheDocument();
    expect(screen.getByText("当前品牌：鲸跃科技")).toBeInTheDocument();
    expect(within(knowledge).getByText("知识版本 v7")).toBeInTheDocument();
    expect(within(knowledge).getByText(/user-approved-material.*material-7.*公司注册品牌/)).toBeInTheDocument();
    expect(within(knowledge).getByText("question-pool · pool-7 · revision 3")).toBeInTheDocument();
  });

  it("projects approved artifact lineage without decision or action entries", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    const artifacts = await screen.findByRole("region", { name: "已批准产物" });
    expect(within(artifacts).getByText("已批准文章")).toBeInTheDocument();
    expect(within(artifacts).getByText("approved-article")).toBeInTheDocument();
    expect(within(artifacts).getByText("已批准")).toBeInTheDocument();
    expect(within(artifacts).getByText("article-7-v2 · revision 2")).toBeInTheDocument();
    expect(within(artifacts).getByText("topic-plan · topic-7 · revision 1")).toBeInTheDocument();
    expect(within(artifacts).getByText("distribution-plan · distribution-7 · revision 4")).toBeInTheDocument();

    // 只读整页：除读取类控件（刷新/重试）外不出现任何确认或动作入口。
    for (const action of [/批准/, /确认/, /采纳/, /发布/, /拒绝/, /暂停/, /取消/]) {
      expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
  });

  it("labels archive fields in Chinese and collapses historical knowledge versions by default", async () => {
    mocks.load.mockResolvedValue(history);

    render(<XiaojingBrandArchivePage workspace={workspace} />);

    const knowledge = await screen.findByRole("region", { name: "品牌知识版本" });
    // 档案字段复用 knowledgeCard.fields 中文词表；领域私有 factKey 回退原文。
    expect(within(knowledge).getByText("品牌全称")).toBeInTheDocument();
    expect(within(knowledge).getByText("鲸跃科技（杭州）有限公司")).toBeInTheDocument();
    expect(within(knowledge).getByText("brand.name")).toBeInTheDocument();
    // 概览磁贴统计最新版本的档案字段数。
    expect(screen.getByText("最新档案字段")).toBeInTheDocument();

    // 最新版本默认展开，历史版本收起为摘要行；点击后显式展开。
    expect(within(knowledge).queryByText("GEO 营销工具")).not.toBeInTheDocument();
    fireEvent.click(within(knowledge).getByRole("button", { name: /知识版本 v6/ }));
    expect(await within(knowledge).findByText("GEO 营销工具")).toBeInTheDocument();
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
    expect(screen.queryByRole("region", { name: "品牌知识版本" })).not.toBeInTheDocument();
  });
});
