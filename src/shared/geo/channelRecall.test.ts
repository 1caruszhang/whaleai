import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREFERENCE_CHANNELS,
  accountKeyFromUrl,
  accountNameFromTitle,
  accountNameMatchesChannel,
  activeNameMatchScore,
  buildGlobalRecallPrompt,
  buildPoolDomainNameMap,
  buildQualifierSuffixes,
  channelNameCore,
  cleanResourceDomains,
  channelNameCoreAll,
  citationPlatformFamily,
  clampTopicNumbers,
  domainToBrand,
  fuzzyMatchScore,
  isJunkResaleListing,
  isMultiTenantPlatformUrl,
  normalizeChannelName,
  packKeyOf,
  parseGlobalRecallResult,
  platformOfficialFamily,
  preferenceEntryMatches,
  primaryPlatformFamily,
  registeredDomain,
  resolvePreferenceChannels,
  resourcePlatformFamilies,
  siteNameFromTitleSuffix,
  strictMatchScore,
  variantFamilyKey,
} from "./channelRecall";

describe("channel recall ported from js_ai", () => {
  it("reduces URLs to registered domains", () => {
    expect(registeredDomain("https://auto.sohu.com/page/1")).toBe("sohu.com");
    expect(registeredDomain("https://www.news.example.com.cn/a")).toBe(
      "example.com.cn",
    );
    // 两段公共后缀全类取倒数三段（竞词语料封顶与渠道召回共用此清单，
    // edu.cn/co.uk 类不得坍缩成公共后缀本身）。
    expect(registeredDomain("https://www.pku.edu.cn/admissions")).toBe(
      "pku.edu.cn",
    );
    expect(registeredDomain("https://bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(registeredDomain("not a url")).toBeNull();
  });

  it("keeps strict matching tighter than fuzzy matching", () => {
    const source = { title: "搜狐健康", url: "https://health.sohu.com" };
    expect(strictMatchScore(source, "搜狐健康频道")).toBe(1.0);
    expect(strictMatchScore(source, "毫不相关名字")).toBe(0);
    // 品牌家族 + 渠道字重叠走模糊分（≥0.4 疑似命中），严格分不放行。
    expect(fuzzyMatchScore(source, "搜狐网健康（GEO）")).toBeGreaterThan(0.4);
    expect(strictMatchScore(source, "毫不相关名字")).toBe(0);
  });

  it("exempts portal domains hosting self-media accounts as multi-tenant platforms", () => {
    // 搜狐号/网易号/企鹅号(公众号)/凤凰号内容分别挂在门户注册域名
    // sohu.com/163.com/qq.com/ifeng.com 下，域名相等同样不构成渠道证据。
    expect(
      isMultiTenantPlatformUrl("https://www.sohu.com/a/860745823_121124921"),
    ).toBe(true);
    expect(
      isMultiTenantPlatformUrl("https://m.sohu.com/a/860745823_121124921"),
    ).toBe(true);
    expect(
      isMultiTenantPlatformUrl("https://www.163.com/dy/article/HQEQKFSM.html"),
    ).toBe(true);
    expect(
      isMultiTenantPlatformUrl("https://news.qq.com/rain/a/202608A0.html"),
    ).toBe(true);
    expect(isMultiTenantPlatformUrl("https://news.ifeng.com/c/8RwZa7k")).toBe(
      true,
    );
    // 公众号文章页随 qq.com 后缀一并覆盖。
    expect(isMultiTenantPlatformUrl("https://mp.weixin.qq.com/s/abc123")).toBe(
      true,
    );
    // 自有域名媒体站与后缀边界外的主机不豁免。
    expect(isMultiTenantPlatformUrl("https://www.redchinaweb.cn")).toBe(false);
    expect(isMultiTenantPlatformUrl("https://sohu.example.com")).toBe(false);
  });

  it("extracts channel core names by stripping platform qualifier suffixes", () => {
    expect(channelNameCore("济南时报（官方头条号）")).toBe("济南时报");
    expect(channelNameCore("蓝色河畔（今日头条）（GEO）")).toBe("蓝色河畔");
    expect(channelNameCore("无后缀渠道")).toBe("无后缀渠道");
  });

  it("does not treat platform-brand qualifiers as channel evidence for multi-tenant sources", () => {
    // toutiao.com 来源 → 品牌「今日头条」；限定后缀里的品牌不算渠道身份，
    // 平台品牌兜底 0.5 分关闭——同名不同号的账号不再误挂。
    const source = {
      title: "今日头条美食垂类频道",
      url: "https://www.toutiao.com/channel/food",
    };
    expect(
      fuzzyMatchScore(source, "白城融媒（今日头条）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0);
    expect(
      fuzzyMatchScore(source, "今日头条生活（GEO）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0);
    // 渠道字面重叠仍在（美食频道家族）。
    expect(
      fuzzyMatchScore(source, "今日头条美食（GEO）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0.8);
    // 默认（偏好路用户手输）保留品牌家族兜底语义。
    expect(fuzzyMatchScore(source, "白城融媒（今日头条）")).toBe(0.5);
  });

  it("does not treat platform-brand qualifiers as channel evidence for sohu/163 sources", () => {
    // sohu.com/163.com 来源 → 品牌「搜狐/网易」；搜狐号/网易号资源的限定后缀
    // 不算渠道身份，平台品牌兜底 0.5 分同样关闭——同名不同号不误挂。
    const sohu = {
      title: "搜狐美食垂类精选",
      url: "https://www.sohu.com/a/860745823_121124921",
    };
    expect(
      fuzzyMatchScore(sohu, "白城融媒（搜狐号）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0);
    // 默认（偏好路用户手输）保留品牌家族兜底语义。
    expect(fuzzyMatchScore(sohu, "白城融媒（搜狐号）")).toBe(0.5);
    const netease = {
      title: "网易号生活精选",
      url: "https://www.163.com/dy/article/HQEQKFSM.html",
    };
    expect(
      fuzzyMatchScore(netease, "南郡新闻（网易号）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0);
    expect(fuzzyMatchScore(netease, "南郡新闻（网易号）")).toBe(0.5);
  });

  it("resolves the preference list as (defaults − excluded) + additions", () => {
    const resolved = resolvePreferenceChannels({
      excludedPreferenceChannels: ["蓝色河畔（GEO排名）"],
      additionalPreferenceChannels: [
        { name: "用户手输渠道", domain: "custom.example.com" },
      ],
    });
    const names = resolved.map((entry) => entry.name);
    expect(names).not.toContain("蓝色河畔（GEO排名）");
    // 2026-08-27 用户裁决：内置名单恢复 js_ai 原始十项（用户预置名单），
    // 其中未在候选快照里出现的名字由下次计划运行的偏好路逐名验证。
    expect(names).toContain("济南时报（官方头条号）");
    expect(names).toContain("咸阳新闻网（GEO排名）");
    expect(names).toContain("咸宁网主站");
    expect(names).toHaveLength(10);
    expect(names).toContain("用户手输渠道");
    // 全角/半角括号归一后精确相等。
    expect(
      preferenceEntryMatches(
        { name: "南郡新闻(官方头条号)", exact: true },
        { name: "南郡新闻（官方头条号）", entranceLink: null },
      ),
    ).toBe(true);
    // 2026-08-28 用户裁决：exact=核心名相等（两侧剥（）/【】尾块归一）——
    // 同核心变体（转售商后缀漂移）在 exact 下命中；不同核心名不命中。
    expect(
      preferenceEntryMatches(
        { name: "南郡新闻（官方头条号）", exact: true },
        { name: "南郡新闻（geo优化）", entranceLink: null },
      ),
    ).toBe(true);
    expect(
      preferenceEntryMatches(
        { name: "济南时报（官方头条号）", exact: true },
        { name: "南郡新闻（geo优化）", entranceLink: null },
      ),
    ).toBe(false);
    // 用户手输条目走严格→模糊容错。
    expect(
      preferenceEntryMatches(
        { name: "南郡新闻" },
        { name: "南郡新闻（geo优化）", entranceLink: null },
      ),
    ).toBe(true);
    // 域名优先。
    expect(
      preferenceEntryMatches(
        { name: "随便叫什么", domain: "https://auto.sohu.com" },
        { name: "搜狐汽车", entranceLink: "https://car.sohu.com" },
      ),
    ).toBe(true);
  });

  it("ships the same built-in preference baseline as js_ai", () => {
    expect(DEFAULT_PREFERENCE_CHANNELS).toHaveLength(10);
    expect(
      DEFAULT_PREFERENCE_CHANNELS.every((entry) => entry.exact === true),
    ).toBe(true);
    expect(normalizeChannelName("南郡新闻（官方头条号）")).toBe(
      normalizeChannelName("南郡新闻(官方头条号)"),
    );
  });

  it("parses global recall output with the registered-domain gate", () => {
    const channels = parseGlobalRecallResult(
      '```json\n[{"name":"搜狐汽车","url":"https://auto.sohu.com","reason":"汽车垂直媒体","topicNumbers":[1,99,0,1.5]},{"name":"无URL渠道","topicNumbers":[1]},{"name":"坏域名","url":"http://localhost/x"}]\n```',
    );
    expect(channels).toEqual([
      {
        name: "搜狐汽车",
        url: "https://auto.sohu.com",
        // 推荐理由随解析保留（原始回答关键信息，面板展示用）。
        reason: "汽车垂直媒体",
        // 解析层只做类型收敛（去 0 与非整数）；越界编号由 clamp 层处理。
        topicNumbers: [1, 99],
      },
    ]);
    expect(clampTopicNumbers([1, 2, 99], 2)).toEqual([1, 2]);
  });

  it("builds the numbered-topic global recall prompt", () => {
    const prompt = buildGlobalRecallPrompt({
      topics: ["新能源车售后", "新能源车售后", "门店服务指南"],
      industry: "汽车改装",
      derivedKeywords: ["汽车音响"],
    });
    expect(prompt).toContain("[1]新能源车售后 [2]门店服务指南");
    expect(prompt).toContain("行业：汽车改装");
    expect(prompt).toContain("衍生关键词：汽车音响");
    expect(prompt).toContain("严禁编造或臆测任何 URL");
  });
});

describe("account-level alignment helpers (2026-08-27 三层解析)", () => {
  it("extracts L1 account ids from sohu/sina/baijiahao/toutiao url structures", () => {
    expect(
      accountKeyFromUrl("https://m.sohu.com/a/1065822220_122878478/"),
    ).toEqual({ platform: "搜狐", accountId: "122878478" });
    expect(
      accountKeyFromUrl(
        "https://k.sina.com.cn/article_7868592001_1d5012f8100101bxc4.html",
      ),
    ).toEqual({ platform: "新浪", accountId: "7868592001" });
    expect(
      accountKeyFromUrl(
        "https://baijiahao.baidu.com/u?app_id=1737204978593473",
      ),
    ).toEqual({ platform: "百家号", accountId: "1737204978593473" });
    expect(
      accountKeyFromUrl("https://www.toutiao.com/c/user/token/MS4wLjABAAA/"),
    ).toEqual({ platform: "今日头条", accountId: "MS4wLjABAAA" });
    // 文章页 URL 不含账号标识 → null（抖音/头条引用的常态，走 L2/L3）。
    expect(accountKeyFromUrl("http://m.toutiao.com/group/7678507985/")).toBeNull();
    expect(accountKeyFromUrl("https://www.iesdouyin.com/share/video/7675/")).toBeNull();
  });

  it("maps multi-tenant urls and resource names to platform families", () => {
    expect(citationPlatformFamily("https://m.toutiao.com/group/1/")).toBe(
      "今日头条",
    );
    expect(citationPlatformFamily("https://www.iesdouyin.com/share/video/1")).toBe(
      "抖音",
    );
    expect(citationPlatformFamily("https://auto.example.com/a")).toBeNull();
    // 资源侧：名称括号别名（头条号/搜狐号）+ entranceLink 域名都计入。
    expect(
      resourcePlatformFamilies({
        name: "蓝色河畔（官方头条号）",
        entranceLink: "https://www.toutiao.com/item/1/",
      }),
    ).toEqual(new Set(["今日头条"]));
    expect(
      resourcePlatformFamilies({
        name: "济南时报（搜狐号）",
        entranceLink: null,
      }),
    ).toEqual(new Set(["搜狐"]));
  });

  it("gates L2 account-name matches by platform family", () => {
    const resourceName = "绿康膳食（今日头条）";
    const families = resourcePlatformFamilies({
      name: resourceName,
      entranceLink: "https://www.toutiao.com/item/1/",
    });
    expect(
      accountNameMatchesChannel({
        accountName: "绿康膳食1",
        citationPlatform: "今日头条",
        resourceName,
        resourceFamilies: families,
      }),
    ).toBe(true);
    // 跨平台同名：搜狐引用上的「绿康膳食1」不能挂到头条号渠道。
    expect(
      accountNameMatchesChannel({
        accountName: "绿康膳食1",
        citationPlatform: "搜狐",
        resourceName,
        resourceFamilies: families,
      }),
    ).toBe(false);
    // 平台族解析失败（非多租户域名）不构成账户级证据。
    expect(
      accountNameMatchesChannel({
        accountName: "绿康膳食1",
        citationPlatform: null,
        resourceName,
        resourceFamilies: families,
      }),
    ).toBe(false);
  });

  it("extracts account names from title suffixes and site names from dash suffixes", () => {
    expect(accountNameFromTitle("绿康膳食食堂承包收费模式是怎样的_绿康膳食1")).toBe(
      "绿康膳食1",
    );
    expect(accountNameFromTitle("引用 12345")).toBeNull();
    expect(
      siteNameFromTitleSuffix("2026年正规的餐饮承包公司推荐 - 八方资源网"),
    ).toBe("八方资源网");
    expect(siteNameFromTitleSuffix("无尾缀标题")).toBeNull();
    // sohu 栏目式尾缀（_小吃）也是合法账号名候选——真伪由平台门裁决。
    expect(accountNameFromTitle("夜市新风口观察_小吃")).toBe("小吃");
  });

  it("builds the pool domain-name map excluding multi-tenant and conflicting domains", () => {
    const map = buildPoolDomainNameMap([
      { name: "八方资源网", entranceLink: "https://mip.b2b168.com/wvs1.html" },
      // 同域同核心名：幂等。
      { name: "八方资源网（B2B）", entranceLink: "https://www.b2b168.com/" },
      // 多租户域名：一域名多渠道，不进映射。
      { name: "搜狐网美食", entranceLink: "https://www.sohu.com/" },
      // 同域核心名冲突：宁缺毋滥。
      { name: "渠道甲", entranceLink: "https://example.net/a" },
      { name: "渠道乙", entranceLink: "https://example.net/b" },
    ]);
    expect(map.get("b2b168.com")).toBe("八方资源网");
    expect(map.has("sohu.com")).toBe(false);
    expect(map.has("example.net")).toBe(false);
  });
});

describe("multi-tenant name matching all-branch core scoping + fixes (2026-08-28 用户裁决)", () => {
  it("platform-word suffix never counts as name evidence for multi-tenant sources", () => {
    const toutiaoUrl = "https://www.toutiao.com/";
    // 旧实现子串分支吃后缀：1.0 伪命中（实测复现）。
    expect(
      fuzzyMatchScore({ title: "今日头条", url: toutiaoUrl }, "泾川融媒（今日头条）", {
        multiTenantPlatform: true,
      }),
    ).toBe(0);
    // 旧实现去后缀 Jaccard 吃后缀字符：0.4 恰好过线（实测复现）。
    expect(
      fuzzyMatchScore(
        { title: "今日头条美食频道", url: "https://www.toutiao.com/channel/food" },
        "泾川融媒（今日头条）",
        { multiTenantPlatform: true },
      ),
    ).toBe(0);
    // 核心名本身含品牌的官方型资源仍正常命中。
    expect(
      fuzzyMatchScore(
        { title: "今日头条美食频道", url: "https://www.toutiao.com/channel/food" },
        "今日头条美食（GEO）",
        { multiTenantPlatform: true },
      ),
    ).toBeGreaterThanOrEqual(0.4);
    expect(
      fuzzyMatchScore(
        { title: "搜狐美食频道", url: "https://chihe.sohu.com" },
        "搜狐网美食（GEO）",
        { multiTenantPlatform: true },
      ),
    ).toBeGreaterThanOrEqual(0.4);
  });

  it("brand table matches hostname only and domain branches use registered domains", () => {
    // 路径里含平台词的第三方 URL 不再误判品牌（Q10）。
    expect(domainToBrand("https://example.com/toutiao/share")).toBeUndefined();
    expect(domainToBrand("https://www.toutiao.com/")).toBe("今日头条");
  });

  it("sina joins the multi-tenant list and toutiao numeric ids join L1 (Q2/Q9)", () => {
    expect(isMultiTenantPlatformUrl("https://k.sina.com.cn/article/1.html")).toBe(
      true,
    );
    expect(
      accountKeyFromUrl("https://www.toutiao.com/c/user/3624172865/#mid=1"),
    ).toEqual({ platform: "今日头条", accountId: "3624172865" });
    expect(
      accountKeyFromUrl(
        "https://www.toutiao.com/c/user/token/MS4wLjABAAAAvhBB/",
      ),
    ).toEqual({ platform: "今日头条", accountId: "MS4wLjABAAAAvhBB" });
  });

  it("title-suffix chain guard rejects sohu SEO keyword chains (Q8, 实测 8 拦 8 保)", () => {
    // sohu 关键词链（多段、末段泛词）整条拒绝。
    expect(accountNameFromTitle("广东省高校食堂监管指南_信息化_数据")).toBeNull();
    expect(accountNameFromTitle("外卖运营服务_平台_商家_餐饮")).toBeNull();
    expect(accountNameFromTitle("调味研发定制_定价_产品_服务")).toBeNull();
    // 头条真账号名（单段）保留。
    expect(accountNameFromTitle("机关单位食堂承包_饭饭餐饮")).toBe("饭饭餐饮");
    // 多段链末段 ≥3 字保留（消费面对面|佛山新闻 → 佛山新闻）。
    expect(
      accountNameFromTitle("外卖代运营调查|消费面对面_佛山新闻"),
    ).toBe("佛山新闻");
  });

  it("platform enum is the first family signal (Q7, 枚举↔域名一致率 99.3%)", () => {
    const it168 = {
      name: "IT168",
      entranceLink: "https://www.toutiao.com/c/user/3624172865/",
      platform: 6,
    };
    expect(resourcePlatformFamilies(it168)).toContain("今日头条");
    expect(primaryPlatformFamily(it168)).toBe("今日头条");
    // 媒体类无枚举：域名兜底。
    expect(
      primaryPlatformFamily({
        name: "搜狐网美食",
        entranceLink: "https://www.sohu.com/",
      }),
    ).toBe("搜狐");
  });

  it("junk resale listing pattern (Q11, 全池 211 条)", () => {
    expect(isJunkResaleListing("知乎百粉打包5条")).toBe(true);
    expect(isJunkResaleListing("百家号（账号随机）")).toBe(true);
    expect(isJunkResaleListing("财经类套餐20家打包发布")).toBe(true);
    expect(isJunkResaleListing("华尔街财经（包收录）")).toBe(false);
    expect(isJunkResaleListing("列举网（GEO可发）")).toBe(false);
  });

  it("variant family key separates cross-platform same names (Q13)", () => {
    const ownSite = {
      name: "蓝色河畔（GEO排名）",
      entranceLink: "https://www.hepan.com/article-1.html",
    };
    const toutiaoAccount = {
      name: "蓝色河畔（今日头条）",
      entranceLink: "https://www.toutiao.com/item/7655328646910984750/",
    };
    expect(variantFamilyKey(ownSite)).toBe("蓝色河畔|own");
    expect(variantFamilyKey(toutiaoAccount)).toBe("蓝色河畔|今日头条");
    expect(variantFamilyKey(ownSite)).not.toBe(variantFamilyKey(toutiaoAccount));
    // 【】尾块也剥（北堂萱草【知乎】）。
    expect(channelNameCoreAll("北堂萱草【知乎】")).toBe("北堂萱草");
  });

  it("qualifier suffixes are data-driven (≥10 distinct cores) and drive pack keys (Q13)", () => {
    const names = [
      ...Array.from({ length: 10 }, (_, i) => `站点${i}（可发GEO）`),
      ...Array.from({ length: 10 }, (_, i) => `站点${i}（GEO排名）`),
      "学习强国（江南时报）",
      "学习强国（江苏经济报）",
      "学习强国",
    ];
    const qualifiers = buildQualifierSuffixes(names.map((name) => ({ name })));
    expect(qualifiers.has("可发GEO")).toBe(true);
    expect(qualifiers.has("GEO排名")).toBe(true);
    // 身份词（只在个别渠道出现）不是规格词。
    expect(qualifiers.has("江南时报")).toBe(false);
    expect(packKeyOf("列举网（可发GEO）", qualifiers)).toBe("default");
    expect(packKeyOf("列举网", qualifiers)).toBe("default");
    expect(packKeyOf("学习强国（江南时报）", qualifiers)).toBe("江南时报");
    expect(packKeyOf("学习强国（江苏经济报）", qualifiers)).toBe("江苏经济报");
  });

  it("platform-official gate requires root entrance AND brand in core (Q3a, 全池 ~89 条)", () => {
    // 根路径 + 品牌核心名 → 官方型。
    expect(
      platformOfficialFamily({
        name: "搜狐网美食（GEO）",
        entranceLink: "https://www.sohu.com/",
      }),
    ).toBe("搜狐");
    // 根路径但无名账号（全池 960 条形态）→ 不是官方型。
    expect(
      platformOfficialFamily({
        name: "生活驿站分享",
        entranceLink: "https://www.sohu.com/",
      }),
    ).toBeNull();
    // 品牌核心名但文章页 entrance（账号转售）→ 不是官方型。
    expect(
      platformOfficialFamily({
        name: "今日头条美食（GEO）",
        entranceLink: "https://www.toutiao.com/item/7560222618943521334/",
      }),
    ).toBeNull();
  });

  it("preference exact matching is core-name equality (Q12, 池子命名漂移不断链)", () => {
    expect(
      preferenceEntryMatches(
        { name: "列举网（AI包收录）", exact: true },
        { name: "列举网（GEO可发）", entranceLink: "https://www.lieju.net/" },
      ),
    ).toBe(true);
    expect(
      preferenceEntryMatches(
        { name: "蓝色河畔（GEO排名）", exact: true },
        { name: "蓝色河畔", entranceLink: "https://www.hepan.com/" },
      ),
    ).toBe(true);
    // 不同核心名仍不命中。
    expect(
      preferenceEntryMatches(
        { name: "安庆新闻网", exact: true },
        { name: "安庆都市网（可发GEO）", entranceLink: "https://aqdushi.com/" },
      ),
    ).toBe(false);
  });

  it("global recall prompt caps platform-level generic channels (Q4)", () => {
    const prompt = buildGlobalRecallPrompt({
      topics: ["干蒸菜怎么做"],
      industry: "餐饮管理",
      derivedKeywords: [],
    });
    expect(prompt).toContain("平台级泛渠道从严");
    expect(prompt).toContain("最多 5 条");
  });
});

describe("active name matching precision (2026-08-28 用户裁决：只要真正正确的渠道)", () => {
  it("drops jaccard residue: character overlap across different orgs never matches", () => {
    // 实测残留误配（修复前 0.4-0.5 恰好过线）。
    expect(
      activeNameMatchScore(
        { title: "中国团餐网", url: "https://www.chinatuancan.com" },
        "中国妈妈网",
      ),
    ).toBe(0);
    expect(
      activeNameMatchScore(
        { title: "今日头条美食频道", url: "https://www.toutiao.com/channel/food" },
        "美妆头条",
        { multiTenantPlatform: true },
      ),
    ).toBe(0);
    expect(
      activeNameMatchScore(
        { title: "腾讯新闻美食频道", url: "https://news.qq.com/channel/food" },
        "新闻快讯网",
        { multiTenantPlatform: true },
      ),
    ).toBe(0);
    expect(
      activeNameMatchScore(
        { title: "职业餐饮网", url: "https://www.canyin168.com" },
        "餐饮行业网",
      ),
    ).toBe(0);
  });

  it("keeps true matches: containment, shared prefix, cross-platform brand account", () => {
    // 包含：来源=渠道本名。
    expect(
      activeNameMatchScore(
        { title: "餐饮界", url: "https://www.canyinj.com" },
        "餐饮界",
      ),
    ).toBeGreaterThanOrEqual(0.8);
    // 共享前缀 ≥4 字：机构名+板块描述形态（Jaccard 档弃用后仍需命中）。
    expect(
      activeNameMatchScore(
        { title: "界面新闻消费板块", url: "https://www.jiemian.com/lists/74.html" },
        "界面新闻主站",
      ),
    ).toBeGreaterThanOrEqual(0.8);
    // 非多租户品牌兜底：36氪官网 → 36氪百家号官方账号。
    expect(
      activeNameMatchScore(
        { title: "36氪消费频道", url: "https://www.36kr.com/channel/consumer" },
        "36氪（百家号）",
      ),
    ).toBe(0.5);
    // 品牌强重叠：搜狐美食频道 vs 搜狐网美食。
    expect(
      activeNameMatchScore(
        { title: "搜狐美食频道", url: "https://chihe.sohu.com" },
        "搜狐网美食（GEO）",
        { multiTenantPlatform: true },
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });
});

describe("URL field matching: case_link as second domain signal (2026-08-28 用户裁决)", () => {
  it("collects clean domains from entrance + case_link, dropping multi-tenant hosts", () => {
    expect(
      cleanResourceDomains({
        entranceLink: null,
        caseLink: "https://mip.b2b168.com/wvs1.html",
      }),
    ).toEqual(["b2b168.com"]);
    expect(
      cleanResourceDomains({
        entranceLink: "https://www.hepan.com/article-1.html",
        caseLink: "https://www.sohu.com/a/1_122",
      }),
    ).toEqual(["hepan.com"]);
    expect(cleanResourceDomains({ entranceLink: null, caseLink: null })).toEqual(
      [],
    );
  });

  it("pool domain map includes case_link domains (entrance-empty resources become resolvable)", () => {
    const map = buildPoolDomainNameMap([
      { name: "八方资源网", entranceLink: null, caseLink: "https://mip.b2b168.com/wvs1.html" },
      // 同域核心名冲突：仍整域放弃。
      { name: "渠道甲", entranceLink: "https://example.net/a", caseLink: null },
      { name: "渠道乙", entranceLink: null, caseLink: "https://example.net/b" },
    ]);
    expect(map.get("b2b168.com")).toBe("八方资源网");
    expect(map.has("example.net")).toBe(false);
  });
});

describe("official appendix category matching (2026-08-28 用户裁决：按附录命名实现)", () => {
  it("matches industries against official category names, never marketing zones", async () => {
    const { industryCodesFor, MEDIA_CHANNEL_TYPE_NAMES, WE_MEDIA_INDUSTRY_NAMES } =
      await import("./distributionPlan");
    // 连写词经共享子串命中官方类目名（旧表硬映射错误由此根除）。
    expect(industryCodesFor("餐饮管理", MEDIA_CHANNEL_TYPE_NAMES)).toEqual(
      new Set([18]),
    );
    expect(industryCodesFor("餐饮管理", WE_MEDIA_INDUSTRY_NAMES)).toEqual(
      new Set([13]),
    );
    expect(industryCodesFor("汽车改装", MEDIA_CHANNEL_TYPE_NAMES)).toEqual(
      new Set([6]),
    );
    expect(industryCodesFor("医美整形", MEDIA_CHANNEL_TYPE_NAMES)).toEqual(
      new Set([9]),
    );
    // 营销专区（套餐/秒杀/十元/其他）与未分类永不参与行业匹配。
    const all = industryCodesFor("套餐秒杀十元其他", MEDIA_CHANNEL_TYPE_NAMES);
    for (const code of [13, 14, 15, 100]) expect(all.has(code)).toBe(false);
  });
});
