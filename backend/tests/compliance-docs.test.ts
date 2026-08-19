import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { publishOrderPoints } from "../src/domain/publish-orders";
import { OPERATION_PRICES } from "../src/domain/pricing";

/**
 * 合规公示文件对表校验（票 11 验收项）：
 *  - 《计费标准》docs/compliance/计费标准.md 的固定价目表必须与
 *    src/domain/pricing.ts 的权威 OPERATION_PRICES 逐项一致（基础费 + 单价），
 *    且操作集合不缺不多，防止公示文件与服务端价目两处漂移；
 *  - 发布订单折算示例必须与 publishOrderPoints 的实现一致；
 *  - 《隐私政策》必须覆盖决策票 13 的全部要点（存储位置/本地数据/注销删除）；
 *  - 《用户协议（2026 年正式版）》必须入仓且为定稿（法务复核后正式版，
 *    不再携带修订记录；修订工作单的溯源见 git 历史）。
 *
 * 全部为本地文件读取 + 纯断言，不触网络（AGENTS.md 默认测试纪律）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readDoc = (name: string): string =>
  readFileSync(join(repoRoot, "docs", "compliance", name), "utf8");

const pricingDoc = readDoc("计费标准.md");
const privacyDoc = readDoc("隐私政策.md");
const agreementDoc = readDoc("用户协议（2026年正式版）.md");

/** 解析《计费标准》固定价目表：行形如 `| 名称 | op_key | base | perUnit | ... |`。 */
function parsePublishedPrices(
  doc: string,
): Map<string, { base: number; perUnit: number }> {
  const rows = new Map<string, { base: number; perUnit: number }>();
  for (const line of doc.split("\n")) {
    const match = /^\|[^|]+\|\s*([a-z_]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(
      line,
    );
    if (match) {
      const [, key, base, perUnit] = match;
      if (rows.has(key)) throw new Error(`价目表出现重复操作行：${key}`);
      rows.set(key, { base: Number(base), perUnit: Number(perUnit) });
    }
  }
  return rows;
}

describe("《计费标准》与网关服务端价目对表（票 11 验收项 2）", () => {
  it("固定价目表逐项与 OPERATION_PRICES 一致（基础费与单价）", () => {
    const published = parsePublishedPrices(pricingDoc);
    expect(published.size).toBeGreaterThan(0);
    for (const [operation, authoritative] of Object.entries(OPERATION_PRICES)) {
      expect(
        published.get(operation),
        `公示表缺少操作 ${operation}`,
      ).toBeDefined();
      expect(published.get(operation)).toEqual(authoritative);
    }
  });

  it("操作集合不缺不多：公示表键集合与 OPERATION_PRICES 完全相等", () => {
    const published = parsePublishedPrices(pricingDoc);
    expect([...published.keys()].sort()).toEqual(
      Object.keys(OPERATION_PRICES).sort(),
    );
  });

  it("点数锚点、充值档位与赠送口径与规格一致（票 07 结算细则）", () => {
    expect(pricingDoc).toContain("1 元人民币 = 10 点");
    expect(pricingDoc).toContain("¥1000 / ¥2000 / ¥5000");
    expect(pricingDoc).toContain("赠送 500 点");
    // 与 config.ts 默认 SIGNUP_GRANT_POINTS=500 对应；该值 env 可调，
    // 调整时需同步公示文件（pricing.ts 头注释的调价纪律同样适用）。
  });

  it("发布订单折算示例与 publishOrderPoints 实现一致（含 60% 服务费、向上取整）", () => {
    expect(publishOrderPoints(88_00)).toBe(1408);
    expect(publishOrderPoints(12_34)).toBe(198);
    expect(pricingDoc).toContain("¥88.00 → 1408 点");
    expect(pricingDoc).toContain("¥12.34 → 198 点");
    expect(pricingDoc).toContain("60% 服务费");
    expect(pricingDoc).toContain("向上取整");
  });
});

describe("《隐私政策》覆盖决策票 13 全部要点（票 11 验收项 3）", () => {
  // 决策票 13 修订项 6：手机号/操作流水/点数账本存运营服务器（成都）。
  it("声明手机号、操作流水、点数账本存储于运营服务器（成都）", () => {
    expect(privacyDoc).toContain("手机号");
    expect(privacyDoc).toContain("操作流水");
    expect(privacyDoc).toContain("点数账本");
    expect(privacyDoc).toContain("运营服务器");
    expect(privacyDoc).toContain("成都");
  });

  // 决策票 13：品牌资料/文章/会话仅存本机，运营不接触。
  it("声明品牌资料、文章、会话数据仅存本机", () => {
    expect(privacyDoc).toContain("本机");
    expect(privacyDoc).toContain("品牌资料");
    expect(privacyDoc).toContain("文章");
    expect(privacyDoc).toContain("会话");
    expect(privacyDoc).toMatch(/不上传运营服务器/);
  });

  // 决策票 13：注销账号删除服务器侧数据；本地数据由用户自行删除。
  it("声明注销账号时删除服务器侧数据", () => {
    expect(privacyDoc).toContain("注销账号");
    expect(privacyDoc).toContain("删除服务器侧");
    expect(privacyDoc).toMatch(/由您自行删除/);
  });
});

describe("《用户协议（2026 年正式版）》入仓与定稿（票 11 验收项 4；法务复核后正式定稿）", () => {
  it("为正式版定稿：标记正式版且不再携带任何修订记录/草稿标注", () => {
    expect(agreementDoc).toContain("2026 年·正式版");
    expect(agreementDoc).toContain("经法务复核");
    expect(agreementDoc).not.toContain("修订记录");
    expect(agreementDoc).not.toContain("本条为修订");
    expect(agreementDoc).not.toContain("本条为新增");
    // 修订溯源移交 git 历史（定稿前的修订工作单版本见仓库历史），正文不再展示。
  });

  it("正文关键条款表述到位（无有效期/退款/多设备）", () => {
    expect(agreementDoc).toContain("不设有效期");
    expect(agreementDoc).toContain("未消耗的点数余额可向甲方申请退款");
    expect(agreementDoc).toContain("同一账号可在多台设备登录使用");
  });
});
