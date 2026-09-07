import { describe, expect, it } from "vitest";
import { GEO_STAGE_ORDER_GATED_TOOLS } from "../geo/stage-order-gate";
import {
  type StageToolFn,
  stageOrderGatedTool,
} from "./stage-order-gate-registration";

/**
 * 注册期 fail-loud（票 01，spec 2026-09-03）：派生集外的工具名经
 * stageOrderGatedTool 注册 → 构造期 throw——闸覆盖面是构造事实，误用
 * （拿只读查询/材料工具走闸缝）在 createXiaojingGeoServer 构造期早死，
 * 不等到运行时。纯单测直调，不起 server；fail-loud 分支根本走不到闸
 * 调用，无 managementApi 依赖。
 */
describe("stageOrderGatedTool registration guard", () => {
  /** 永不该被触达的 tool 替身：fail-loud 时 throw 在它之前，走到它即测试
   * 谎报（说明守卫失效、注册穿透到了 SDK tool()）。 */
  const neverTool = (() => {
    throw new Error("toolFn must not be reached when the guard fires");
  }) as unknown as StageToolFn;

  it("throws at registration time for a read-only tool outside the derived gate table", () => {
    expect(() =>
      stageOrderGatedTool(
        neverTool,
        {
          name: "inspect_geo_operations",
          description: "read-only query must not be gated",
          schema: {},
          handler: async () => ({ content: [] }),
        },
        () => ({ workspaceId: "brand-a", sessionId: "session-gate" }),
      ),
    ).toThrow(/outside the derived stage-order gate table/);
  });

  it("throws at registration time for a whitelisted guides tool (exempt by decision, not by this helper)", () => {
    expect(() =>
      stageOrderGatedTool(
        neverTool,
        {
          name: "request_brand_material",
          description: "whitelisted tools stay on the plain tool() seam",
          schema: {},
          handler: async () => ({ content: [] }),
        },
        () => ({ workspaceId: "brand-a", sessionId: "session-gate" }),
      ),
    ).toThrow(/outside the derived stage-order gate table/);
  });

  it("delegates a derived-set tool to the SDK tool function with the gate wrapped and alwaysLoad pinned", () => {
    const calls: unknown[][] = [];
    const definition = stageOrderGatedTool(
      ((...args: unknown[]) => {
        calls.push(args);
        return { sentinel: true };
      }) as unknown as StageToolFn,
      {
        name: "prepare_publish",
        description: "gated stage tool",
        schema: {},
        handler: async () => ({ content: [] }),
      },
      () => ({ workspaceId: "brand-a", sessionId: "session-gate" }),
    );
    // 注册形状钉：名字/描述/schema 原样透传给 SDK tool()，extras 固定
    // alwaysLoad（五处注册点的既有口径随上移收进助手）。
    expect(calls.length).toBe(1);
    const [name, description, schema, , extras] = calls[0] as unknown[];
    expect(name).toBe("prepare_publish");
    expect(description).toBe("gated stage tool");
    expect(schema).toEqual({});
    expect(extras).toEqual({ alwaysLoad: true });
    expect(GEO_STAGE_ORDER_GATED_TOOLS.includes("prepare_publish")).toBe(true);
    expect(definition).toEqual({ sentinel: true });
  });
});
