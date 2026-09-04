/**
 * 竞品名单语义内核（票 #43，ADR-0007 两层名单的唯一 TS 承载）。
 *
 * 职责边界一句话：从已确认事实到一切名单投影＋一切名单名字判定。
 * 纯函数内核——零 I/O、零 LLM；全仓消费方（文章生成、确定性审校、NL 补名
 * 确认、选题/标题红线、确认卡投影、富化管线、档案页/知识面板）只从本模块
 * 进口名单语义，原居所不留转发出口。私建名单语义（新写归一键/合并逻辑/
 * 换名镜像）会被 competitorRosterGuard 词法守卫拦红——守卫按「内核全部导出
 * 函数名的定义处只许内核与测试文件」断言，零豁免。
 *
 * 与 Rust 镜像的关系：articles.rs 的 `valid_ranking_competitors` /
 * `normalize_ranking_entity_name` 原位不动，行为由
 * rankingCompetitorContractCases.json 双侧 pin（TS import + Rust include_str!）。
 * 已知算法分歧（TS 排行键剥 markdown 字符＋Unicode lowercase；Rust 不剥＋仅
 * ASCII lowercase——中文品牌名上等价、拉丁扩展字符上分歧）在等价红线下不合
 * 并，契约用例只收双侧一致子集向量（中文、全角折叠、空白折叠、ASCII 大小写），
 * 分歧登记于票 #43 漂移台账挂起待独立裁决。
 *
 * 语义注解索引（为什么这样而不是那样）：
 *  - 基线/监测冻结只读直接层：诊断只关心强竞争直接对手，潜在层仅作排行补位
 *    燃料（CONTEXT.md「竞品名单」词条；两层事实、两种显式投影，不得混用）。
 *    Rust geo_baselines.rs 的 `%.competitors` 谓词匹配是刻意语义而非侥幸。
 *  - 标题红线无身份排除：见 titleRedLineCompetitors 注释。
 *  - 两个归一键并存：见 rosterIdentityKey / competitorIdentityKey 注释。
 */

import {
  projectBrandProfile,
  resolveBrandName,
  type BrandProfileFact,
} from "./profileInjection";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface RankingRoster {
  targetBrand: string;
  competitors: string[];
}

export interface RankingCompetitorIdentity {
  workspaceBrandName: string;
  fullNames: readonly string[];
  shortNames: readonly string[];
  relatedBrands: readonly string[];
}

/**
 * 排行竞品不足五家的 fail-closed 错误码前缀（随内核所有）。值由
 * rankingCompetitorContract.json 双侧 pin 裁决（ADR-0012：TS 本常量 import
 * pin 于 competitorRoster.test.ts；Rust articles.rs 的 #[cfg(test)] 用
 * include_str! 对 validate_ranking_competitors 的错误串做行为等值 pin）。
 */
export const RANKING_COMPETITORS_INSUFFICIENT_CODE =
  "article_generation_ranking_competitors_insufficient";

// ---------------------------------------------------------------------------
// 具名键
// ---------------------------------------------------------------------------

/**
 * 排行键（具名归一键之一）：实体名 → 归一比对键。剥 markdown 强调字符
 * （＊｀＿～）后做全角折叠＋Unicode lowercase＋空白折叠，与 Rust 镜像
 * `normalize_ranking_entity_name` 在中文/全角/空白/ASCII 大小写上一致
 * （rankingCompetitorContractCases.json 的 keyNormalizationCases 钉死该
 * 一致子集）；markdown 剥离与 Unicode lowercase 两处分歧登记漂移台账。
 */
export function rosterIdentityKey(value: string): string {
  return foldFullWidthAndLowercase(value.replace(/[*`_~]/g, ""));
}

/**
 * 富化键（具名归一键之二）：富化解析、已知/排除名单与 process() 合并去重
 * 共用的唯一键口径。与排行键是两把不同的钥匙、命名并存不合而钉之：富化键
 * 含繁→简映射（存在闸/关系闸两侧同映射，繁体源页名才对得上）与括号中缀
 * 剥离（（广州）／【旗舰】是注册名里的地域/系列中缀，不是品牌身份——不剥
 * 则同名双份上卡）；排行键服务跨语言集合比对，形态由契约向量钉死。
 * 注意：旧审计头读侧的按名匹配仍是纯 toLocaleLowerCase——繁体存量名走该
 * 读侧时不做归一，属接受的存量兼容差异（漂移台账外的既有注记）。
 */
export function competitorIdentityKey(value: string): string {
  return toSimplifiedChinese(value)
    .replace(/[（(【[［][^（(【[］）)】\]]*[）)】\]]/g, '')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

/** 高频繁→简映射（品牌/餐饮语境）：语料源页常为繁体（「榕邊干蒸鮮排骨」），
 * 名字归一与存在闸比对两侧同时映射即可对齐；证据摘录保留原文引述。 */
const TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
  邊: '边', 鮮: '鲜', 記: '记', 順: '顺', 廣: '广', 東: '东', 燒: '烧',
  雞: '鸡', 魚: '鱼', 豬: '猪', 鹵: '卤', 檔: '档', 館: '馆', 廳: '厅',
  個: '个', 陳: '陈', 黃: '黄', 葉: '叶', 萬: '万', 興: '兴', 豐: '丰',
  寧: '宁', 龍: '龙', 鳳: '凤', 麵: '面', 飯: '饭', 雲: '云', 灣: '湾',
  門: '门', 車: '车', 場: '场', 樂: '乐', 緣: '缘', 長: '长', 陽: '阳',
  銘: '铭', 鋒: '锋', 華: '华', 聯: '联', 燈: '灯', 爐: '炉', 鍋: '锅',
  鹽: '盐', 醬: '酱', 臘: '腊', 鴨: '鸭', 鵝: '鹅', 錦: '锦', 蘭: '兰',
  應: '应', 際: '际', 級: '级', 統: '统', 銷: '销', 廠: '厂', 業: '业',
};

export function toSimplifiedChinese(value: string): string {
  return value.replace(/[\u3400-\u9fff]/g, (ch) => TRADITIONAL_TO_SIMPLIFIED[ch] ?? ch);
}

/**
 * 全角折叠＋小写＋空白折叠：排行键的归一衬底，也是文章审校侧
 * （articleGeneration）事实主张比对的同一衬底——票 #43 review 起单源化于
 * 内核导出，审校侧删除私有副本改为进口（体逐字节同，调用点行为零变化）。
 * 跨语言一致子集由契约向量（keyNormalizationCases）钉死，超出子集的字符
 * 两侧算法分歧挂起台账。
 */
export function foldFullWidthAndLowercase(value: string): string {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    normalized +=
      code >= 0xff01 && code <= 0xff5e
        ? String.fromCharCode(code - 0xfee0)
        : code === 0x3000
          ? " "
          : character;
  }
  return normalized.toLowerCase().replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// 投影族：排行 roster
// ---------------------------------------------------------------------------

function sameOrNestedEntityName(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * 所有 Node 排行榜入口共用的有效竞品规则。跨 Rust 边界仍由同一组契约
 * 用例约束：去空、去重，并排除 workspace 名、身份别名和关联主体。
 */
export function filterValidRankingCompetitors(
  names: readonly string[],
  identity: RankingCompetitorIdentity,
): string[] {
  const excluded = [
    identity.workspaceBrandName,
    ...identity.fullNames,
    ...identity.shortNames,
    ...identity.relatedBrands,
  ]
    .map(rosterIdentityKey)
    .filter(Boolean);
  const seen = new Set<string>();
  return names.filter((name) => {
    const normalized = rosterIdentityKey(name);
    if (
      !normalized ||
      seen.has(normalized) ||
      excluded.some((blocked) => sameOrNestedEntityName(normalized, blocked))
    ) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/**
 * 两层竞品合并（ADR-0007，与 Rust `valid_ranking_competitors` 同构、由
 * rankingCompetitorContractCases.json 共同约束）：直接层在前，潜在层
 * 补位；跨层按归一名嵌套互斥（张仔纪/张纪仔类变体不留双份），身份/关联
 * 主体排除两层共用。TS 侧保序（直接层在前、补位在后）；Rust 镜像现行返回
 * 无序 HashSet（形态不动），排序语义由契约用例在 TS 侧断言序列、Rust 侧
 * 集合比对钉死。
 */
export function mergeRankingCompetitorTiers(
  directNames: readonly string[],
  potentialNames: readonly string[],
  identity: RankingCompetitorIdentity,
): string[] {
  const direct = filterValidRankingCompetitors(directNames, identity);
  const directNormalized = direct.map(rosterIdentityKey);
  return [
    ...direct,
    ...filterValidRankingCompetitors(potentialNames, identity).filter(
      (name) => {
        const normalized = rosterIdentityKey(name);
        return !directNormalized.some((kept) =>
          sameOrNestedEntityName(normalized, kept),
        );
      },
    ),
  ];
}

/**
 * ranking 的唯一名单投影：目标品牌来自身份事实（无身份事实才回退 workspace
 * 名），竞品来自 immutable plannedFacts 中已确认的 competitors（直接层），
 * 不足 5 家时用 potentialCompetitors（潜在层，相近场景/替代品类）按序补足
 * ——两层都只含真实检索来源的名称（ADR-0007 两层名单，用户裁决 2026-08-30）。
 * 选五家时保持「直接层在前、补位在后」的顺序；正文可自由调整这五家在
 * 陈列位 2–6 的顺序。合并后不足 5 家 fail-closed（错误码常量随内核所有，
 * 工具层 rankingCompetitorRequirement 自本模块进口拼装）。
 */
export function resolveRankingRoster<T extends BrandProfileFact>(
  facts: readonly T[],
  workspaceBrandName: string,
): RankingRoster {
  const profile = projectBrandProfile(facts);
  const targetBrand = resolveBrandName(profile, workspaceBrandName).trim();
  const competitors = mergeRankingCompetitorTiers(
    profile.competitors ?? [],
    profile.potentialCompetitors ?? [],
    {
      workspaceBrandName,
      fullNames: profile.fullName ?? [],
      shortNames: profile.shortNames ?? [],
      relatedBrands: profile.relatedBrands ?? [],
    },
  );
  if (competitors.length < 5) {
    throw new Error(
      `${RANKING_COMPETITORS_INSUFFICIENT_CODE}:${competitors.length}`,
    );
  }
  return { targetBrand, competitors: competitors.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// 投影族：标题红线与确认卡行
// ---------------------------------------------------------------------------

/**
 * 标题红线名单投影：两层原始串联，**无身份排除**。为什么无排除：身份判定
 * （自名/别名/关联主体排除）回答的是「谁能进排行陈列」，标题红线回答的是
 * 「正文外的一切真实品牌名都不得出现在标题」——禁令名单宁滥勿缺，把
 * workspace 自名或关联主体从禁令里排除等于放行它们进标题。默认刻意，登记
 * 于票 #43 漂移台账；选题侧（topic-plan deriveProfile）消费本投影。
 */
export function titleRedLineCompetitors(
  directNames: readonly string[],
  potentialNames: readonly string[],
): string[] {
  return [...directNames, ...potentialNames];
}

/** 卡面竞品行的直接层承载字段（competitors）。 */
export function isDirectCompetitorTierField(field: string): boolean {
  return field === "competitors";
}

/** 卡面竞品行的潜在层承载字段（potentialCompetitors）。 */
export function isPotentialCompetitorTierField(field: string): boolean {
  return field === "potentialCompetitors";
}

/** 卡面竞品行的两个事实字段（两层名单在确认卡上的承载字段）。 */
export function isCompetitorTierField(field: string): boolean {
  return isDirectCompetitorTierField(field) || isPotentialCompetitorTierField(field);
}

/** 卡面竞品行分组键：潜在层并入直接层同栏（数据两层、卡面一栏）。 */
export function competitorCardRowField(field: string): string {
  return isPotentialCompetitorTierField(field) ? "competitors" : field;
}

/** 卡面竞品行内层级序：直接层在前、潜在层在后（分界标记位置由该序保证）。 */
export function competitorCardTierOrder(field: string): number {
  return isPotentialCompetitorTierField(field) ? 1 : 0;
}

/**
 * 「潜在」分界标记插入位：行内候选字段键序列中首个潜在层的下标；无潜在层
 * 为 null。直接层在前、潜在层在后的行内排序保证分界标记一旦出现即划开
 * 两段（ADR-0007 卡面投影：直接层在前、潜在层带分界标记与补位小注）。
 */
export function competitorCardPotentialDividerAt(
  fields: readonly string[],
): number | null {
  const index = fields.findIndex(isPotentialCompetitorTierField);
  return index >= 0 ? index : null;
}

// ---------------------------------------------------------------------------
// 身份判定族（自富化管线 material-import 迁入，管线降为消费方）
// ---------------------------------------------------------------------------

/**
 * 同品牌身份判定（层内/跨层互斥用）：两个名字指向同一品牌时 true。两条
 * 通道：①富化键（简体+小写+剥括号中缀）相等或互为子串——注册名变体
 * （张仔纪（广州）餐饮管理有限公司/张仔纪餐饮管理有限公司）；②「·」分段
 * 交叉包含——中文命名「品牌·系列」与「地域·品牌」两种形态并存（张仔纪·
 * 老顺德干蒸菜/顺德·渔文乐），任一段（≥2 字）被对方包含即同品牌。地域段
 * （regionHints：双方 region + 服务区锚）剔除后再比分段，否则「顺德·渔文乐」
 * 会因共享地名段误并「顺德杨廷记」。只判身份、不改存储名——截断会把地域
 * 削成品牌（第四写实跑「顺德·渔文乐」→「顺德」事故）。纯函数。
 */
export function sameBrandIdentity(a: string, b: string, regionHints: readonly string[] = []): boolean {
  // 公司形态后缀（仅比对用，不改存储名）：注册名的法人形态词不是品牌
  // 身份——「张仔纪（广州）餐饮管理有限公司/张仔纪老顺德干蒸菜」因后缀
  // 与马甲词序差异互不为子串漏并（第六写实跑，用户指认三马甲同一家）。
  // 剥离后短于 3 字保留全键，防「广东××公司」剥成地域词误并。
  const COMPANY_FORM_SUFFIX = /(?:餐饮管理|餐饮服务|企业管理|食品|供应链|科技|信息技术)?(?:集团)?(?:股份)?有限(?:责任)?公司$/;
  const keyOf = (value: string) => {
    const key = competitorIdentityKey(value);
    const stripped = key.replace(COMPANY_FORM_SUFFIX, '');
    return stripped.length >= 3 ? stripped : key;
  };
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb || ka.includes(kb) || kb.includes(ka)) return true;
  const regionVariants = new Set<string>();
  for (const hint of regionHints) {
    const key = keyOf(hint);
    if (key) regionVariants.add(key);
    const stripped = key?.replace(/[省市区县]$/, '');
    if (stripped) regionVariants.add(stripped);
  }
  const isRegionSegment = (segment: string) =>
    [...regionVariants].some((variant) => segment.includes(variant) || variant.includes(segment));
  const segmentsOf = (value: string) => value
    .split(/[·・‧•]/)
    .map((segment) => keyOf(segment))
    .filter((segment) => segment.length >= 2 && !isRegionSegment(segment));
  const aSegments = segmentsOf(a);
  const bSegments = segmentsOf(b);
  return aSegments.some((segment) => kb.includes(segment))
    || bSegments.some((segment) => ka.includes(segment));
}

/**
 * 短名形近变体护栏：材料错别字会把品牌短名的形近变体漏进竞品/关联品牌
 * （品牌「炊班长」被材料写成「炊事班」——与短名逐位比对差两个位置，按
 * 字符多重集只差一个字）。规则：去空白后等长、长度 2–4、含 CJK 的两个
 * 名字，忽略字序的字符差异（多重集对称差）≤1 判为自引用——覆盖同音/形
 * 近换字与字序调换；长度 1 豁免（单字重名率太高），长度 ≥5 或不等长仍
 * 只走相等/双向子串旧规则，避免误伤真实竞品。纯函数，dropSelfReferences
 * 与 parseCompetitorSuggestions 共用同一判定。
 */
const CJK_CHAR = /[㐀-鿿豈-﫿]/;

export function isSimilarSelfName(candidate: string, self: string): boolean {
  const left = candidate.replace(/\s+/g, '');
  const right = self.replace(/\s+/g, '');
  if (left.length !== right.length) return false;
  if (left.length < 2 || left.length > 4) return false;
  if (!CJK_CHAR.test(left) || !CJK_CHAR.test(right)) return false;
  return multisetDifference(left, right) <= 1;
}

/** 忽略字序的字符差异：right 中在 left 字符多重集里找不到配对的字符数。 */
function multisetDifference(left: string, right: string): number {
  const counts = new Map<string, number>();
  for (const char of left) counts.set(char, (counts.get(char) ?? 0) + 1);
  let unmatched = 0;
  for (const char of right) {
    const count = counts.get(char) ?? 0;
    if (count > 0) counts.set(char, count - 1);
    else unmatched += 1;
  }
  return unmatched;
}

/** dropSelfReferences 逐条事实的最小结构面（值形态与富化管线事实一致）。 */
export interface RosterSelfReferenceFact {
  field: string;
  value: string | string[];
}

/**
 * relatedBrands/competitors 落库前的确定性自名过滤：剔除品牌名、同批抽出的
 * 全称与别名（大小写不敏感、双向子串 + 短名形近变体）。提示词只能降频，这层
 * 把「本品牌进入自己的关联/竞品列表」变成结构不可能（js_ai dedupeAndFilterCompetitors 契约）。
 * 泛型保持调用方事实类型（含 provenance/scope 等旁路字段）原样透传。
 */
export function dropSelfReferences<T extends RosterSelfReferenceFact>(
  context: { brandName: string },
  facts: readonly T[],
): T[] {
  const selfNames = new Set<string>();
  const remember = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized.length >= 2) selfNames.add(normalized);
  };
  remember(context.brandName);
  for (const fact of facts) {
    if (fact.field !== 'fullName' && fact.field !== 'shortNames') continue;
    for (const value of Array.isArray(fact.value) ? fact.value : [fact.value]) remember(value);
  }
  const isSelf = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2) return false;
    return [...selfNames].some(
      (self) => self === normalized || self.includes(normalized) || normalized.includes(self)
        || isSimilarSelfName(normalized, self),
    );
  };
  return facts.flatMap((fact) => {
    // 两层竞品（ADR-0007）同受自名/形近剔除——品牌自身进哪层都不是竞品。
    if (
      fact.field !== 'relatedBrands'
      && fact.field !== 'competitors'
      && fact.field !== 'potentialCompetitors'
    ) return [fact];
    const values = Array.isArray(fact.value) ? fact.value : [fact.value];
    const kept = values.filter((value) => !isSelf(value));
    // 全部被剔除时整条丢弃，不产出空数组候选。
    return kept.length === values.length ? [fact] : kept.length > 0 ? [{ ...fact, value: kept } as T] : [];
  });
}

// ---------------------------------------------------------------------------
// 旧审计头解码（原 competitorDetails 模块溶入；只读兼容存量）
// ---------------------------------------------------------------------------

export interface CompetitorDisplayDetail {
  name: string;
  region: string;
  similarBusiness: string;
}

const COMPETITOR_DETAILS_PREFIX = '[[xiaojing-competitor-details:v1]]';
const COMPETITOR_DETAILS_LIMIT = 20;

function normalizeDetails(input: unknown): CompetitorDisplayDetail[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: CompetitorDisplayDetail[] = [];
  for (const item of input.slice(0, COMPETITOR_DETAILS_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === 'string' ? holder.name.trim() : '';
    const region = typeof holder.region === 'string' ? holder.region.trim() : '';
    const similarBusiness = typeof holder.similarBusiness === 'string'
      ? holder.similarBusiness.trim()
      : '';
    const token = name.toLocaleLowerCase('zh-CN');
    if (!name || !region || !similarBusiness || seen.has(token)) continue;
    seen.add(token);
    result.push({ name, region, similarBusiness });
  }
  return result;
}

/**
 * ADR-0007 元数据退役：`[[xiaojing-competitor-details:v1]]` 审计头已停止
 * 新增编码（新竞品事实只存名称），本段仅保留读侧——品牌知识面板与品牌
 * 档案页对存量事实的摘录解码出旧三元组做兼容展示；新事实无头即纯名称。
 */
export function decodeCompetitorEvidence(excerpt: string): {
  details: CompetitorDisplayDetail[];
  evidence: string;
} {
  if (!excerpt.startsWith(COMPETITOR_DETAILS_PREFIX)) {
    return { details: [], evidence: excerpt };
  }
  const lineEnd = excerpt.indexOf('\n', COMPETITOR_DETAILS_PREFIX.length);
  // 头部畸形/截断/规范化后为空时退回纯证据文本：审计标记不得出现在
  // 值或来源证据 UI 中（DESIGN.md），宁可丢展示元数据也不泄漏标记。
  const evidence = lineEnd >= 0 ? excerpt.slice(lineEnd + 1) : '';
  try {
    const details = normalizeDetails(JSON.parse(
      excerpt.slice(COMPETITOR_DETAILS_PREFIX.length, lineEnd >= 0 ? lineEnd : undefined),
    ) as unknown);
    if (details.length === 0) return { details: [], evidence };
    return { details, evidence };
  } catch {
    return { details: [], evidence };
  }
}

/** 已确认事实可能合并多份来源；按来源顺序合并展示元数据，后到来源覆盖同名旧值。 */
export function collectCompetitorDetails(
  excerpts: readonly string[],
): CompetitorDisplayDetail[] {
  const merged = new Map<string, CompetitorDisplayDetail>();
  for (const excerpt of excerpts) {
    for (const detail of decodeCompetitorEvidence(excerpt).details) {
      merged.set(detail.name.toLocaleLowerCase('zh-CN'), detail);
    }
  }
  return [...merged.values()];
}

/** 纯名称权威值 + 来源元数据 → 用户可读的持久三元组；旧事实无元数据时保持名称。 */
export function formatCompetitorDisplayNames(
  names: readonly string[],
  details: readonly CompetitorDisplayDetail[],
): string[] {
  const byName = new Map(details.map((detail) => [
    detail.name.toLocaleLowerCase('zh-CN'),
    detail,
  ]));
  return names.map((name) => {
    const detail = byName.get(name.trim().toLocaleLowerCase('zh-CN'));
    return detail
      ? `${detail.name}｜${detail.region}｜${detail.similarBusiness}`
      : name;
  });
}

/**
 * 权威名称数组 + 事实的全部来源 excerpt → 持久三元组展示。聊天卡、品牌知识
 * 面板与品牌档案页共用本投影：无元数据的名称保持原样，绝不错误挂接。
 */
export function formatCompetitorFactValue(
  names: readonly string[],
  excerpts: readonly string[],
): string[] {
  return formatCompetitorDisplayNames(names, collectCompetitorDetails(excerpts));
}
