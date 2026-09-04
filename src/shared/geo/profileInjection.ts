import {
  ENTERPRISE_PROFILE_FIELDS,
  type EnterpriseProfileField,
} from "./enterpriseProfile";

/**
 * 品牌事实的最小投影形状；与 QuestionPoolKnowledgeFact、
 * TopicPlanKnowledgeFactContext 结构兼容（ADR-0006 画像注入）。
 */
export interface BrandProfileFact {
  predicate: string;
  normalizedValueJson: string;
}

export type BrandProfile = Partial<Record<EnterpriseProfileField, string[]>>;

const PROFILE_FIELD_LABELS: Record<EnterpriseProfileField, string> = {
  fullName: "品牌全称",
  shortNames: "品牌简称",
  addresses: "详细地址",
  serviceArea: "服务区域",
  industry: "行业",
  products: "产品与服务",
  relatedBrands: "相关品牌",
  competitors: "竞品名单",
  potentialCompetitors: "潜在竞品",
  targetCustomers: "目标客户",
  coreAdvantages: "核心优势",
  trustEndorsements: "信任背书",
  customerPainPoints: "客户痛点",
  customerCases: "客户案例",
  contactInfo: "联系方式",
  derivedKeywords: "衍生关键词",
};

const GENERIC_TARGET_REGION_RE = /^(全国|全国范围|全境|中国|大陆|国内|所有城市)$/;

/** 「全国/中国」等宽泛地域不构成锚定（ADR-0006 region 画像锚定）。 */
export function isGenericTargetRegion(value: string): boolean {
  return GENERIC_TARGET_REGION_RE.test(value.trim());
}

const MACRO_REGION_RE =
  /^(西南|西北|华南|华中|华东|华北|东北|东南|全国|沿海|内地|境内|境外)/;

/** 「线上/全国/不限」类交付方式声明：服务本身无地缘，不落地址兜底。 */
const BOUNDLESS_SERVICE_RE = /(线上|线下|不限|全国|全球)/;

/** serviceArea 声明是否为无界（全国/线上/不限类）：显式无地缘，不做锚。 */
function isBoundlessServiceDeclaration(value: string): boolean {
  return isGenericTargetRegion(value) || BOUNDLESS_SERVICE_RE.test(value);
}

/** 候选城市名必须是不含标点/修饰的纯中文短名。 */
export function isValidCityName(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[\u4e00-\u9fa5]{2,6}$/.test(trimmed) &&
    !MACRO_REGION_RE.test(trimmed) &&
    !isGenericTargetRegion(trimmed) &&
    !/(本地|地区|周边|线上|线下|不限|均可)/.test(trimmed)
  );
}

/** 单段清洗：区县尾整段保留（可带省/市前缀）；否则按城市短名提取。 */
function cleanServiceAreaSegment(segment: string): string | undefined {
  const trimmed = segment.trim().replace(/^[\u4e00-\u9fa5]{2,4}(?:省|自治区)/, "");
  const districtCandidate = trimmed.replace(/^[\u4e00-\u9fa5]{2,4}市/, "");
  const districtMatch = districtCandidate.match(
    /^([\u4e00-\u9fa5]{2,4}(?:区|县))$/,
  );
  if (districtMatch && isValidCityName(districtMatch[1]))
    return districtMatch[1];
  const match = trimmed.match(
    /^([\u4e00-\u9fa5]{2,4}?)(?:市|本地|辐射|覆盖|周边|及|$)/,
  );
  const candidate = match?.[1];
  if (
    !candidate ||
    candidate.length < 2 ||
    MACRO_REGION_RE.test(candidate) ||
    isGenericTargetRegion(candidate) ||
    !isValidCityName(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

/** 把服务范围声明清洗成干净地域段（去重、保持声明顺序）。 */
export function extractServiceAreaSegments(value: string): string[] {
  const segments: string[] = [];
  for (const raw of value.split(/[，,、；;（）()及]/)) {
    const candidate = cleanServiceAreaSegment(raw);
    if (candidate && !segments.includes(candidate)) segments.push(candidate);
  }
  return segments;
}

/** 派生出的服务范围：主锚（提示词用）+ 白名单（地域上限，提示词层约束）。 */
export interface ServiceScope {
  primary: string;
  allowed: readonly string[];
}

/**
 * 声明口径（serviceArea）单独派生的服务范围；地址兜底不参与——
 * targetRegion 越界校验（票 #31）只认用户声明，地址只是挖词锚的兜底
 * 来源，不构成可裁决的口径。无界声明（全国/线上）与清洗不出城市段的
 * 声明（如省级）同样返回 undefined（无口径可校验）。
 */
export function declaredServiceScope(
  profile: BrandProfile,
): ServiceScope | undefined {
  const serviceArea = firstProfileValue(profile, "serviceArea");
  if (serviceArea) {
    if (isBoundlessServiceDeclaration(serviceArea)) return undefined;
    const allowed = extractServiceAreaSegments(serviceArea);
    if (allowed.length > 0) return { primary: allowed[0], allowed };
  }
  return undefined;
}

/**
 * 省级行政区短名名单（竞品腿锚分类用，ADR-0007 用户裁决 2026-08-30）。
 * 只用于识别「声明段是不是一个省」（同华南/全国用正则名单识别），不做
 * 省→市归属映射——城市属于哪个省的地理推理交由抽取模型判断。
 */
const PROVINCE_SHORT_NAMES = new Set([
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
  "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
]);

/** 整段声明是否为省级行政区（广东省 / 广西壮族自治区 / 广东），是则归一成短名。 */
function matchProvinceSegment(segment: string): string | undefined {
  const autonomous = segment.match(
    /^([\u4e00-\u9fa5]{2,3}?)(?:维吾尔|壮族|回族)?自治区$/,
  );
  if (autonomous && PROVINCE_SHORT_NAMES.has(autonomous[1])) return autonomous[1];
  const withSuffix = segment.match(/^([\u4e00-\u9fa5]{2,4})省$/);
  if (withSuffix && PROVINCE_SHORT_NAMES.has(withSuffix[1])) return withSuffix[1];
  if (PROVINCE_SHORT_NAMES.has(segment)) return segment;
  return undefined;
}

/**
 * 竞品腿地域锚（ADR-0007）：声明什么粒度就锚什么粒度。
 * - 城市级（成都 / 成都新都 / 四川省成都市→成都）：allowed 白名单可做
 *   字符串包含比对，地域闸继续代码硬拦；
 * - 省级（广东省 / 广西壮族自治区 / 广东）：主锚直接用归一短名（广东），
 *   不做省→市映射——地域相关性由抽取模型自证（查询锚定 + 提示词纪律
 *   兜底），代码不拦；
 * - 全国/线上/宏观区（华南等）与 deriveServiceScope 同判：无地缘，不锚。
 * 混合声明（广东省、长沙市）含省段即按省级宽口径处理（无代码闸，
 * 宁松勿拦，过界候选由确认卡逐行删除兜底）。
 */
export interface CompetitorScope {
  primary: string;
  allowed: readonly string[];
  granularity: "city" | "province";
}

export function deriveCompetitorScope(
  profile: BrandProfile,
): CompetitorScope | undefined {
  const serviceArea = firstProfileValue(profile, "serviceArea");
  if (serviceArea) {
    if (isBoundlessServiceDeclaration(serviceArea)) return undefined;
    const rawSegments = serviceArea
      .split(/[，,、；;（）()及]/)
      .map((segment) => segment.trim().replace(/(全省|全市)$/, ""))
      .filter(Boolean);
    const province = rawSegments
      .map(matchProvinceSegment)
      .find((matched): matched is string => matched !== undefined);
    if (province) return { primary: province, allowed: [], granularity: "province" };
    const allowed = extractServiceAreaSegments(serviceArea);
    if (allowed.length > 0) return { primary: allowed[0], allowed, granularity: "city" };
  }
  for (const address of profileValues(profile, "addresses")) {
    const stripped = address.replace(/^[\u4e00-\u9fa5]{2,4}(?:省|自治区)/, "");
    const cityMatch = stripped.match(/([\u4e00-\u9fa5]{2,4})市/);
    if (cityMatch && isValidCityName(cityMatch[1]))
      return { primary: cityMatch[1], allowed: [cityMatch[1]], granularity: "city" };
  }
  return undefined;
}

/**
 * 地域锚（ADR-0006 修正四）：用户声明的服务范围 = 锚 + 上限，粒度保留
 * （声明「新都区」就是新都区，不升格为成都市）；地址只在声明不可用时兜底
 * 提取城市短名；全国/线上类声明 → 无地缘模式（不落地址兜底）。
 */
function addressCityScope(profile: BrandProfile): ServiceScope | undefined {
  for (const address of profileValues(profile, "addresses")) {
    const stripped = address.replace(/^[\u4e00-\u9fa5]{2,4}(?:省|自治区)/, "");
    const cityMatch = stripped.match(/([\u4e00-\u9fa5]{2,4})市/);
    if (cityMatch && isValidCityName(cityMatch[1]))
      return { primary: cityMatch[1], allowed: [cityMatch[1]] };
  }
  return undefined;
}

export function deriveServiceScope(
  profile: BrandProfile,
): ServiceScope | undefined {
  const serviceArea = firstProfileValue(profile, "serviceArea");
  // 无界声明（全国/线上）= 显式的无地缘模式，不落地址兜底；省级等不可
  // 解析的非无界声明落地址兜底（与原行为一致）。
  if (serviceArea && isBoundlessServiceDeclaration(serviceArea)) {
    return undefined;
  }
  return declaredServiceScope(profile) ?? addressCityScope(profile);
}

/**
 * targetRegion 越界校验（票 #31）：品牌声明了可用服务范围（城市/区县级
 * 白名单）时，run_question_pool 的 targetRegion 越界 fail-loud——含
 * 「全国」等无界值、白名单外地名、升格到更大行政层级（新都区声明传
 * 成都/四川），收窄到声明市内的区县同样重定向回声明口径（无行政区
 * 归属数据可判包含，声明口径是唯一入参口径）。判定复用声明段的同一
 * 清洗（extractServiceAreaSegments），「成都市」「成都市新都区」
 * 「四川省成都市」变体与「成都和绵阳」类连接归一后放行。声明口径
 * 缺失（未声明、无界声明、省级声明）不拦截：地理策略仍由模型按工具
 * 描述执行，服务端只做兜底校验，不做缺省替换。
 */
export function targetRegionScopeViolation(
  profile: BrandProfile,
  targetRegion: string,
): string | undefined {
  const scope = declaredServiceScope(profile);
  if (!scope) return undefined;
  const inScope = (value: string): boolean => {
    const segments = extractServiceAreaSegments(value);
    return (
      segments.length > 0 &&
      segments.every((segment) => scope.allowed.includes(segment))
    );
  };
  if (inScope(targetRegion)) return undefined;
  // 连接词兜底：「成都和绵阳」整串清洗不出段（split 名单只有「及」），
  // 先整串判、不过再按和/与拆判——和田这类含「和」的地名单独出现时
  // 整串即命中，不会误拆。
  if (/[和与]/.test(targetRegion)) {
    const parts = targetRegion.split(/[和与]/).filter(Boolean);
    if (parts.length > 1 && parts.every((part) => inScope(part))) {
      return undefined;
    }
  }
  const scopeText = scope.allowed.join("、");
  return `品牌声明的服务区域为${scopeText}，请以${scopeText}为目标地域`;
}

function parseFactValue(fact: BrandProfileFact): unknown {
  try {
    return JSON.parse(fact.normalizedValueJson);
  } catch {
    return fact.normalizedValueJson;
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 按谓词后缀（`brand.<field>`）把品牌事实投影成 16 字段画像。 */
export function projectBrandProfile(
  facts: readonly BrandProfileFact[],
): BrandProfile {
  const profile: BrandProfile = {};
  for (const field of ENTERPRISE_PROFILE_FIELDS) {
    // 入库 predicate 已被小写化（identity 归一化契约），后缀匹配必须大小写
    // 不敏感——否则 fullName/serviceArea 等 camelCase 字段在真实库上全部失配，
    // 品牌身份会回退到 workspace 名（rui 事故根因）。
    const values = facts
      .filter((fact) =>
        fact.predicate.toLowerCase().endsWith(`.${field.toLowerCase()}`),
      )
      .flatMap((fact) => stringValues(parseFactValue(fact)));
    if (values.length > 0) profile[field] = [...new Set(values)];
  }
  return profile;
}

export function profileValues(
  profile: BrandProfile,
  field: EnterpriseProfileField,
): string[] {
  return profile[field] ?? [];
}

export function firstProfileValue(
  profile: BrandProfile,
  field: EnterpriseProfileField,
): string | undefined {
  return profile[field]?.[0];
}

/**
 * 品牌名裁决（用户拍板 2026-08-19）：品牌名只用知识库已确认的身份事实，
 * 优先级 fullName[0] → shortNames[0]；知识库没有任何身份事实时才用
 * workspace 名兜底。workspace 名是创建品牌工作区时用户随手填的展示名，
 * 与已确认身份冲突时必须让位（炊班长事故：知识库 fullName=造卤先生，
 * 正文却用了 workspace 名「炊班长」）。
 */
export function resolveBrandName(
  profile: BrandProfile,
  workspaceName: string,
): string {
  return (
    firstProfileValue(profile, "fullName") ??
    firstProfileValue(profile, "shortNames") ??
    workspaceName
  );
}

/**
 * ranking 陈列位 1 指称裁决（用户裁决 2026-09-03）：简称优先——陈列位 1
 * 的小节标题与篇内指称用已确认简称（展示位省字数，与标题简称优先同哲学；
 * 全称留在首段全称/简称关系句，若该约定启用）。无已确认简称回退全称，
 * 身份事实都没有才回退 workspace 名。正文注入的「品牌：」行仍用
 * resolveBrandName（全称优先），两者分工不同，勿混用。
 */
export function resolveRankingTargetBrand(
  profile: BrandProfile,
  workspaceName: string,
): string {
  return (
    firstProfileValue(profile, "shortNames") ??
    firstProfileValue(profile, "fullName") ??
    workspaceName
  );
}

/** 挖词阶段的业务画像块：只喂业务信号，不给品牌名（ADR-0028 禁品牌名不变量）。 */
export function renderMiningProfileBlock(profile: BrandProfile): string {
  const lines: string[] = [];
  const products = profileValues(profile, "products");
  const coreAdvantages = profileValues(profile, "coreAdvantages");
  const customerCases = profileValues(profile, "customerCases");
  if (products.length > 0)
    lines.push(`- 核心服务（主参考，理解真实服务品类）：${products.join("；")}`);
  if (coreAdvantages.length > 0)
    lines.push(
      `- 核心优势（主参考，理解差异化服务能力）：${coreAdvantages.join("；")}`,
    );
  if (customerCases.length > 0)
    lines.push(
      `- 客户案例（辅参考，只取其中的服务/场景词，剔除客户身份）：${customerCases.join("；")}`,
    );
  if (lines.length === 0) return "";
  return [
    "## 已确认的业务画像（品牌知识中已确认的参考信号）",
    ...lines,
    "（仅供理解真实服务场景；输出中不得出现品牌名、店铺名或客户身份。）",
  ].join("\n");
}

/** 问题生成阶段的全档案块：全部已确认字段按中文标签渲染，缺失字段省略。 */
export function renderFullProfileBlock(profile: BrandProfile): string {
  const lines = ENTERPRISE_PROFILE_FIELDS.filter((field) =>
    Boolean(profile[field]?.length),
  ).map(
    (field) =>
      `- ${PROFILE_FIELD_LABELS[field]}：${profile[field]!.join("；")}`,
  );
  if (lines.length === 0) return "";
  return ["## 品牌档案（已确认字段）", ...lines].join("\n");
}

/** 正文阶段恒在的品牌身份块：实体层子集，原样使用（ADR-0006 事实三层纪律）。 */
export function renderBrandIdentityBlock(profile: BrandProfile): string {
  const lines: string[] = [];
  const fullName = firstProfileValue(profile, "fullName");
  const shortNames = profileValues(profile, "shortNames");
  const serviceArea = firstProfileValue(profile, "serviceArea");
  const industry = firstProfileValue(profile, "industry");
  if (fullName) lines.push(`- 品牌全称：${fullName}`);
  if (shortNames.length > 0)
    lines.push(`- 品牌简称：${shortNames.join("；")}`);
  if (serviceArea) lines.push(`- 服务区域：${serviceArea}`);
  if (industry) lines.push(`- 行业：${industry}`);
  if (lines.length === 0) return "";
  // 指称序（用户裁决 2026-09-03）：全称与已确认简称同存时，正文首次指称
  // 必须全称、其后统一钉第一个简称、全文仅一次也用全称；缺全称（仅简称
  // 事实）时不注入——没有全称可指，裁决序不适用。
  const firstShort = shortNames[0];
  const orderRule =
    fullName && firstShort && fullName !== firstShort
      ? `正文首次出现品牌指称必须使用全称；其后统一使用简称「${firstShort}」；全文仅出现一次时也必须用全称。`
      : "";
  return [
    "## 品牌身份（实体信息，必须原样使用，不得转述或改写）",
    ...lines,
    // ADR-0009 Decision 1：加粗从模型纪律降格为管线保证（autoBoldBrandMentions
    // 在 parse 后统一补粗），prompt 不再要求手动加粗；实体纪律（简称白名单、
    // 逐字使用）保留——管线只包已确认名字，自造简称不会被自动加粗。
    ...[
      orderRule,
      "品牌指称规则：简称只能取上表已列出的，未列出的一律用全称，不得自造简称；加粗无需手动处理，发布管线会自动补全。",
    ].filter((rule) => rule.length > 0),
  ].join("\n");
}
