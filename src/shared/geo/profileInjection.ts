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
 * 地域锚（ADR-0006 修正四）：用户声明的服务范围 = 锚 + 上限，粒度保留
 * （声明「新都区」就是新都区，不升格为成都市）；地址只在声明不可用时兜底
 * 提取城市短名；全国/线上类声明 → 无地缘模式（不落地址兜底）。
 */
export function deriveServiceScope(
  profile: BrandProfile,
): ServiceScope | undefined {
  const serviceArea = firstProfileValue(profile, "serviceArea");
  if (serviceArea) {
    if (
      isGenericTargetRegion(serviceArea) ||
      BOUNDLESS_SERVICE_RE.test(serviceArea)
    ) {
      return undefined;
    }
    const allowed = extractServiceAreaSegments(serviceArea);
    if (allowed.length > 0) return { primary: allowed[0], allowed };
  }
  for (const address of profileValues(profile, "addresses")) {
    const stripped = address.replace(/^[\u4e00-\u9fa5]{2,4}(?:省|自治区)/, "");
    const cityMatch = stripped.match(/([\u4e00-\u9fa5]{2,4})市/);
    if (cityMatch && isValidCityName(cityMatch[1]))
      return { primary: cityMatch[1], allowed: [cityMatch[1]] };
  }
  return undefined;
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

/** 按谓词后缀（`brand.<field>`）把品牌事实投影成 15 字段画像。 */
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
  return [
    "## 品牌身份（实体信息，必须原样使用，不得转述或改写）",
    ...lines,
    "品牌指称规则：正文中品牌每次出现都使用 Markdown 加粗；简称只能取上表已列出的，未列出的一律用全称，不得自造简称。",
  ].join("\n");
}
