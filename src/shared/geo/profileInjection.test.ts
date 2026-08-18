import { describe, expect, it } from "vitest";
import {
  deriveServiceScope,
  firstProfileValue,
  projectBrandProfile,
  profileValues,
  renderBrandIdentityBlock,
  renderFullProfileBlock,
  renderMiningProfileBlock,
  type BrandProfileFact,
} from "./profileInjection";

function fact(predicate: string, value: unknown): BrandProfileFact {
  return { predicate, normalizedValueJson: JSON.stringify(value) };
}

describe("projectBrandProfile", () => {
  it("projects brand.<field> facts across the 15-field profile", () => {
    const profile = projectBrandProfile([
      fact("brand.fullName", "锦江区鲸鱼汽车音响经营部"),
      fact("brand.shortNames", ["鲸鱼音响", "鲸鱼改声"]),
      fact("brand.competitors", ["甲店", "乙店"]),
      fact("brand.products", "汽车音响改装"),
      fact("brand.serviceArea", "成都市锦江区"),
    ]);
    expect(profileValues(profile, "fullName")).toEqual([
      "锦江区鲸鱼汽车音响经营部",
    ]);
    expect(profileValues(profile, "shortNames")).toEqual([
      "鲸鱼音响",
      "鲸鱼改声",
    ]);
    expect(firstProfileValue(profile, "serviceArea")).toBe("成都市锦江区");
    expect(profileValues(profile, "coreAdvantages")).toEqual([]);
  });

  it("ignores unrelated predicates, non-string values, and deduplicates", () => {
    const profile = projectBrandProfile([
      fact("brand.coreAdvantages", "原厂配件"),
      fact("brand.coreAdvantages", "原厂配件"),
      fact("brand.coreAdvantagesX", "noise"),
      fact("material.title", "noise"),
      fact("brand.contactInfo", { phone: "028-0000000" }),
    ]);
    expect(profileValues(profile, "coreAdvantages")).toEqual(["原厂配件"]);
    expect(profileValues(profile, "contactInfo")).toEqual([]);
  });

  it("projects stored lowercase predicates (identity 归一化契约) across camelCase fields", () => {
    // rui 事故回归：入库 predicate 全小写（enterprise-profile.fullname），
    // camelCase 字段必须照样命中，否则品牌身份回退到 workspace 名。
    const profile = projectBrandProfile([
      fact("enterprise-profile.fullname", "成都市鼎锋行乐音改汽车用品有限公司"),
      fact("enterprise-profile.shortnames", ["行乐音改"]),
      fact("enterprise-profile.servicearea", "成都本地"),
      fact("enterprise-profile.coreadvantages", ["无损改装工艺"]),
    ]);
    expect(firstProfileValue(profile, "fullName")).toBe(
      "成都市鼎锋行乐音改汽车用品有限公司",
    );
    expect(profileValues(profile, "shortNames")).toEqual(["行乐音改"]);
    expect(firstProfileValue(profile, "serviceArea")).toBe("成都本地");
    expect(profileValues(profile, "coreAdvantages")).toEqual(["无损改装工艺"]);
  });
});

describe("renderMiningProfileBlock", () => {
  it("renders business signals without any brand-name field", () => {
    const block = renderMiningProfileBlock(
      projectBrandProfile([
        fact("brand.fullName", "鲸鱼音响"),
        fact("brand.products", "汽车音响改装；隔音降噪"),
        fact("brand.coreAdvantages", "师傅10年以上经验"),
        fact("brand.customerCases", "服务过宝马3系车主"),
      ]),
    );
    expect(block).toContain("核心服务（主参考");
    expect(block).toContain("汽车音响改装；隔音降噪");
    expect(block).toContain("核心优势（主参考");
    expect(block).toContain("客户案例（辅参考");
    expect(block).not.toContain("鲸鱼音响");
    expect(block).toContain("不得出现品牌名");
  });

  it("returns empty string when no business signals exist", () => {
    expect(
      renderMiningProfileBlock(
        projectBrandProfile([fact("brand.fullName", "鲸鱼音响")]),
      ),
    ).toBe("");
  });
});

describe("renderFullProfileBlock", () => {
  it("renders all confirmed fields with Chinese labels, omitting missing ones", () => {
    const block = renderFullProfileBlock(
      projectBrandProfile([
        fact("brand.fullName", "鲸鱼音响"),
        fact("brand.industry", "汽车音响改装"),
        fact("brand.derivedKeywords", ["成都 改音响", "锦江 隔音"]),
      ]),
    );
    expect(block).toContain("## 品牌档案（已确认字段）");
    expect(block).toContain("- 品牌全称：鲸鱼音响");
    expect(block).toContain("- 行业：汽车音响改装");
    expect(block).toContain("- 衍生关键词：成都 改音响；锦江 隔音");
    expect(block).not.toContain("核心优势");
  });
});

describe("deriveServiceScope（ADR-0006 修正四：声明服务范围 = 锚 + 上限）", () => {
  it("declared district scope wins over store-address city, granularity kept", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([
          fact("brand.addresses", ["四川省成都市新都区某街道88号"]),
          fact("brand.serviceArea", "新都区"),
        ]),
      ),
    ).toEqual({ primary: "新都区", allowed: ["新都区"] });
  });

  it("keeps the district when the declaration carries a city prefix", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "成都市新都区")]),
      ),
    ).toEqual({ primary: "新都区", allowed: ["新都区"] });
  });

  it("collects every declared segment into the allowed whitelist", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "成都、德阳")]),
      ),
    ).toEqual({ primary: "成都", allowed: ["成都", "德阳"] });
  });

  it("cleans a prose serviceArea down to the city segment", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "成都本地，辐射西南地区")]),
      ),
    ).toEqual({ primary: "成都", allowed: ["成都"] });
  });

  it("falls back to the address city when no usable scope is declared", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([
          fact("brand.addresses", ["四川省成都市龙泉驿区大面街道某城F区12号"]),
        ]),
      ),
    ).toEqual({ primary: "成都", allowed: ["成都"] });
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "西南地区均可服务")]),
      ),
    ).toBeUndefined();
  });

  it("boundless declarations force geo-free mode without address fallback", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([
          fact("brand.addresses", ["北京市海淀区某大厦8层"]),
          fact("brand.serviceArea", "全国，支持线上交付"),
        ]),
      ),
    ).toBeUndefined();
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "线上线下")]),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for absent geo signals", () => {
    expect(
      deriveServiceScope(
        projectBrandProfile([fact("brand.industry", "MES系统")]),
      ),
    ).toBeUndefined();
  });
});

describe("renderBrandIdentityBlock", () => {
  it("renders entity-layer identity with the bold/short-name rule", () => {
    const block = renderBrandIdentityBlock(
      projectBrandProfile([
        fact("brand.fullName", "锦江区鲸鱼汽车音响经营部"),
        fact("brand.shortNames", ["鲸鱼音响"]),
        fact("brand.serviceArea", "成都市锦江区"),
        fact("brand.industry", "汽车音响改装"),
        fact("brand.products", "汽车音响改装"),
      ]),
    );
    expect(block).toContain("必须原样使用，不得转述或改写");
    expect(block).toContain("- 品牌全称：锦江区鲸鱼汽车音响经营部");
    expect(block).toContain("- 品牌简称：鲸鱼音响");
    expect(block).toContain("不得自造简称");
    expect(block).not.toContain("产品与服务");
  });
});
