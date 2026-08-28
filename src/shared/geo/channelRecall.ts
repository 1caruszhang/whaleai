/**
 * 渠道四路召回的 js_ai 对齐纯逻辑（sourceAlignment / preferenceChannels /
 * globalRecall 的忠实移植，ADR-0026/0031/0034）：
 *
 * 1. 名称/域名匹配器——strictMatchScore（0/0.8/1.0，纠链级）与
 *    fuzzyMatchScore（0–1，≥0.4 视为疑似命中）；
 * 2. 偏好名单——内置 exact 名单 + 用户增删 overlay，domain-first + 名称回落；
 * 3. 全局单次召回（主动路）——topics+行业+衍生关键词 → 渠道+主题编号的
 *    prompt 构造、容错解析与编号收敛。
 *
 * 全部纯函数：无网络、无 IO，测试直接喂 fixture。
 */

/** 渠道来源（主动路全局召回 / 被动路探测引用统一形状）。 */
export interface RecallSource {
  /** 渠道/来源标题（渠道名或引用文章标题）。 */
  title: string;
  /** 来源 URL（可缺省——名称回落匹配仍可用）。 */
  url?: string;
  /** 该来源适配的文章（被动=问题映射，主动=topicNumbers 解析结果）。 */
  articleIds?: string[];
  /** 主动路 LLM 推荐理由（原始回答的关键信息，展示用；截断保序）。 */
  reason?: string;
}

/** 偏好名单条目（js_ai preferenceChannels 契约，至少 name 与 domain 之一）。 */
export interface PreferenceChannelEntry {
  name: string;
  domain?: string;
  /** true=精确名匹配（内置名单）；false=严格→模糊容错（用户手输）。 */
  exact?: boolean;
}

/** 用户偏好 overlay（存储形状；与内置名单合成生效清单）。 */
export interface PreferenceChannelSettings {
  additionalPreferenceChannels?: PreferenceChannelEntry[];
  excludedPreferenceChannels?: string[];
}

// ── 域名归一 ───────────────────────────────────────────────────────────────

const COMMON_TWO_LEVEL_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "co.jp",
  "com.hk",
  "com.tw",
]);

/** URL/裸域名 → 注册域名（近似 eTLD+1；解析失败返回 null）。 */
export function registeredDomain(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const hostname = new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    const suffix = labels.slice(-2).join(".");
    return COMMON_TWO_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3
      ? labels.slice(-3).join(".")
      : suffix;
  } catch {
    return null;
  }
}

// ── 品牌域名表（js_ai poolFieldMap DOMAIN_TO_BRAND，逐条移植） ────────────

const DOMAIN_TO_BRAND: ReadonlyArray<{ pattern: string; brand: string }> = [
  { pattern: "sina", brand: "新浪" },
  { pattern: "sohu", brand: "搜狐" },
  { pattern: "tencent", brand: "腾讯" },
  { pattern: "qq.com", brand: "腾讯" },
  { pattern: "163.com", brand: "网易" },
  { pattern: "netease", brand: "网易" },
  { pattern: "ifeng", brand: "凤凰" },
  { pattern: "people", brand: "人民" },
  { pattern: "xinhua", brand: "新华" },
  { pattern: "cctv", brand: "央视" },
  { pattern: "china.com", brand: "中华网" },
  { pattern: "hexun", brand: "和讯" },
  { pattern: "autohome", brand: "汽车之家" },
  { pattern: "pcauto", brand: "太平洋汽车" },
  { pattern: "xcar", brand: "爱卡" },
  { pattern: "yiche", brand: "易车" },
  { pattern: "dongchedi", brand: "懂车帝" },
  { pattern: "chejilab", brand: "车家号" },
  { pattern: "36kr", brand: "36氪" },
  { pattern: "huxiu", brand: "虎嗅" },
  { pattern: "tmtpost", brand: "钛媒体" },
  { pattern: "leiphone", brand: "雷锋" },
  { pattern: "csdn", brand: "CSDN" },
  { pattern: "oschina", brand: "开源中国" },
  { pattern: "zhihu", brand: "知乎" },
  { pattern: "bilibili", brand: "哔哩哔哩" },
  { pattern: "baidu", brand: "百度" },
  { pattern: "toutiao", brand: "今日头条" },
  { pattern: "douyin", brand: "抖音" },
  { pattern: "kuaishou", brand: "快手" },
  { pattern: "xiaohongshu", brand: "小红书" },
  { pattern: "weibo", brand: "微博" },
  { pattern: "kjrb", brand: "科技日报" },
  { pattern: "stcn", brand: "证券时报" },
  { pattern: "ce.cn", brand: "中国经济网" },
  { pattern: "chinadaily", brand: "中国日报" },
  { pattern: "chinanews", brand: "中国新闻网" },
  { pattern: "gbchina", brand: "中国广播网" },
];

/**
 * 域名/URL → 品牌名（用于按品牌家族匹配而非逐字 Jaccard）。
 * 2026-08-28 修复：只在 hostname 上做 pattern 匹配——旧实现对完整 URL 做
 * 子串匹配，路径里含 `toutiao`/`weibo` 字样的第三方 URL 会被误判成平台品牌。
 */
export function domainToBrand(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const hostname = hostnameOf(domain);
  if (!hostname) return undefined;
  for (const { pattern, brand } of DOMAIN_TO_BRAND) {
    if (hostname.includes(pattern)) return brand;
  }
  return undefined;
}

/** 纯文本（来源标题）里的品牌词匹配：标题不是 URL，保持子串语义。 */
function brandFromPlainText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  for (const { pattern, brand } of DOMAIN_TO_BRAND) {
    if (lower.includes(pattern)) return brand;
  }
  return undefined;
}

// ── 多租户平台域名（渠道身份与平台域名解耦） ──────────────────────────────

/**
 * 多租户 UGC/账号平台 host 后缀：平台上任意账号页、文章页、频道页共享同一
 * 注册域名（toutiao.com 上同时存在几万个互不相关的头条号），注册域名相等
 * 不构成「同一渠道」的证据。这些平台上的被动/主动域名对齐必须失效，只保留
 * 名称对齐。自有域名媒体站（如红餐网）不受影响。
 *
 * 2026-08-27 扩入门户系账号平台：sohu.com（搜狐号）、163.com（网易号）、
 * qq.com（企鹅号/公众号，覆盖原单列的 mp.weixin.qq.com）、ifeng.com（凤凰号）
 * ——账号内容挂在门户注册域名下，域名对齐与品牌兜底（搜狐/网易/腾讯/凤凰）
 * 误挂路径与头条系相同。
 *
 * 2026-08-28 扩入新浪：k.sina.com.cn（看点号）与 cj.sina.com.cn（创作者页）
 * 同为平台内账号载体（全池 sina.com.cn 挂载 105 条，platform=9 新浪看点
 * 枚举佐证）；新浪的 L1（article_{uid}_）已支持，入名单后账户级接管。
 */
const MULTI_TENANT_HOST_SUFFIXES: readonly string[] = [
  "toutiao.com",
  "douyin.com",
  // 抖音分享域：独立注册域名但同为平台内账号内容的载体，同口径处置。
  "iesdouyin.com",
  "kuaishou.com",
  "xiaohongshu.com",
  "bilibili.com",
  "zhihu.com",
  "weibo.com",
  "qq.com",
  "baijiahao.baidu.com",
  "sohu.com",
  "163.com",
  "ifeng.com",
  "sina.com.cn",
  "sina.cn",
];

/** URL/裸域名是否落在多租户平台上（host 等于后缀或以 `.后缀` 结尾）。 */
export function isMultiTenantPlatformUrl(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
    return MULTI_TENANT_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

// ── 账户级对齐（2026-08-27 用户裁决：三层解析，全部第一方） ────────────────
//
// 多租户平台上「引用来自哪个账号」的证据分层：
//   L1 URL 内嵌账号标识（搜狐 mp_id / 新浪 uid / 百家号 app_id / 头条 token）
//      ——平台内唯一 ID，最硬；
//   L2 引用标题尾缀账号名（`xxx_账号名`）× 渠道核心名 + 平台一致性门；
//   L3 引用页面作者解析（server 侧抓页注入，纯函数层只见结果）。
// 注册域名相等永远不构成账户身份（多租户门）。

/** 平台族别名表：渠道名括号后缀/URL 域名 → 统一平台族名。 */
const PLATFORM_FAMILY_ALIASES: ReadonlyArray<{
  family: string;
  aliases: readonly string[];
  hosts: readonly string[];
}> = [
  { family: "今日头条", aliases: ["今日头条", "头条号", "头条"], hosts: ["toutiao.com"] },
  { family: "抖音", aliases: ["抖音"], hosts: ["douyin.com", "iesdouyin.com"] },
  { family: "快手", aliases: ["快手"], hosts: ["kuaishou.com"] },
  { family: "小红书", aliases: ["小红书"], hosts: ["xiaohongshu.com"] },
  { family: "哔哩哔哩", aliases: ["哔哩哔哩", "B站", "b站"], hosts: ["bilibili.com"] },
  { family: "知乎", aliases: ["知乎"], hosts: ["zhihu.com"] },
  { family: "微博", aliases: ["微博"], hosts: ["weibo.com"] },
  { family: "搜狐", aliases: ["搜狐号", "搜狐"], hosts: ["sohu.com"] },
  { family: "网易", aliases: ["网易号", "网易"], hosts: ["163.com"] },
  { family: "腾讯", aliases: ["公众号", "企鹅号", "微信", "腾讯"], hosts: ["qq.com"] },
  { family: "百家号", aliases: ["百家号"], hosts: ["baijiahao.baidu.com"] },
  { family: "凤凰", aliases: ["凤凰号", "凤凰"], hosts: ["ifeng.com"] },
  { family: "新浪", aliases: ["新浪"], hosts: ["sina.com.cn", "sina.cn"] },
];

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** URL 的多租户平台族名（非多租户/解析失败返回 null；新浪门户按多租户口径并入）。 */
export function citationPlatformFamily(
  url: string | null | undefined,
): string | null {
  const hostname = url ? hostnameOf(url) : null;
  if (!hostname) return null;
  for (const entry of PLATFORM_FAMILY_ALIASES) {
    if (entry.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      return entry.family;
    }
  }
  return null;
}

/**
 * 媒介盒子 `platform` 枚举（自媒体 100% 携带，文档附录「所属平台」）→ 平台
 * 族名。2026-08-28 全池实测与注册域名一致率 99.3%（8,106/8,163，真矛盾 32
 * 条为转售商录错）；枚举族与域名族并入集合做门（fail-safe 放宽），单值族
 * 另由 primaryPlatformFamily 提供。22=垂类杂项（值得买/抖音电商/淘宝/携程
 * 等混装）不映射，族交给域名推导。
 */
export const PLATFORM_ENUM_FAMILY: Readonly<Record<number, string>> = {
  1: "腾讯",
  2: "哔哩哔哩",
  3: "网易",
  4: "搜狐",
  5: "百家号",
  6: "今日头条",
  7: "微博",
  8: "一点资讯",
  9: "新浪",
  10: "小红书",
  11: "知乎",
  13: "豆瓣",
  14: "UC头条", // 官方附录：所属平台（UC头条=大鱼号同一平台）
  15: "东方号",
  16: "东方财富",
  17: "车家号",
  18: "中金在线",
  19: "雪球",
  20: "凤凰",
  21: "腾讯",
  23: "简书",
  24: "懂车号",
};

/**
 * 池内资源的标识投影：名称 + 入口链接 + 平台枚举。平台族/家族键/官方型/
 * 偏好匹配等纯策略函数统一以此形状取资源——调用方传资源快照的任一超集
 * 均可，避免同一参数簇在各函数签名上重复声明。
 */
export interface ResourceIdentity {
  name: string;
  entranceLink: string | null;
  /** 媒介盒子所属平台枚举（媒体类资源无此字段）。 */
  platform?: number | null;
}

/** 资源侧的平台族集合：platform 枚举（第一信号）+ 渠道名括号后缀（含别名）+ entranceLink 域名。 */
export function resourcePlatformFamilies(input: ResourceIdentity): Set<string> {
  const families = new Set<string>();
  if (typeof input.platform === "number") {
    const enumFamily = PLATFORM_ENUM_FAMILY[input.platform];
    if (enumFamily) families.add(enumFamily);
  }
  const parenthesized = input.name.match(/[（(][^（）()]*[）)]/g) ?? [];
  const scopes = [...parenthesized.map((chunk) => chunk.slice(1, -1)), input.name];
  for (const scope of scopes) {
    for (const entry of PLATFORM_FAMILY_ALIASES) {
      if (entry.aliases.some((alias) => scope.includes(alias))) {
        families.add(entry.family);
      }
    }
  }
  if (input.entranceLink) {
    const family = citationPlatformFamily(input.entranceLink);
    if (family) families.add(family);
  }
  return families;
}

/**
 * 资源的主平台族（单值）：枚举 → entrance 域名 → 名称后缀别名。用于变体
 * 家族键与官方型判定这类需要确定性单值的场景；一致性门仍用集合版
 * resourcePlatformFamilies。
 */
export function primaryPlatformFamily(input: ResourceIdentity): string | null {
  if (typeof input.platform === "number") {
    const enumFamily = PLATFORM_ENUM_FAMILY[input.platform];
    if (enumFamily) return enumFamily;
  }
  if (input.entranceLink) {
    const family = citationPlatformFamily(input.entranceLink);
    if (family) return family;
  }
  const parenthesized = input.name.match(/[（(][^（）()]*[）)]/g) ?? [];
  for (const chunk of [...parenthesized].reverse()) {
    for (const entry of PLATFORM_FAMILY_ALIASES) {
      if (entry.aliases.some((alias) => chunk.slice(1, -1).includes(alias))) {
        return entry.family;
      }
    }
  }
  return null;
}

/**
 * 资源的干净域名信号集合（2026-08-28 用户裁决：URL 字段参与匹配）：
 * entrance_link + case_link（收录案例链接）两个 URL 的注册域名，多租户
 * 域名剔除（case_link 实测 98.3% 与 entrance 同域、16,107 条独立域；7,599
 * 条资源 entrance 为空，case_link 是其唯一域名信号——八方资源网型）。
 * 主动/被动的域名对齐与池反查都以本集合为池侧口径。
 */
export function cleanResourceDomains(resource: {
  entranceLink: string | null;
  caseLink?: string | null;
}): string[] {
  const domains = new Set<string>();
  for (const url of [resource.entranceLink, resource.caseLink]) {
    if (!url) continue;
    if (isMultiTenantPlatformUrl(url)) continue;
    const domain = registeredDomain(url);
    if (domain) domains.add(domain);
  }
  return [...domains];
}

/** URL 内嵌账号标识（L1）。 */
export interface CitationAccountKey {
  /** 平台族名（与 resourcePlatformFamily/citationPlatformFamily 同口径）。 */
  platform: string;
  /** 平台内账号唯一标识。 */
  accountId: string;
}

/**
 * 从 URL 结构提取平台账号标识：搜狐文章路径 `_mpId` 尾段、新浪文章名
 * `article_{uid}_…`/`articles/view/{uid}`、百家号 `app_id` 查询参数、
 * 头条账号页 `/c/user/token/{token}`。取不到返回 null（引用常见形态）。
 */
export function accountKeyFromUrl(
  url: string | null | undefined,
): CitationAccountKey | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  // 搜狐：/a/{articleId}_{mpId}
  if (hostname === "sohu.com" || hostname.endsWith(".sohu.com")) {
    const sohuMatch = parsed.pathname.match(/\/a\/\d+_(\d{4,})/);
    if (sohuMatch?.[1]) return { platform: "搜狐", accountId: sohuMatch[1] };
  }
  // 新浪：article_{uid}_xxx.html 或 /articles/view/{uid}/…
  if (hostname.endsWith("sina.com.cn") || hostname.endsWith("sina.cn")) {
    const sinaPath = decodeURIComponent(parsed.pathname);
    const sinaMatch =
      sinaPath.match(/article[_/](\d{6,})/) ??
      sinaPath.match(/articles\/view\/(\d{6,})/);
    if (sinaMatch?.[1]) return { platform: "新浪", accountId: sinaMatch[1] };
  }
  // 百家号：app_id 查询参数
  if (hostname === "baijiahao.baidu.com") {
    const appId = parsed.searchParams.get("app_id");
    if (appId && /^\d{4,}$/.test(appId)) {
      return { platform: "百家号", accountId: appId };
    }
  }
  // 头条账号主页：/c/user/token/{token} 或 /c/user/{数字id}/（全池 400 条
  // 资源用数字形态、399 个独立 id，2026-08-28 补入；两种形态 id 不互通）。
  if (hostname === "toutiao.com" || hostname.endsWith(".toutiao.com")) {
    const token = parsed.pathname.match(/\/c\/user\/token\/([A-Za-z0-9_-]{8,})/);
    if (token?.[1]) return { platform: "今日头条", accountId: token[1] };
    const numeric = parsed.pathname.match(/\/c\/user\/(\d{5,})/);
    if (numeric?.[1]) return { platform: "今日头条", accountId: numeric[1] };
  }
  // 微信公众号：__biz 参数（部分分享链接携带）
  if (hostname === "mp.weixin.qq.com") {
    const biz = parsed.searchParams.get("__biz");
    if (biz && biz.length >= 8) return { platform: "腾讯", accountId: biz };
  }
  return null;
}

/**
 * 引用标题尾部的账号名（L2 提取）：`xxx_账号名` / `xxx｜账号名`。
 * 2026-08-28 尾缀链防护（实测 50 条真实引用验证）：搜狐引用标题常带
 * SEO 关键词链（`…_信息化_数据`、`…_平台_商家_餐饮`），多段链的末段是
 * 泛词不是账号名——多段链时末段 <3 字整条拒绝；≥3 字（如
 * `…|消费面对面_佛山新闻` 的「佛山新闻」）仍可用。头条真账号名全部单段。
 */
export function accountNameFromTitle(title: string): string | null {
  const chain = title.match(/((?:[_｜|][^\s_｜|·]+){1,})\s*$/);
  if (!chain?.[1]) return null;
  const segments = chain[1].split(/[_｜|]/).filter(Boolean);
  const last = segments[segments.length - 1]?.trim();
  if (!last) return null;
  const width = Array.from(last).length;
  if (width < 2 || width > 30) return null;
  // 纯数字/空白尾缀不是账号名。
  if (/^[\d\s]+$/.test(last)) return null;
  if (segments.length >= 2 && width < 3) return null;
  return last;
}

/**
 * L2 账号名匹配（平台一致性门内）：账号名与渠道核心名互相包含，且资源的
 * 平台族集合包含引用的平台族。跨平台同名不构成命中。
 */
export function accountNameMatchesChannel(input: {
  accountName: string;
  citationPlatform: string | null;
  resourceName: string;
  resourceFamilies: Set<string>;
}): boolean {
  const account = input.accountName.trim().toLowerCase();
  if (account.length < 2) return false;
  if (!input.citationPlatform) return false;
  if (!input.resourceFamilies.has(input.citationPlatform)) return false;
  const core = channelNameCore(input.resourceName).trim().toLowerCase();
  if (core.length < 2) return false;
  return core.includes(account) || account.includes(core);
}

/** 引用标题尾部的站点名（展示兜底）：`…… - 八方资源网` 式短尾缀。 */
export function siteNameFromTitleSuffix(title: string): string | null {
  const match = title.match(/[ \t][-–—][ \t]([^\s\-–—|_,，。；·：:]{2,16})$/);
  const name = match?.[1]?.trim();
  if (!name || /^[\d.]+$/.test(name)) return null;
  return name;
}

/**
 * 池反查映射：注册域名 → 渠道显示名（超级媒介资源池是域名→渠道的权威
 * 映射来源）。多租户域名一域名多渠道，直接不进映射；同名冲突（核心名
 * 不一致）同样放弃，宁缺毋滥。
 */
export function buildPoolDomainNameMap(
  resources: ReadonlyArray<{
    name: string;
    entranceLink: string | null;
    caseLink?: string | null;
  }>,
): Map<string, string> {
  const byDomain = new Map<string, Set<string>>();
  for (const resource of resources) {
    // 域名信号 = entrance + case_link（2026-08-28）；同域多核心名仍整域放弃。
    for (const domain of cleanResourceDomains(resource)) {
      const names = byDomain.get(domain) ?? new Set<string>();
      names.add(channelNameCore(resource.name).trim() || resource.name.trim());
      byDomain.set(domain, names);
    }
  }
  const mapping = new Map<string, string>();
  for (const [domain, names] of byDomain) {
    if (names.size !== 1) continue;
    mapping.set(domain, [...names][0]!);
  }
  return mapping;
}

// ── 变体家族/包、平台官方型、随机号商品（2026-08-28 用户裁决 Q11/Q13）───────

/**
 * 「随机号」转售商品判定：名称含 随机/打包/千粉/百粉/水军/套餐N家/N家媒体
 * （全池 211 条；`包收录` 是正规服务特性不算）。这类商品真实可买，不剔除、
 * 只压制——排序靠后 + 包/家族代表选择永不让位（除非全组皆 junk）。
 */
const JUNK_RESALE_PATTERN =
  /随机|打包|千粉|百粉|水军|套餐\s*\d+\s*家|\d+\s*家(?:媒体|套餐)/;

export function isJunkResaleListing(name: string): boolean {
  return JUNK_RESALE_PATTERN.test(name ?? "");
}

/**
 * 核心名（家族键口径）：在 channelNameCore 剥（）尾块的基础上，连【】尾块
 * 一起剥（「北堂萱草【知乎】」→「北堂萱草」）。匹配语义（fuzzy/L2）继续用
 * channelNameCore，本函数只服务变体家族键与偏好核心名匹配。
 */
export function channelNameCoreAll(name: string): string {
  let core = (name ?? "").trim();
  for (;;) {
    const stripped = core
      .replace(/[（(][^（）()]*[）)]\s*$/, "")
      .replace(/【[^【】]*】\s*$/, "")
      .trim();
    if (stripped === core || stripped.length === 0) break;
    core = stripped;
  }
  return core;
}

/** 名称末尾的括号尾块内容（无则 null；只认（）形，与 channelNameCore 同口径）。 */
function lastParenSuffix(name: string): string | null {
  const match = (name ?? "").match(/[（(]([^（）()]*)[）)]\s*$/);
  return match?.[1] ?? null;
}

/** 资源的唯一家族键：核心名（channelNameCoreAll）+ 主平台族。跨平台同名天然分家。 */
export function variantFamilyKey(resource: ResourceIdentity): string {
  const core = channelNameCoreAll(resource.name).trim().toLowerCase();
  const family = primaryPlatformFamily(resource) ?? "own";
  return `${core}|${family}`;
}

/**
 * 规格词后缀集合（数据驱动，不维护词表）：某个括号尾块出现在 ≥10 个不同
 * 核心名上 = 跨渠道通用规格词（可发GEO 843、GEO 167、包收录 108、官方 131
 * …实测），只在个别渠道出现的是子频道/机构身份词（江南时报、湖南发布…）。
 * 阈值对池快照自算；漏判（geo秒发、带图等低频规格词）的失败方向是自成
 * 一组多占一位，不会错误合并。
 */
export const QUALIFIER_SUFFIX_CORE_THRESHOLD = 10;

export function buildQualifierSuffixes(
  resources: ReadonlyArray<{ name: string }>,
): Set<string> {
  const suffixCores = new Map<string, Set<string>>();
  for (const resource of resources) {
    const suffix = lastParenSuffix(resource.name);
    if (!suffix) continue;
    const core = channelNameCoreAll(resource.name).trim().toLowerCase();
    if (!core) continue;
    let cores = suffixCores.get(suffix);
    if (!cores) {
      cores = new Set<string>();
      suffixCores.set(suffix, cores);
    }
    cores.add(core);
  }
  return new Set(
    [...suffixCores.entries()]
      .filter(([, cores]) => cores.size >= QUALIFIER_SUFFIX_CORE_THRESHOLD)
      .map(([suffix]) => suffix),
  );
}

/**
 * 包键：规格词尾块或无尾块 → 「default」（同一渠道的重复挂牌/套餐规格，
 * 只出 1 个代表）；身份词尾块按尾块值分「子频道包」（学习强国（江南时报）
 * 与（江苏经济报）各一包）。同包择优选 1、家族 ≤2 席（Q13 用户裁决）。
 */
export function packKeyOf(
  name: string,
  qualifierSuffixes: ReadonlySet<string>,
): string {
  const suffix = lastParenSuffix(name);
  if (suffix && !qualifierSuffixes.has(suffix)) return suffix;
  return "default";
}

/**
 * 平台官方型资源判定（Q3a 用户裁决，2026-08-28 数据实证）：entrance 为
 * 平台根路径 ∧ 主平台族来自该平台域名 ∧ 核心名含该平台品牌词。全池双条件
 * 仅 ~89 条（搜狐 21/网易 25/新浪 12/头条 12/凤凰 12/腾讯 7/百度 0）——
 * sohu.com 根路径 981 条里 960 条无名账号（生活驿站分享等）不满足品牌条件，
 * 正确排除。多租户平台级来源只允许经此通道命中，账号渠道永不承接平台级
 * 信号。
 */
export function platformOfficialFamily(resource: ResourceIdentity): string | null {
  if (!resource.entranceLink) return null;
  let parsed: URL;
  try {
    parsed = new URL(resource.entranceLink);
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname !== "") return null;
  const family = citationPlatformFamily(resource.entranceLink);
  if (!family) return null;
  if (!isMultiTenantPlatformUrl(resource.entranceLink)) return null;
  const core = channelNameCore(resource.name);
  const entry = PLATFORM_FAMILY_ALIASES.find(
    (candidate) => candidate.family === family,
  );
  if (!entry) return null;
  return entry.aliases.some((alias) => core.includes(alias)) ? family : null;
}

/**
 * 平台官方型命中的频道佐证（2026-08-28 收紧：同平台跨垂类误挂）。
 * 官方型通道原本只比对平台族——「网易餐饮频道」会经 163.com 命中
 * 「网易房产（GEO）」这类同平台不同垂类的官方资源。现要求来源/资源
 * 剥离品牌后的频道残差对齐（复用 fuzzyMatchScore 品牌分支口径）：
 * - 平台级来源（标题剥品牌后为空，如「网易」）：仍承接官方型资源
 *   （Q3a 原语义：平台级推荐只能落到根路径官方资源上）；
 * - 资源核心名剥品牌后为空（「网易（GEO）」类泛官方资源）：同上承接；
 * - 两侧都有频道词：包含关系或去噪字重叠 ≥0.8 才算对齐
 *   （网易餐饮频道 → 网易餐饮（GEO）✓、→ 网易房产（GEO）✗）。
 */
export function officialChannelAligned(
  source: RecallSource,
  resourceName: string,
): boolean {
  const brand = domainToBrand(source.url);
  if (!brand) return true;
  const srcChannel = stripBrand(source.title ?? "", brand);
  if (!srcChannel) return true;
  const resChannel = stripBrand(
    channelNameCore(resourceName).toLowerCase(),
    brand,
  );
  if (!resChannel) return true;
  if (resChannel.includes(srcChannel) || srcChannel.includes(resChannel))
    return true;
  const srcChars = new Set(
    [...srcChannel].filter((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 0x4e00 || c > 0x9fff) return false;
      return !NOISE_CHARS.has(ch);
    }),
  );
  if (srcChars.size === 0) return true;
  let shared = 0;
  for (const ch of srcChars) if (resChannel.includes(ch)) shared += 1;
  return shared / srcChars.size >= 0.8;
}

// ── 名称匹配（js_ai sourceAlignment，策略逐条移植） ────────────────────────

const SUFFIX_STRIP = [
  "门户",
  "网",
  "平台",
  "官网",
  "首页",
  "频道",
  "中心",
  "在线",
];

function stripSuffixes(name: string): string {
  let result = name;
  for (const suffix of SUFFIX_STRIP) {
    if (result.endsWith(suffix) && result.length > suffix.length + 1) {
      result = result.slice(0, -suffix.length);
    }
  }
  return result;
}

/** CJK/字母数字单字集合上的 Jaccard 相似度（0–1）。 */
function jaccardCJK(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = new Set<string>();
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      const isCjk = code >= 0x4e00 && code <= 0x9fff;
      const isWord = /[a-z0-9]/.test(ch);
      if (isCjk || isWord) tokens.add(ch);
    }
    return tokens;
  };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function stripBrand(name: string, brand: string): string {
  if (!brand) return name;
  const lower = name.toLowerCase();
  const bl = brand.toLowerCase();
  let residual = lower;
  if (residual.startsWith(bl)) residual = residual.slice(bl.length);
  residual = residual.replace(/^[·\-\s:_]+/, "");
  return residual.trim();
}

const NOISE_CHARS = new Set(
  "频道网号官方专区板块首 发快讯视频门户平台站点在线资讯媒体内容综合".replace(
    /\s/g,
    "",
  ),
);

/**
 * 渠道核心名：去掉尾部平台限定后缀（（官方头条号）/（今日头条）/（GEO）等）。
 * 多租户平台上限定后缀只描述宿主平台，不是渠道身份；品牌/名称匹配必须用
 * 核心名，否则「蓝色河畔（今日头条）」会被当成「今日头条」家族成员。
 */
export function channelNameCore(name: string): string {
  let core = name.trim();
  for (;;) {
    const stripped = core.replace(/[（(][^（）()]*[）)]\s*$/, "").trim();
    if (stripped === core || stripped.length === 0) break;
    core = stripped;
  }
  return core;
}

/** fuzzyMatchScore 的调用侧语义开关。 */
export interface FuzzyMatchOptions {
  /**
   * 来源落在多租户平台（toutiao/douyin/公众号等）时为 true：平台品牌家族
   * （如 URL toutiao.com →「今日头条」）不再单独构成名称证据——品牌兜底
   * 0.5 分与「资源名限定后缀含品牌」的进入条件都以核心名判定，防止
   * 「XX融媒（今日头条）」这类账号被平台级推荐误挂。偏好路用户手输
   * 条目保持默认（品牌家族可命中）。
   */
  multiTenantPlatform?: boolean;
}

/**
 * 宽容匹配分（0–1，≥0.4 视为疑似命中）：品牌域名 → 子串 → 去后缀 → Jaccard。
 *
 * 2026-08-28 修复（实测复现「今日头条」vs「泾川融媒（今日头条）」=1.0、
 * 「今日头条美食频道」vs 泾川融媒 =0.4 两处伪命中）：
 * 1. 多租户来源的**全部**名称分支统一按核心名（channelNameCore）比对——
 *    旧实现只有品牌分支限核心名，子串/Jaccard 分支仍吃括号后缀里的平台词；
 * 2. 域名分支改用注册域名（旧实现拿完整 URL 字符串与资源名比对）。
 */
export function fuzzyMatchScore(
  source: RecallSource,
  resourceName: string,
  options?: FuzzyMatchOptions,
): number {
  const srcTitle = source.title ?? "";
  const resLower = resourceName.toLowerCase();
  const srcLower = srcTitle.toLowerCase();
  const domainLower = (registeredDomain(source.url) ?? "").toLowerCase();
  const multiTenant = options?.multiTenantPlatform === true;
  // 名称比对范围：多租户来源只认核心名——括号后缀里的平台名（（今日头条）
  // 等）永远不构成名字证据；stripSuffixes 的词尾剥离（网/频道…）在其上叠加。
  const nameScope = multiTenant ? channelNameCore(resLower) : resLower;
  // 多租户来源：品牌进入条件用资源核心名（限定后缀里的品牌不算）。
  const brandScope = nameScope;

  const brand = domainToBrand(source.url) ?? brandFromPlainText(srcTitle);
  if (brand && brandScope.includes(brand.toLowerCase())) {
    const srcChannel = stripBrand(srcTitle, brand);
    if (srcChannel) {
      const resChannel = stripBrand(brandScope, brand);
      if (
        !resChannel ||
        srcChannel === resChannel ||
        srcLower === resLower ||
        resLower.includes(srcLower) ||
        srcLower.includes(resLower)
      ) {
        return 1.0;
      }
      const srcChars = new Set(
        [...srcChannel].filter((ch) => {
          const c = ch.codePointAt(0)!;
          if (c < 0x4e00 || c > 0x9fff) return false;
          return !NOISE_CHARS.has(ch);
        }),
      );
      if (srcChars.size > 0) {
        let shared = 0;
        for (const ch of srcChars) if (resLower.includes(ch)) shared += 1;
        const ratio = shared / srcChars.size;
        if (ratio >= 0.8) return 0.9;
        if (ratio >= 0.5) return 0.8;
        if (ratio > 0) return 0.5 + 0.3 * ratio;
      }
    }
    // 多租户平台来源：无渠道级字重叠时平台品牌不兜底（0.5 → 0）。
    return multiTenant ? 0 : 0.5;
  }

  if (domainLower && nameScope.includes(domainLower)) return 1.0;
  if (domainLower && domainLower.includes(nameScope)) return 1.0;
  if (srcLower && nameScope.includes(srcLower)) return 1.0;
  if (srcLower && srcLower.includes(nameScope) && nameScope.length >= 2)
    return 1.0;

  const strippedRes = stripSuffixes(nameScope);
  const strippedSrc = stripSuffixes(srcLower);
  if (domainLower && strippedRes && domainLower.includes(strippedRes))
    return 0.8;
  if (strippedSrc && strippedRes && strippedRes.includes(strippedSrc))
    return 0.8;

  const j = jaccardCJK(srcTitle, nameScope);
  if (j >= 0.5) return j > 0.8 ? 0.7 : 0.5;

  const jStripped = jaccardCJK(strippedSrc, strippedRes);
  if (jStripped >= 0.4) return jStripped > 0.7 ? 0.6 : 0.4;

  return 0;
}

/**
 * 主动路专用名称匹配分（2026-08-28 用户裁决：主动路只要真正正确的渠道）。
 * 与 fuzzyMatchScore 的差别：
 * 1. **Jaccard 字符交集档整体不参与**——实测残留误配全部来自该档
 *   （中国团餐网→中国妈妈网 0.5、今日头条美食频道→美妆头条 0.4、
 *    腾讯新闻美食频道→新闻快讯网 0.4：字符有交集但完全不同机构）；
 * 2. 新增**共享前缀规则**：去后缀后两侧前缀 ≥4 字相同视为强命中
 *   （界面新闻主站 ↔ 界面新闻消费板块 共享「界面新闻」——Jaccard 档
 *    会被弃用而它是真匹配；对照 中国团餐网/中国妈妈网 仅共享「中国」2 字
 *    不命中）；
 * 3. 品牌分支保留强重叠（≥0.8）与非多租户品牌兜底 0.5（36氪→36氪（百家号）
 *    这类跨平台官方账号；多租户平台级来源兜底恒 0 不变）。
 * 阈值语义：≥0.8 视为命中（包含/前缀/品牌强重叠），0.5/0.6 仅作为非多租户
 * 品牌兜底与重叠弱信号，由调用方决定取舍（主动路现统一 ≥0.8 收严）。
 */
export function activeNameMatchScore(
  source: RecallSource,
  resourceName: string,
  options?: FuzzyMatchOptions,
): number {
  const srcTitle = source.title ?? "";
  const resLower = resourceName.toLowerCase();
  const srcLower = srcTitle.toLowerCase();
  const domainLower = (registeredDomain(source.url) ?? "").toLowerCase();
  const multiTenant = options?.multiTenantPlatform === true;
  const nameScope = multiTenant ? channelNameCore(resLower) : resLower;

  const brand = domainToBrand(source.url) ?? brandFromPlainText(srcTitle);
  if (brand && nameScope.includes(brand.toLowerCase())) {
    const srcChannel = stripBrand(srcTitle, brand);
    if (srcChannel) {
      const resChannel = stripBrand(nameScope, brand);
      if (
        !resChannel ||
        srcChannel === resChannel ||
        srcLower === resLower ||
        resLower.includes(srcLower) ||
        srcLower.includes(resLower)
      ) {
        return 1.0;
      }
      const srcChars = new Set(
        [...srcChannel].filter((ch) => {
          const c = ch.codePointAt(0)!;
          if (c < 0x4e00 || c > 0x9fff) return false;
          return !NOISE_CHARS.has(ch);
        }),
      );
      if (srcChars.size > 0) {
        let shared = 0;
        for (const ch of srcChars) if (resLower.includes(ch)) shared += 1;
        const ratio = shared / srcChars.size;
        if (ratio >= 0.8) return 0.9;
        if (ratio >= 0.5) return 0.8;
      }
    }
    // 非多租户品牌来源（36kr.com 等品牌官网）：跨平台官方账号兜底。
    return multiTenant ? 0 : 0.5;
  }

  if (domainLower && nameScope.includes(domainLower)) return 1.0;
  if (domainLower && domainLower.includes(nameScope)) return 1.0;
  if (srcLower && nameScope.includes(srcLower)) return 1.0;
  if (srcLower && srcLower.includes(nameScope) && nameScope.length >= 2)
    return 1.0;

  const strippedRes = stripSuffixes(nameScope);
  const strippedSrc = stripSuffixes(srcLower);
  if (strippedSrc && strippedRes) {
    if (strippedRes.includes(strippedSrc)) return 0.8;
    // 共享前缀 ≥4 字（code point 口径）：机构名+板块描述的常见形态。
    let prefix = 0;
    const srcChars = [...strippedSrc];
    const resChars = [...strippedRes];
    while (
      prefix < srcChars.length &&
      prefix < resChars.length &&
      srcChars[prefix] === resChars[prefix]
    ) {
      prefix += 1;
    }
    if (prefix >= 4) return 0.8;
  }

  return 0;
}

/**
 * 唯一域名集合（2026-08-28 用户裁决：URL 匹配防误判）。池内干净域名下所有
 * 核心名能经「包含关系」连成一体 = 唯一域（canyinj.com 的 餐饮界/餐饮界
 * 首发 ✓、b2b168.com 的 八方资源网 ✓）——域名命中直接放行；连不到一起 =
 * 歧义域（ppwll.cn 同时挂 中国商业报道网/广佛都市网/每日快报/邯郸在线 四家
 * 无关机构；同机构多产品域 ycwb.com 也算歧义）——域名命中必须名称佐证，
 * 宁可放弃无佐证的真匹配（金羊网评论）也不放行跨机构误判。
 * 实测：7,135 个干净域名中 6,131 唯一（86%）、1,004 歧义。
 */
export function buildUnambiguousDomains(
  resources: ReadonlyArray<{
    name: string;
    entranceLink: string | null;
    caseLink?: string | null;
  }>,
): Set<string> {
  const coresByDomain = new Map<string, Set<string>>();
  for (const resource of resources) {
    const core = channelNameCoreAll(resource.name).trim().toLowerCase();
    if (!core) continue;
    for (const domain of cleanResourceDomains(resource)) {
      const cores = coresByDomain.get(domain) ?? new Set<string>();
      cores.add(core);
      coresByDomain.set(domain, cores);
    }
  }
  const unique = new Set<string>();
  for (const [domain, cores] of coresByDomain) {
    if (cores.size <= 1) {
      unique.add(domain);
      continue;
    }
    // 传递闭包：任两核心名 A⊃B 或 B⊃A 即连通；全连通才算唯一域。
    const list = [...cores];
    const parent = list.map((_, i) => i);
    const find = (i: number): number =>
      parent[i] === i ? i : ((parent[i] = find(parent[i]!)), parent[i]!);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.includes(b) || b.includes(a)) {
          parent[find(i)] = find(j);
        }
      }
    }
    const roots = new Set(list.map((_, i) => find(i)));
    if (roots.size === 1) unique.add(domain);
  }
  return unique;
}

/** 严格匹配分（0 / 0.8 / 1.0）：品牌域名表 + 精确子串 + 去后缀子串，无 Jaccard。 */
export function strictMatchScore(
  source: RecallSource,
  resourceName: string,
): number {
  const srcDomain = source.url ?? "";
  const srcTitle = source.title ?? "";
  const resLower = resourceName.toLowerCase();
  const srcLower = srcTitle.toLowerCase();
  const domainLower = srcDomain.toLowerCase();

  const brand = domainToBrand(srcDomain) ?? domainToBrand(srcTitle);
  if (brand && resLower.includes(brand.toLowerCase())) return 1.0;

  if (domainLower && resLower.includes(domainLower)) return 1.0;
  if (domainLower && domainLower.includes(resLower)) return 1.0;
  if (srcLower && resLower.includes(srcLower)) return 1.0;

  const strippedRes = stripSuffixes(resLower);
  const strippedSrc = stripSuffixes(srcLower);
  if (domainLower && strippedRes && domainLower.includes(strippedRes))
    return 0.8;
  if (strippedSrc && strippedRes && strippedRes.includes(strippedSrc))
    return 0.8;

  return 0;
}

/** 名称精确比较归一：trim + 小写 + 全半角括号统一 + 空白折叠。 */
export function normalizeChannelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ");
}

// ── 偏好名单（js_ai preferenceChannels，名单与语义逐条一致） ───────────────

/**
 * 内置精选名单：产品侧人工策展的「常在召回」渠道，精确名匹配。
 * 2026-08-27 用户裁决：恢复 js_ai 原始十项（用户预置名单）；候选快照里
 * 未见的名字（咸宁网主站等）是否在全池存在，由下一次计划运行的偏好路
 * 逐名命中结果验证（右侧面板偏好召回块 ✓=同名资源在池且价内）。
 * 2026-08-28 用户裁决修正：「安庆新闻网」是名单录错的渠道名（全池从未
 * 存在；池内存活的是「安庆都市网（可发GEO）」¥8，status=2）——按用户
 * 指认改为后者，名单 10 项全部池内存活。
 */
export const DEFAULT_PREFERENCE_CHANNELS: ReadonlyArray<PreferenceChannelEntry> =
  [
    { name: "蓝色河畔（GEO排名）", exact: true },
    { name: "红安网（GEO排名）", exact: true },
    { name: "咸宁网主站", exact: true },
    { name: "咸阳新闻网（GEO排名）", exact: true },
    { name: "盐城网", exact: true },
    { name: "南郡新闻（官方头条号）", exact: true },
    { name: "济南时报（官方头条号）", exact: true },
    { name: "安庆都市网（可发GEO）", exact: true },
    { name: "博客园（GEO 优化首选，秒发带联系方式）", exact: true },
    { name: "列举网（AI包收录）", exact: true },
  ];

/** 生效偏好清单 = (内置 − 排除) + 用户增补，按名称与注册域名去重。 */
export function resolvePreferenceChannels(
  settings: PreferenceChannelSettings | undefined,
): PreferenceChannelEntry[] {
  const excluded = new Set(
    (settings?.excludedPreferenceChannels ?? []).map((entry) =>
      entry.trim().toLowerCase(),
    ),
  );
  const isExcluded = (entry: PreferenceChannelEntry): boolean =>
    excluded.has(entry.name.trim().toLowerCase()) ||
    (entry.domain !== undefined &&
      excluded.has(entry.domain.trim().toLowerCase()));

  const kept = DEFAULT_PREFERENCE_CHANNELS.filter(
    (entry) => !isExcluded(entry),
  );
  const additional = (settings?.additionalPreferenceChannels ?? [])
    .filter(
      (entry) =>
        !!entry &&
        typeof entry.name === "string" &&
        entry.name.trim().length > 0,
    )
    .map((entry) => ({
      name: entry.name.trim(),
      exact: entry.exact === true,
      domain:
        typeof entry.domain === "string" && entry.domain.trim().length > 0
          ? entry.domain.trim()
          : undefined,
    }));

  const seenName = new Set<string>();
  const seenDomain = new Set<string>();
  const merged: PreferenceChannelEntry[] = [];
  for (const entry of [...kept, ...additional]) {
    const nameKey = entry.name.toLowerCase();
    if (seenName.has(nameKey)) continue;
    const reg = entry.domain
      ? (registeredDomain(entry.domain) ?? entry.domain.toLowerCase())
      : null;
    if (reg && seenDomain.has(reg)) continue;
    seenName.add(nameKey);
    if (reg) seenDomain.add(reg);
    merged.push({
      name: entry.name,
      exact: entry.exact === true,
      domain: entry.domain,
    });
  }
  return merged;
}

/** 偏好条目是否命中某资源：domain 优先；exact=精确名相等；否则严格→模糊。 */
export function preferenceEntryMatches(
  entry: PreferenceChannelEntry,
  resource: ResourceIdentity,
): boolean {
  if (entry.domain) {
    const entryDomain = registeredDomain(entry.domain);
    const resourceDomain = registeredDomain(resource.entranceLink);
    if (entryDomain && entryDomain === resourceDomain) return true;
  }
  if (entry.exact === true) {
    // 2026-08-28 用户裁决：精确=核心名相等（两侧剥（）/【】尾块归一）——
    // 池子挂牌名随转售商改后缀漂移（列举网 7 变体、蓝色河畔 5 变体），全名
    // 逐字匹配会静默断裂（名单 10 项已死 2 项）。同核心变体的取舍交给变体
    // 家族代表规则，不在这里展开。
    return (
      normalizeChannelName(channelNameCoreAll(entry.name)) ===
      normalizeChannelName(channelNameCoreAll(resource.name))
    );
  }
  const source: RecallSource = { title: entry.name, url: entry.domain };
  return (
    strictMatchScore(source, resource.name) > 0 ||
    fuzzyMatchScore(source, resource.name) >= 0.4
  );
}

// ── 全局单次召回（主动路，js_ai globalRecall ADR-0031） ────────────────────

/** 单次召回 prompt 携带的主题数上限（超长截断）。 */
export const MAX_RECALL_TOPICS = 20;

/** 召回解析产物：渠道名 + 真实 URL + 适配主题编号（1-based）。 */
export interface ParsedRecallChannel {
  name: string;
  url: string;
  topicNumbers: number[];
  /** LLM 推荐理由（原始回答关键信息；空串表示模型未给出）。 */
  reason: string;
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fence ? fence[1] : trimmed;
  try {
    return JSON.parse(payload);
  } catch {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 解析全局召回输出：只保留带有效注册域名的渠道（无域名走名称回落会全池模糊展开）。 */
export function parseGlobalRecallResult(text: string): ParsedRecallChannel[] {
  const parsed = parseJsonLoose(text);
  if (!Array.isArray(parsed)) return [];
  const out: ParsedRecallChannel[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const rawUrl = typeof record.url === "string" ? record.url.trim() : "";
    if (!rawUrl) continue;
    if (!registeredDomain(rawUrl)) continue;
    // 推荐理由是主动路原始回答的关键信息（面板展示用）；截断防止投影膨胀。
    const reason =
      typeof record.reason === "string"
        ? record.reason.trim().slice(0, 200)
        : "";
    const topicNumbers = Array.isArray(record.topicNumbers)
      ? [
          ...new Set(
            record.topicNumbers
              .filter(
                (value): value is number =>
                  typeof value === "number" &&
                  Number.isInteger(value) &&
                  value >= 1,
              )
              .map((value) => value),
          ),
        ]
      : [];
    out.push({ name, url: rawUrl, topicNumbers, reason });
  }
  return out;
}

/** 把主题编号收敛到输入范围（越界编号丢弃；纯解析层看不到主题数）。 */
export function clampTopicNumbers(
  numbers: readonly number[],
  topicCount: number,
): number[] {
  return numbers.filter(
    (value) => Number.isInteger(value) && value >= 1 && value <= topicCount,
  );
}

/** 全局单次召回 prompt（js_ai buildGlobalRecallPrompt 语义移植）。 */
export function buildGlobalRecallPrompt(input: {
  topics: readonly string[];
  industry: string;
  derivedKeywords: readonly string[];
}): string {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const topic of input.topics ?? []) {
    if (typeof topic !== "string") continue;
    const trimmed = topic.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
    if (deduped.length >= MAX_RECALL_TOPICS) break;
  }
  const topicBlock = deduped
    .map((topic, index) => `[${index + 1}]${topic}`)
    .join(" ");
  const industry = (input.industry ?? "").trim() || "(未提供)";
  const keywords = (input.derivedKeywords ?? [])
    .filter((keyword) => typeof keyword === "string" && keyword.trim())
    .join("、");
  const keywordNote = keywords ? `（衍生关键词：${keywords}）` : "";
  return [
    "你是一位 GEO（生成式引擎优化）渠道投放专家，精通跨主题的可投稿渠道发现。",
    `你的任务：基于下方【主题列表】与【行业：${industry}】${keywordNote}，一次性推荐一批适合发布这些主题文章的可投稿渠道`,
    "（新闻媒体网站 + 自媒体平台），并在每个渠道上标注它适合哪些主题编号。",
    "",
    "## 主题列表（编号即下方 topicNumbers 引用的编号）",
    topicBlock,
    "",
    "## 推荐规则",
    "1. 一次召回覆盖全部主题——不要逐主题重复推荐，去重后给出全局最优的一批渠道。",
    "2. **优先推荐该行业的垂直媒体和专业媒体**（只服务于该行业的垂直门户/专业媒体，例如：汽车→汽车之家/懂车帝/易车；医美→新氧/丁香园/更美；餐饮→红餐网/职业餐饮网），通用综合门户（搜狐/网易/新浪/腾讯等）和本地生活平台作为补充。这样能精准命中行业受众，而非泛流量。",
    "3. 尽可能多列，**推荐约 20-30 个渠道**，覆盖：行业垂直媒体、行业自媒体号、综合门户的相关频道、地方权威媒体、主流自媒体平台。",
    "4. **平台级泛渠道从严**（2026-08-28）：「知乎」「小红书」「抖音」「微信公众平台」「百度百家号」这类整站/泛平台条目最多 5 条，且必须给出该平台具体频道页或栏目页的真实 URL——裸平台首页不算。优先推荐可精确定位的渠道（垂媒官网、具体账号主页、门户具体频道页），而不是只有平台名。",
    "5. 对每个推荐渠道标注 topicNumbers：它适合【主题列表】里的哪些编号（1-based，可多个）。",
    "6. 按推荐优先级排序（行业垂直媒体在前，覆盖主题多的在前，通用平台在后）。",
    "",
    "## 严格约束（反幻觉）",
    "1. 只推荐真实存在、当前可投稿的渠道——必须是联网搜索能找到的真实平台。",
    "2. 官方网站 url 必须是搜索到的真实链接，严禁编造或臆测任何 URL；url 应指向具体频道页/账号页，不要只给整站首页。",
    "3. 渠道名称 name 必须是该平台的真实名称（用于后续与资源池匹配）。",
    "",
    "## 输出格式",
    "只返回一个 JSON 数组（不要 prose、不要 markdown 代码块）：",
    '[{"name":"搜狐汽车","url":"https://auto.sohu.com","reason":"汽车垂直媒体","topicNumbers":[1,3]}]',
    "topicNumbers 必须是【主题列表】里出现过的编号（1 到主题总数），引用回输入编号。",
  ].join("\n");
}
