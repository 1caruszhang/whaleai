import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREFERENCE_CHANNELS,
  buildGlobalRecallPrompt,
  channelNameCore,
  clampTopicNumbers,
  fuzzyMatchScore,
  isMultiTenantPlatformUrl,
  normalizeChannelName,
  parseGlobalRecallResult,
  preferenceEntryMatches,
  registeredDomain,
  resolvePreferenceChannels,
  strictMatchScore,
} from "./channelRecall";

describe("channel recall ported from js_ai", () => {
  it("reduces URLs to registered domains", () => {
    expect(registeredDomain("https://auto.sohu.com/page/1")).toBe("sohu.com");
    expect(registeredDomain("https://www.news.example.com.cn/a")).toBe(
      "example.com.cn",
    );
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
    // exact 名单不泛化到同前缀兄弟资源。
    expect(
      preferenceEntryMatches(
        { name: "南郡新闻（官方头条号）", exact: true },
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
