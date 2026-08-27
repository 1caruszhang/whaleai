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

/** 域名/URL → 品牌名（用于按品牌家族匹配而非逐字 Jaccard）。 */
export function domainToBrand(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const lower = domain.toLowerCase();
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
 */
const MULTI_TENANT_HOST_SUFFIXES: readonly string[] = [
  "toutiao.com",
  "douyin.com",
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

/** 宽容匹配分（0–1，≥0.4 视为疑似命中）：品牌域名 → 子串 → 去后缀 → Jaccard。 */
export function fuzzyMatchScore(
  source: RecallSource,
  resourceName: string,
  options?: FuzzyMatchOptions,
): number {
  const srcDomain = source.url ?? "";
  const srcTitle = source.title ?? "";
  const resLower = resourceName.toLowerCase();
  const srcLower = srcTitle.toLowerCase();
  const domainLower = srcDomain.toLowerCase();
  const multiTenant = options?.multiTenantPlatform === true;
  // 多租户来源：品牌进入条件用资源核心名（限定后缀里的品牌不算）。
  const brandScope = multiTenant ? channelNameCore(resLower) : resLower;

  const brand = domainToBrand(srcDomain) ?? domainToBrand(srcTitle);
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

  if (domainLower && resLower.includes(domainLower)) return 1.0;
  if (domainLower && domainLower.includes(resLower)) return 1.0;
  if (srcLower && resLower.includes(srcLower)) return 1.0;
  if (srcLower && srcLower.includes(resLower) && resLower.length >= 2)
    return 1.0;

  const strippedRes = stripSuffixes(resLower);
  const strippedSrc = stripSuffixes(srcLower);
  if (domainLower && strippedRes && domainLower.includes(strippedRes))
    return 0.8;
  if (strippedSrc && strippedRes && strippedRes.includes(strippedSrc))
    return 0.8;

  const j = jaccardCJK(srcTitle, resourceName);
  if (j >= 0.5) return j > 0.8 ? 0.7 : 0.5;

  const jStripped = jaccardCJK(strippedSrc, strippedRes);
  if (jStripped >= 0.4) return jStripped > 0.7 ? 0.6 : 0.4;

  return 0;
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
    { name: "安庆新闻网", exact: true },
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
  resource: { name: string; entranceLink: string | null },
): boolean {
  if (entry.domain) {
    const entryDomain = registeredDomain(entry.domain);
    const resourceDomain = registeredDomain(resource.entranceLink);
    if (entryDomain && entryDomain === resourceDomain) return true;
  }
  if (entry.exact === true) {
    return (
      normalizeChannelName(entry.name) === normalizeChannelName(resource.name)
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
    "4. 对每个推荐渠道标注 topicNumbers：它适合【主题列表】里的哪些编号（1-based，可多个）。",
    "5. 按推荐优先级排序（行业垂直媒体在前，覆盖主题多的在前，通用平台在后）。",
    "",
    "## 严格约束（反幻觉）",
    "1. 只推荐真实存在、当前可投稿的渠道——必须是联网搜索能找到的真实平台。",
    "2. 官方网站 url 必须是搜索到的真实链接，严禁编造或臆测任何 URL。",
    "3. 渠道名称 name 必须是该平台的真实名称（用于后续与资源池匹配）。",
    "",
    "## 输出格式",
    "只返回一个 JSON 数组（不要 prose、不要 markdown 代码块）：",
    '[{"name":"搜狐汽车","url":"https://auto.sohu.com","reason":"汽车垂直媒体","topicNumbers":[1,3]}]',
    "topicNumbers 必须是【主题列表】里出现过的编号（1 到主题总数），引用回输入编号。",
  ].join("\n");
}
