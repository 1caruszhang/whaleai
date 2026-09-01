import { describe, expect, it } from "vitest";
import {
  declaredServiceScope,
  deriveCompetitorScope,
  deriveServiceScope,
  firstProfileValue,
  projectBrandProfile,
  profileValues,
  renderBrandIdentityBlock,
  renderFullProfileBlock,
  renderMiningProfileBlock,
  resolveBrandName,
  targetRegionScopeViolation,
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

describe("resolveBrandName（用户拍板 2026-08-19：知识库身份事实优先，workspace 名仅兜底）", () => {
  it("fullName 与 shortNames 同存时取 fullName（炊班长事故回归）", () => {
    const profile = projectBrandProfile([
      fact("brand.fullName", "广州造卤先生餐饮管理有限公司"),
      fact("brand.shortNames", ["造卤先生", "炊班主"]),
    ]);
    expect(resolveBrandName(profile, "炊班长")).toBe(
      "广州造卤先生餐饮管理有限公司",
    );
  });

  it("fullName 缺失时回退 shortNames[0]，仍不用 workspace 名", () => {
    const profile = projectBrandProfile([
      fact("brand.shortNames", ["造卤先生", "炊班主"]),
    ]);
    expect(resolveBrandName(profile, "炊班长")).toBe("造卤先生");
  });

  it("知识库无任何身份事实时才用 workspace 名兜底", () => {
    expect(resolveBrandName({}, "炊班长")).toBe("炊班长");
    const profile = projectBrandProfile([
      fact("brand.industry", "餐饮"),
      fact("brand.products", ["卤味"]),
    ]);
    expect(resolveBrandName(profile, "炊班长")).toBe("炊班长");
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

describe("declaredServiceScope（票 #31：声明口径单独派生，地址兜底不参与）", () => {
  it("returns the declared serviceArea scope without any address fallback", () => {
    expect(
      declaredServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "新都区")]),
      ),
    ).toEqual({ primary: "新都区", allowed: ["新都区"] });
  });

  it("returns undefined when serviceArea is absent even if addresses exist", () => {
    expect(
      declaredServiceScope(
        projectBrandProfile([
          fact("brand.addresses", ["四川省成都市龙泉驿区某街道1号"]),
        ]),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for boundless and unparseable declarations", () => {
    expect(
      declaredServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "全国，支持线上交付")]),
      ),
    ).toBeUndefined();
    expect(
      declaredServiceScope(
        projectBrandProfile([fact("brand.serviceArea", "广东省")]),
      ),
    ).toBeUndefined();
  });
});

describe("targetRegionScopeViolation（票 #31 / ADR-0011：声明口径存在时越界 fail-loud）", () => {
  it("flags boundless values like 全国 when a usable scope is declared", () => {
    const violation = targetRegionScopeViolation(
      projectBrandProfile([fact("brand.serviceArea", "成都")]),
      "全国",
    );
    expect(violation).toContain("服务区域为成都");
    expect(violation).toContain("请以成都为目标地域");
  });

  it("flags regions outside the declared whitelist", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都、德阳")]),
        "绵阳",
      ),
    ).toContain("成都、德阳");
  });

  it("flags upgrades beyond the declared granularity (新都区 → 成都)", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "新都区")]),
        "成都",
      ),
    ).toContain("新都区");
  });

  it("flags province names covering a city-level declaration", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "四川",
      ),
    ).toContain("成都");
  });

  it("redirects narrowing back to the declared scope (无归属数据，口径唯一)", () => {
    // 声明「成都」而传「新都区」：收窄不是越界，但代码无行政区归属数据
    // 判包含，声明口径是唯一入参口径——重定向而非放行。
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "成都市新都区",
      ),
    ).toContain("成都");
  });

  it("passes 和/与-joined names inside the declared whitelist (连接词兜底)", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都、绵阳")]),
        "成都和绵阳",
      ),
    ).toBeUndefined();
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都、绵阳")]),
        "成都与德阳",
      ),
    ).toContain("成都、绵阳");
  });

  it("does not mis-split names that contain 和 (和田 regression)", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "和田")]),
        "和田",
      ),
    ).toBeUndefined();
  });

  it("flags regions that normalize to nothing recognizable", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "西南地区",
      ),
    ).toContain("成都");
  });

  it("passes suffix/prefix variants of the declared segments", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "成都市",
      ),
    ).toBeUndefined();
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都市新都区")]),
        "新都区",
      ),
    ).toBeUndefined();
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "四川省成都市",
      ),
    ).toBeUndefined();
  });

  it("passes subsets of a multi-segment declaration", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都、德阳")]),
        "德阳",
      ),
    ).toBeUndefined();
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都、德阳")]),
        "德阳、成都市",
      ),
    ).toBeUndefined();
  });

  it("does not intercept when no usable declaration exists (口径缺失不拦截)", () => {
    // 无 serviceArea：地址兜底不是声明口径，targetRegion 再远也不拦。
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([
          fact("brand.addresses", ["四川省成都市某街道1号"]),
        ]),
        "北京",
      ),
    ).toBeUndefined();
    // 无界声明 = 无地缘模式，全国照放。
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "全国，支持线上交付")]),
        "全国",
      ),
    ).toBeUndefined();
    // 省级声明没有城市段白名单，不做拦截（宁松勿拦）。
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "广东省")]),
        "全国",
      ),
    ).toBeUndefined();
  });

  it("passes prose naming the declared city (cleans down to the in-scope segment)", () => {
    expect(
      targetRegionScopeViolation(
        projectBrandProfile([fact("brand.serviceArea", "成都")]),
        "成都本地，辐射西南地区",
      ),
    ).toBeUndefined();
  });
});

describe("deriveCompetitorScope（ADR-0007：声明什么粒度锚什么粒度）", () => {
  it("city-level declarations keep the whitelist granularity (gate-able)", () => {
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "成都新都")]),
      ),
    ).toEqual({ primary: "成都新都", allowed: ["成都新都"], granularity: "city" });
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "四川省成都市")]),
      ),
    ).toEqual({ primary: "成都", allowed: ["成都"], granularity: "city" });
  });

  it("bare province declarations anchor at province granularity without a city whitelist", () => {
    // 炊班主事故回归：省级服务区域不再被判「无锚」整轮跳过。
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "广东省")]),
      ),
    ).toEqual({ primary: "广东", allowed: [], granularity: "province" });
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "广东")]),
      ),
    ).toEqual({ primary: "广东", allowed: [], granularity: "province" });
  });

  it("normalizes autonomous-region long names to short anchors", () => {
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "广西壮族自治区")]),
      ),
    ).toEqual({ primary: "广西", allowed: [], granularity: "province" });
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "新疆维吾尔自治区")]),
      ),
    ).toEqual({ primary: "新疆", allowed: [], granularity: "province" });
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "内蒙古自治区")]),
      ),
    ).toEqual({ primary: "内蒙古", allowed: [], granularity: "province" });
  });

  it("mixed province+city declarations resolve to the lenient province scope", () => {
    // 含省段即按省级宽口径：无代码地域闸，过界候选由确认卡删除兜底。
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "广东省、长沙市")]),
      ),
    ).toEqual({ primary: "广东", allowed: [], granularity: "province" });
  });

  it("non-administrative economic regions flow through the city path as anchors", () => {
    // 珠三角无行政区后缀，走城市清洗路径成锚（查询可用），不做展开映射。
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "珠三角")]),
      ),
    ).toEqual({ primary: "珠三角", allowed: ["珠三角"], granularity: "city" });
  });

  it("keeps boundless and macro-region declarations anchor-free", () => {
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "全国，支持线上交付")]),
      ),
    ).toBeUndefined();
    expect(
      deriveCompetitorScope(
        projectBrandProfile([fact("brand.serviceArea", "华南地区")]),
      ),
    ).toBeUndefined();
  });

  it("falls back to the address city at city granularity", () => {
    expect(
      deriveCompetitorScope(
        projectBrandProfile([
          fact("brand.addresses", ["四川省成都市龙泉驿区大面街道某城F区12号"]),
        ]),
      ),
    ).toEqual({ primary: "成都", allowed: ["成都"], granularity: "city" });
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
