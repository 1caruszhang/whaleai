import AdmZip from 'adm-zip';
import { basename } from 'node:path';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import * as XLSX from 'xlsx';

import {
  PROFILE_PROVENANCE_RANK,
  REQUIRED_ENTERPRISE_PROFILE_FIELDS,
  isEnterpriseProfileField,
  type EnterpriseProfileField,
  type EnterpriseProfileScope,
  type ProfileProvenance,
} from '../../shared/geo/enterpriseProfile';
import {
  MATERIAL_ERROR_CODES,
  type MaterialErrorCode,
  type MaterialProcessFailure,
  type MaterialProcessResult as SharedMaterialProcessResult,
  type MaterialProcessSuccess as SharedMaterialProcessSuccess,
} from '../../shared/geo/materials';
import { toKnowledgeCardCandidate } from '../../shared/geo/knowledgeCard';
import { buildSsrfGuardedDispatcher, isUrlSchemeSafe } from '../utils/ssrf';
import { withAbortSignal } from '../utils/cancellation';
import { managementApi, managementApiBytes } from '../utils/management-api-client';
import { GatewayBillingError, type GeoBillingPermitPort } from './billing-permit';
import type { KnowledgeAuthority, KnowledgeCandidate } from './knowledge-authority';
import { GeoUpstreamHttpError } from './provider-capabilities';
import type {
  GeoKeywordSearchCapability,
  GeoKeywordSearchSource,
  GeoTextCapability,
} from './provider-capabilities';

const MAX_WEBSITE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 120_000;
const MAX_REDIRECTS = 3;
const WEBSITE_TIMEOUT_MS = 15_000;
/**
 * 单次材料抽取（含竞品富化的检索与二次抽取）的硬上限。后台处理不再受
 * 代理 120s 请求超时约束，但 provider 挂起必须落回 failed 终态，不能让
 * 材料永远停在 processing。
 */
const DEFAULT_EXTRACTION_TIMEOUT_MS = 10 * 60_000;
/**
 * js_ai 契约：ranking 陈列位 1 为本品牌、2–6 为真实竞品（5 家），加 3 家缓冲
 * （随机陈列与去重损耗），竞品富化目标 8 家。
 */
const COMPETITOR_ENRICHMENT_TARGET = 8;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'log',
]);
const FILE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  'pdf', 'docx', 'xlsx', 'pptx',
]);
const ARRAY_PROFILE_FIELDS = new Set<EnterpriseProfileField>([
  'shortNames',
  'addresses',
  'contactInfo',
  'products',
  'relatedBrands',
  'competitors',
  'targetCustomers',
  'coreAdvantages',
  'trustEndorsements',
  'customerPainPoints',
  'customerCases',
  'derivedKeywords',
]);

export interface BrandMaterial {
  id: string;
  workspaceId: string;
  importedBySessionId: string;
  inputKind: 'file' | 'pasted-text' | 'website-url';
  displayName: string;
  fileExt: string;
  mediaType: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  source: { type: string; originalName?: string; url?: string | null };
  status: 'stored' | 'processing' | 'awaiting-confirmation' | 'processed' | 'failed';
  attemptCount: number;
  lastErrorCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandMaterialContext {
  workspaceId: string;
  brandName: string;
  productLines: string[];
}

export interface MaterialProcessingAttempt {
  id: string;
  materialId: string;
  attemptNumber: number;
}

/** Session 材料列表项：材料投影 + 本 Session 最近一次 attempt 的候选 ID。 */
export interface BrandMaterialListItem {
  material: BrandMaterial;
  candidateIds: string[];
}

export interface BrandMaterialPort {
  context(): Promise<BrandMaterialContext>;
  importFile(sourcePath: string): Promise<BrandMaterial>;
  importText(input: {
    inputKind: 'pasted-text' | 'website-url';
    displayName: string;
    text: string;
    sourceUrl?: string;
  }): Promise<BrandMaterial>;
  get(materialId: string): Promise<BrandMaterial>;
  content(materialId: string): Promise<Uint8Array>;
  delete(materialId: string): Promise<void>;
  begin(materialId: string): Promise<MaterialProcessingAttempt>;
  finish(input: {
    attemptId: string;
    materialId: string;
    status: 'awaiting-confirmation' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }): Promise<BrandMaterial>;
  list(input: { materialIds?: string[]; limit?: number }): Promise<BrandMaterialListItem[]>;
}

interface ExtractedProfileFact {
  field: EnterpriseProfileField;
  value: string | string[];
  provenance: ProfileProvenance;
  sourceExcerpt?: string;
  confidence: number;
  scope: EnterpriseProfileScope;
}

export type MaterialProcessSuccess = SharedMaterialProcessSuccess<BrandMaterial>;
export type MaterialProcessResult = SharedMaterialProcessResult<BrandMaterial>;
export type { MaterialProcessFailure, MaterialErrorCode };

export interface WebsiteFetchDependencies {
  fetch?: (
    url: string,
    init: RequestInit & { dispatcher?: Dispatcher },
  ) => Promise<Response>;
  dispatcherFor?: (url: URL) => Promise<Dispatcher | undefined>;
}

function managementError(result: Record<string, unknown>): Error {
  const message = typeof result.error === 'string' ? result.error : '';
  // 已知固定码原样透传(供 errorCode() 子串命中);自由文本一律收敛为
  // material_management_failed,不得泄漏进泛化 material_processing_failed。
  const known = message ? MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate)) : undefined;
  return new Error(known ?? 'material_management_failed');
}

export class RustBrandMaterialPort implements BrandMaterialPort {
  constructor(
    private readonly identity: { workspaceId: string; sessionId: string; sidecarId: string },
  ) {}

  private envelope(payload: Record<string, unknown>): Record<string, unknown> {
    return { ...this.identity, payload };
  }

  async context(): Promise<BrandMaterialContext> {
    const result = await managementApi('/api/brand-materials/context', 'POST', this.envelope({}));
    if (result.ok !== true) throw managementError(result);
    return result.context as BrandMaterialContext;
  }

  async importFile(sourcePath: string): Promise<BrandMaterial> {
    const payload = { workspaceId: this.identity.workspaceId, sessionId: this.identity.sessionId, sourcePath };
    const result = await managementApi('/api/brand-materials/import-file', 'POST', this.envelope(payload));
    if (result.ok !== true) throw managementError(result);
    return result.material as BrandMaterial;
  }

  async importText(input: {
    inputKind: 'pasted-text' | 'website-url';
    displayName: string;
    text: string;
    sourceUrl?: string;
  }): Promise<BrandMaterial> {
    const payload = {
      workspaceId: this.identity.workspaceId,
      sessionId: this.identity.sessionId,
      ...input,
    };
    const result = await managementApi('/api/brand-materials/import-text', 'POST', this.envelope(payload));
    if (result.ok !== true) throw managementError(result);
    return result.material as BrandMaterial;
  }

  async get(materialId: string): Promise<BrandMaterial> {
    const result = await managementApi('/api/brand-materials/get', 'POST', this.envelope({ materialId }));
    if (result.ok !== true) throw managementError(result);
    return result.material as BrandMaterial;
  }

  async delete(materialId: string): Promise<void> {
    const result = await managementApi('/api/brand-materials/delete', 'POST', this.envelope({ materialId }));
    if (result.ok !== true) throw managementError(result);
  }

  async content(materialId: string): Promise<Uint8Array> {
    return (await managementApiBytes(
      '/api/brand-materials/content',
      this.envelope({ materialId }),
      { maxBytes: 20 * 1024 * 1024, timeoutMs: 30_000 },
    )).bytes;
  }

  async begin(materialId: string): Promise<MaterialProcessingAttempt> {
    const result = await managementApi('/api/brand-materials/processing/start', 'POST', this.envelope({ materialId }));
    if (result.ok !== true) throw managementError(result);
    return result.attempt as MaterialProcessingAttempt;
  }

  async finish(input: {
    attemptId: string;
    materialId: string;
    status: 'awaiting-confirmation' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }): Promise<BrandMaterial> {
    const result = await managementApi('/api/brand-materials/processing/finish', 'POST', this.envelope(input));
    if (result.ok !== true) throw managementError(result);
    return result.material as BrandMaterial;
  }

  async list(input: { materialIds?: string[]; limit?: number }): Promise<BrandMaterialListItem[]> {
    const result = await managementApi('/api/brand-materials/list', 'POST', this.envelope({
      ...(input.materialIds ? { materialIds: input.materialIds } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }));
    if (result.ok !== true) throw managementError(result);
    return result.materials as BrandMaterialListItem[];
  }
}

export function createBrandMaterialPort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustBrandMaterialPort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) throw new Error('Brand materials require an authenticated Sidecar identity');
  return new RustBrandMaterialPort({ ...identity, sidecarId });
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:br\b[^>]*\/>|<a:br\b[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>|<\/a:p>|<\/row>|<\/si>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseOoxml(bytes: Uint8Array, extension: 'docx' | 'pptx'): string {
  const zip = new AdmZip(Buffer.from(bytes));
  const wanted = zip.getEntries()
    .filter((entry) => extension === 'docx'
      ? /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(entry.entryName)
      : /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true }));
  return wanted.map((entry) => decodeXmlText(entry.getData().toString('utf8'))).filter(Boolean).join('\n\n');
}

async function parsePdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' '));
    }
  } finally {
    await document.destroy();
  }
  return pages.join('\n\n');
}

function parseXlsx(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: 'array' });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return `# ${name}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
  }).join('\n\n');
}

function htmlToText(html: string): string {
  return decodeXmlText(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n'));
}

export async function parseBrandMaterial(material: BrandMaterial, bytes: Uint8Array): Promise<string> {
  if (!FILE_EXTENSIONS.has(material.fileExt)) throw new Error('material_type_unsupported');
  let text: string;
  if (TEXT_EXTENSIONS.has(material.fileExt)) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (material.fileExt === 'html' || material.fileExt === 'htm') text = htmlToText(text);
  } else if (material.fileExt === 'pdf') {
    text = await parsePdf(bytes);
  } else if (material.fileExt === 'xlsx') {
    text = parseXlsx(bytes);
  } else if (material.fileExt === 'docx' || material.fileExt === 'pptx') {
    text = parseOoxml(bytes, material.fileExt);
  } else {
    throw new Error('material_type_unsupported');
  }
  const normalized = text.split('\u0000').join('').trim();
  if (!normalized) throw new Error('material_empty');
  return normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

/**
 * 主抽取提示词（js_ai geo-fact-extraction 契约）：逐字段显式定义与边界，
 * 事实类逐字复制、判断类可推断、生成类一律 inferred；competitors 携带完整
 * 竞品纪律（层级原则、纳入信号、前东家最高优先级排除、宁缺毋滥）。
 */
function extractionPrompt(context: BrandMaterialContext, material: BrandMaterial, text: string): string {
  return [
    '你是企业 Profile 事实抽取引擎。阅读下方材料文本，抽取该品牌的企业档案。只返回 JSON，不要 markdown。',
    `品牌：${context.brandName}`,
    `允许的产品线：${context.productLines.length > 0 ? context.productLines.join('、') : '无'}`,
    `材料名：${material.displayName}`,
    '',
    '## 事实类字段（从材料逐字复制；材料没有就省略，不要推断）',
    '- fullName（标量）：品牌完整的注册全称。',
    '- shortNames（数组）：简称/缩写/昵称。',
    '- addresses（数组）：街道级具体地址（街道+门牌号、楼栋、楼层）；区/市/区域名不是地址。',
    '- industry（标量，必填）：单一原子行业品类词，禁止复合；复合业务选最主要品类，其余落 products。'
    + '示例：「汽车音响改装」是原子，「汽车音响改装与隔音降噪」是复合（禁止）。',
    '- contactInfo（数组）：电话号码数字（如「028-12345678」「13800138000」）；多门店/多号码各占一项，全部保留，不合并成一项。',
    '',
    '## 判断类字段（材料有则抽取；没有可依上下文推断，标 inferred）',
    '- serviceArea（标量）：品牌【实际已落地/可提供服务的地理范围】（如「成都新都」「广东省」）。'
    + '「面向/计划/拓展中/稳步推进 X 市场」等愿景性、招商性表述禁止作为取值；'
    + '材料未明写实际范围时，可从客户案例/落地门店/合作档口的地域分布推断。',
    '- products（数组，必填）：核心产品/服务。原子化是硬规则——每项一个可独立命名的产品/服务，'
    + '禁止把多个服务用顿号/逗号/连词/斜杠拼在一项里。宁可多拆几项。',
    '- coreAdvantages（数组，必填）：核心差异化优势，一项一个原子优势点。',
    '- targetCustomers（数组）：服务的对象客群。原子客群标签——每项一类可独立定位的人群'
    + '（如「25-40岁女性」「电车用户」），禁止把多类人拼成一个长标签。',
    '- customerPainPoints（数组）：为客户解决的问题/痛点，一项一个，可从 products 反推（标 inferred）。',
    '- customerCases（数组）：成功案例/成果，一项一个可独立描述的案例。',
    '- trustEndorsements（数组）：材料明确写出的资质/认证/荣誉；宁缺毋滥，不得编造。',
    '- relatedBrands（数组）：与目标品牌有业务关联、但【不是直接竞品】的其他品牌：代理/经销品牌、'
    + '同集团/母公司下的兄弟品牌、战略合作品牌、上下游深度绑定品牌。'
    + `品牌自身（${context.brandName}）、其全称/简称/别名不得进入 relatedBrands；`
    + '材料没有明确关联关系时省略，不要编造。',
    '- competitors（数组）：与该品牌【同体量层级、同赛道、同地域】、客户会拿来'
    + '与本品牌「二选一」比价的同行。竞品来源只有两个：本材料里明确点名，以及'
    + '后续的联网检索——材料没有明确竞争信号就省略，【禁止凭模型记忆推断或编造】。'
    + '竞争信号=明确点名「竞品/对手/主要竞争者」、客户在本品牌与 X 之间二选一、'
    + '价格/方案对比中作为替代选项被列出；只是「被提到」不算。',
    '  【层级原则】先由 industry/products/serviceArea 判断目标品牌的体量层级'
    + '（单体店/地方级服务商，还是区域连锁/全国大连锁/上市集团/上游厂商），'
    + '竞品只取同一层级。按行业判断同层级，不要套固定档位：'
    + '医美——本地诊所互为竞品，公立三甲、全国连锁总部、上市原料商不是；'
    + '汽车音响改装——同城改装店互为竞品，全国连锁、惠威/摩雷/阿尔派等音响设备'
    + '厂商不是（它们卖器材给改装店，不抢改装客户）；'
    + '开锁——同片区开锁师傅互为竞品，跨城不算。',
    '  【★最高优先级排除：前东家】素材里「主理人/创始人/核心人员 曾任职于/供职于/曾任/出身于/'
    + '工作于/师承 X」中的 X 是此人的履历出处——即使 X 同城、同行业、同层级，也绝对不是竞品。'
    + '输出 competitors 前逐名自检：名字出现在履历句式里的，立即删除。',
    '  【其他禁止】供应商/设备品牌（使用 X 品牌仪器/器材）、客户/甲方、合作方、'
    + '平台渠道（美团/抖音/新氧/小红书等）、上下游公司、权威标杆与对标学习对象、'
    + '不同层级大牌；品牌自身及其别名绝对不得进入 competitors。',
    '- derivedKeywords（数组）：客户可能搜索的 GEO/SEO 关键词，生成 5-15 个，一律 inferred。',
    '',
    '## provenance、scope 与输出',
    '- extracted=材料逐字证据（必须 sourceExcerpt）；inferred=基于上下文推断（必须待用户确认）；'
    + 'asked 只用于用户结构化补充，本次不得输出。必填字段'
    + `（${REQUIRED_ENTERPRISE_PROFILE_FIELDS.join(', ')}）材料没有明确值时可以 inferred，但绝不能伪装 extracted。`,
    '- scope 只能是 {"kind":"brand"} 或 {"kind":"product-line","productLine":"允许的产品线之一"}；'
    + '同一字段可分别输出品牌整体值和产品线值。',
    '- 数组字段必须保持原子项数组，不把多个产品/客群/优势拼成一个长字符串。',
    '- 输出：{"facts":[{"field":"industry","value":"人工智能","provenance":"extracted",'
    + '"sourceExcerpt":"原文","confidence":0.95,"scope":{"kind":"brand"}}]}',
    '',
    '## 材料文本',
    text,
  ].join('\n');
}

/**
 * 竞品富化提示词（对齐 js_ai buildCompetitorMiningPrompt 的 web 分支）：
 * 先给目标品牌画像（行业/产品/服务区域/体量层级），再给四条必须同时满足的
 * 判别标准与榜单语料警示——检索语料常混有国际设备品牌榜，层级判断必须以
 * 画像为锚，宁缺毋滥。
 */
function competitorEnrichmentPrompt(input: {
  brandName: string;
  industry: string;
  products: string[];
  serviceArea: string;
  knownCompetitors: string[];
  excludedNames: string[];
  deficit: number;
  searchResult: string;
}): string {
  const productText = input.products.length > 0 ? input.products.join('、') : input.industry || '目标业务';
  return [
    '你是同城竞品识别引擎。只返回 JSON，不要 markdown。',
    '',
    '## 目标品牌画像',
    `- 品牌：${input.brandName}`,
    `- 行业：${input.industry || '未知'}`,
    `- 核心产品/服务：${productText}`,
    input.serviceArea
      ? `- 服务区域：${input.serviceArea}（竞品必须在此区域或紧邻区域实体经营）`
      : '- 服务区域：未知——名字必须与检索文本中明确的本地门店/服务商语境共现，全国性品牌一律不取',
    '- 体量层级：按画像判断（单体门店/地方级服务商，或区域连锁）；连锁品牌按其区域层级取同层级同行。',
    '',
    '## 判别标准——四个条件必须同时满足，缺一不可',
    '1. 同体量层级：与目标品牌同层级争同一批散客；全国/跨区域连锁总部、上市集团、'
    + '上游原料/设备厂商、公立大机构、权威标杆是不同层级，不是竞品。',
    `2. 同赛道：经营与「${productText}」高度重叠的业务——看具体产品/服务，不看行业大类。`,
    `3. 同地域：${input.serviceArea ? `在「${input.serviceArea}」或紧邻区域有实体经营` : '与目标品牌同城的本地机构'}。`,
    '4. 竞争关系：客户会拿来与目标品牌二选一比价——供应商、客户/甲方、合作方、'
    + '平台渠道（美团/抖音/新氧/小红书等）都不是竞品。',
    '',
    '## 榜单语料警示',
    '检索结果常混有「国家/地区 + 品牌 + 英文名」的国际品牌榜单行文（如「以色列摩雷Morel」'
    + '「美国来福Rockford Fosgate」）——这类国际/全国级设备或商品品牌与本地服务商不在同一层级，一律不取；'
    + '「选择一家靠谱的」「三大」「性价比高」等散文/品类/评价语不是企业专名，不取。',
    '',
    `已知竞品（不得重复输出）：${input.knownCompetitors.length > 0 ? input.knownCompetitors.join('、') : '无'}`,
    `排除名称（品牌自身、别名、合作商、上下游、关联品牌，绝不能作为竞品输出）：${input.excludedNames.join('、')}`,
    '',
    `从下方检索结果中找出最多 ${input.deficit} 个真实存在的直接竞争品牌（四个条件同时满足）。`,
    '规则：只允许输出在检索结果文本中字面出现的公司/品牌名，检索结果未提及的不得输出；'
    + '每个名字必须给出 sourceExcerpt（检索结果中包含该名字的原文片段，不超过 200 字）；'
    + '数量不足时按实际数量输出，检索结果里没有同层级本地同行就输出空数组——宁缺毋滥，凑不够不硬凑。',
    '输出：{"competitors":[{"name":"公司名","sourceExcerpt":"原文片段"}]}',
    '',
    '## 检索结果',
    input.searchResult,
  ].join('\n');
}

interface CompetitorSuggestion {
  name: string;
  sourceExcerpt: string;
}

const MATERIAL_COMPETITOR_SIGNAL =
  "(?:竞品|竞争对手|竞争者|直接竞争|二选一|比价|对比|替代(?:方案|选项)?)";
const WEB_COMPETITOR_SIGNAL =
  "(?:竞品|竞争对手|竞争者|直接竞争|同行|同类(?:品牌|机构|门店|服务商)?|二选一|比价|对比|替代(?:方案|选项)?|哪家好|推荐|口碑)";
const NON_COMPETITOR_RELATION =
  "(?:前东家|曾任职于|供职于|曾任|出身于|工作于|师承|合作(?:方|商|伙伴|品牌)?|战略合作|供应商|供货商|经销(?:商|品牌)?|代理(?:商|品牌)?|客户|甲方|设备品牌|仪器品牌|器材品牌|平台渠道|母公司|子公司|兄弟品牌|同集团|隶属于|投资方)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 关系词必须与候选名处于同一短句附近，避免材料同时写「曾任 A；竞品 B」时
 * 因全段出现排除词而误伤 B。提示词用于语义召回，这层把高风险关系变成
 * 确定性落库护栏。
 */
function namedRelation(
  excerpt: string,
  name: string,
  relation: string,
): boolean {
  const escapedName = escapeRegExp(name.trim());
  if (!escapedName) return false;
  const gap = "[^。！？；;，,\\n]{0,120}";
  return new RegExp(
    `(?:${relation})${gap}${escapedName}|${escapedName}${gap}(?:${relation})`,
    "i",
  ).test(excerpt);
}

function hasCompetitorEvidence(
  excerpt: string,
  name: string,
  signal: string,
): boolean {
  return (
    excerpt.includes(name) &&
    namedRelation(excerpt, name, signal) &&
    !namedRelation(excerpt, name, NON_COMPETITOR_RELATION)
  );
}

function normalizeEvidenceText(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function parseCompetitorSuggestions(
  raw: string,
  searchResult: string,
  limits: {
    knownCompetitors: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
    deficit: number;
  },
): CompetitorSuggestion[] {
  const parsed = extractJsonObject(raw);
  if (!Array.isArray(parsed.competitors)) throw new Error('model_response_invalid');
  const haystack = normalizeEvidenceText(searchResult);
  const seen = new Set<string>();
  const suggestions: CompetitorSuggestion[] = [];
  for (const item of parsed.competitors) {
    if (suggestions.length >= limits.deficit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === "string" ? holder.name.trim() : "";
    const sourceExcerpt =
      typeof holder.sourceExcerpt === "string"
        ? holder.sourceExcerpt.trim().slice(0, 4_000)
        : "";
    if (
      !name ||
      !sourceExcerpt ||
      !haystack.includes(normalizeEvidenceText(sourceExcerpt)) ||
      !hasCompetitorEvidence(sourceExcerpt, name, WEB_COMPETITOR_SIGNAL)
    )
      continue;
    const normalized = name.toLowerCase();
    // 反虚构：名字必须字面出现在检索文本中，且不与已知竞品重复；排除名单
    // （品牌自身/别名/关联主体）按双向子串匹配——目标品牌「九味牛」要连
    // 「成都九味牛食品」一起拦下（js_ai dedupeAndFilterCompetitors 契约）；
    // 短名形近变体（材料错别字）由 isSimilarSelfName 一并拦下。
    if (!haystack.includes(normalized)) continue;
    if (limits.knownCompetitors.has(normalized)) continue;
    if ([...limits.excludedNames].some(
      (excluded) => excluded === normalized || excluded.includes(normalized) || normalized.includes(excluded)
        || isSimilarSelfName(normalized, excluded),
    )) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push({ name, sourceExcerpt });
  }
  return suggestions;
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model_response_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    // 截断/格式坏 JSON 必须落固定码,原生 SyntaxError 消息不含任何已知码,
    // 会把真实原因掩蔽成 material_processing_failed。
    throw new Error('model_response_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model_response_invalid');
  }
  return parsed as Record<string, unknown>;
}

/** 复合串兜底拆分（原子化不变式）：模型违反「数组保持原子项」契约（如把全部
 * 竞品拼成一个顿号长串）时，按中英文列表分隔符拆回原子项。customerCases 是
 * 散文式描述，逗号是句内成分而非列表分隔，不拆。 */
const COMPOSITE_LIST_SEPARATORS = /\s*[、，,；;]\s*/;

function splitCompositeArrayItem(field: EnterpriseProfileField, value: string): string[] {
  if (field === 'customerCases') return [value];
  return value.split(COMPOSITE_LIST_SEPARATORS);
}

function cleanValue(field: EnterpriseProfileField, input: unknown): string | string[] | null {
  if (ARRAY_PROFILE_FIELDS.has(field)) {
    const values = Array.isArray(input) ? input : [input];
    const cleaned = values
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => splitCompositeArrayItem(field, value))
      .map((value) => value.trim())
      .filter(Boolean);
    return cleaned.length > 0 ? [...new Set(cleaned)] : null;
  }
  return typeof input === 'string' && input.trim() ? input.trim() : null;
}

/**
 * 同 (field, scope) 合并护栏：抽取契约是「每字段每 scope 一条事实」，模型
 * 违约重复输出时（如多门店电话各成一条），若放行成同一 fact key 的多条
 * 候选，整卡确认会顺序采纳互相触发 CAS 版本冲突（第二条必失败）。数组
 * 字段拼接去重；标量字段保留 provenance 层级最高、先出现的一条。合并后
 * provenance 整体取两侧较低层级（任一侧 inferred 则整条 inferred，与竞品
 * 富化合并的保守契约一致），excerpt/confidence 取证据更强一侧。
 */
function mergeFactsByFieldScope(
  facts: ExtractedProfileFact[],
): ExtractedProfileFact[] {
  const merged = new Map<string, ExtractedProfileFact>();
  for (const fact of facts) {
    const scopeKey = fact.scope.kind === 'brand'
      ? 'brand'
      : `line:${fact.scope.productLine}`;
    const key = `${fact.field}\u0000${scopeKey}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergePair(existing, fact) : fact);
  }
  return [...merged.values()];
}

function mergePair(left: ExtractedProfileFact, right: ExtractedProfileFact): ExtractedProfileFact {
  const leftRank = PROFILE_PROVENANCE_RANK[left.provenance];
  const rightRank = PROFILE_PROVENANCE_RANK[right.provenance];
  const stronger = rightRank > leftRank ? right : left;
  const weaker = rightRank > leftRank ? left : right;
  if (Array.isArray(left.value) && Array.isArray(right.value)) {
    return {
      ...left,
      value: [...new Set([...left.value, ...right.value])],
      provenance: weaker.provenance,
      sourceExcerpt: stronger.sourceExcerpt ?? weaker.sourceExcerpt,
      confidence: Math.max(left.confidence, right.confidence),
    };
  }
  return { ...stronger };
}

export function parseProfileFacts(
  raw: string,
  context: BrandMaterialContext,
  sourceText: string,
): ExtractedProfileFact[] {
  const parsed = extractJsonObject(raw);
  if (!Array.isArray(parsed.facts)) throw new Error('model_response_invalid');
  const facts: ExtractedProfileFact[] = [];
  for (const item of parsed.facts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    if (typeof holder.field !== 'string' || !isEnterpriseProfileField(holder.field)) continue;
    const value = cleanValue(holder.field, holder.value);
    if (value === null) continue;
    const requestedProvenance = holder.provenance === 'extracted' ? 'extracted' : 'inferred';
    const sourceExcerpt = typeof holder.sourceExcerpt === 'string' && holder.sourceExcerpt.trim()
      ? holder.sourceExcerpt.trim().slice(0, 4_000)
      : undefined;
    const provenance: ProfileProvenance = requestedProvenance === 'extracted' && !sourceExcerpt
      ? 'inferred'
      : requestedProvenance;
    let scope: EnterpriseProfileScope = { kind: 'brand' };
    if (holder.scope && typeof holder.scope === 'object' && !Array.isArray(holder.scope)) {
      const rawScope = holder.scope as Record<string, unknown>;
      if (rawScope.kind === 'product-line'
        && typeof rawScope.productLine === 'string'
        && context.productLines.includes(rawScope.productLine.trim())) {
        scope = { kind: 'product-line', productLine: rawScope.productLine.trim() };
      }
    }
    const defaultConfidence = provenance === 'extracted' ? 0.9 : 0.5;
    const confidence = typeof holder.confidence === 'number' && Number.isFinite(holder.confidence)
      ? Math.min(1, Math.max(0, holder.confidence))
      : defaultConfidence;
    facts.push({
      field: holder.field,
      value,
      provenance,
      sourceExcerpt,
      confidence,
      scope,
    });
  }
  return dropUnsupportedMaterialCompetitors(
    dropSelfReferences(context, mergeFactsByFieldScope(facts)),
    sourceText,
  );
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

/**
 * relatedBrands/competitors 落库前的确定性自名过滤：剔除品牌名、同批抽出的
 * 全称与别名（大小写不敏感、双向子串 + 短名形近变体）。提示词只能降频，这层
 * 把「本品牌进入自己的关联/竞品列表」变成结构不可能（js_ai dedupeAndFilterCompetitors 契约）。
 */
function dropSelfReferences(
  context: BrandMaterialContext,
  facts: ExtractedProfileFact[],
): ExtractedProfileFact[] {
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
    if (fact.field !== 'relatedBrands' && fact.field !== 'competitors') return [fact];
    const values = Array.isArray(fact.value) ? fact.value : [fact.value];
    const kept = values.filter((value) => !isSelf(value));
    // 全部被剔除时整条丢弃，不产出空数组候选。
    return kept.length === values.length ? [fact] : kept.length > 0 ? [{ ...fact, value: kept }] : [];
  });
}

/**
 * 材料腿竞品不能只凭「模型把某个品牌放进 competitors 数组」落候选：逐名
 * 要求原文里有明确竞争信号，并排除前东家/合作/供应/客户等关系；同时把
 * relatedBrands 里的主体从 competitors 做交叉剔除。用户明确补充走 asked
 * 事实，不经过这条材料抽取过滤。
 */
function dropUnsupportedMaterialCompetitors(
  facts: ExtractedProfileFact[],
  sourceText: string,
): ExtractedProfileFact[] {
  const sourceCorpus = normalizeEvidenceText(sourceText);
  const relatedNames = facts
    .filter((fact) => fact.field === "relatedBrands")
    .flatMap((fact) => (Array.isArray(fact.value) ? fact.value : [fact.value]))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const isRelated = (candidate: string) => {
    const normalized = candidate.trim().toLowerCase();
    return relatedNames.some(
      (related) =>
        related === normalized ||
        related.includes(normalized) ||
        normalized.includes(related),
    );
  };
  return facts.flatMap((fact) => {
    if (fact.field !== "competitors") return [fact];
    const excerpt = fact.sourceExcerpt?.trim() ?? "";
    const values = Array.isArray(fact.value) ? fact.value : [fact.value];
    const kept = values.filter(
      (name) =>
        sourceCorpus.includes(normalizeEvidenceText(excerpt)) &&
        !isRelated(name) &&
        hasCompetitorEvidence(excerpt, name, MATERIAL_COMPETITOR_SIGNAL),
    );
    return kept.length > 0 ? [{ ...fact, value: kept }] : [];
  });
}

function errorCode(error: unknown): MaterialErrorCode {
  // GatewayBillingError 是类型化错误，message 是自由中文文本，子串机制会把
  // insufficient_balance / billing_transport_failed 等真实原因掩蔽成泛化
  // 兜底——先按类型归到登记码 material_billing_failed。
  if (error instanceof GatewayBillingError) return 'material_billing_failed';
  const message = error instanceof Error ? error.message : String(error);
  return MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate))
    ?? 'material_processing_failed';
}

/**
 * 失败的非密钥诊断：上游/网关 HTTP 状态与业务码（provider 层出口已脱敏），
 * 用于区分限流/鉴权/上游故障。非类型化错误只记异常类名（如
 * TypeError/AbortError），自由文本 message 可能夹带请求细节，不进日志。
 * 只进日志，不进返回值、数据库或 renderer。
 */
function upstreamFailureDiagnostic(error: unknown): Record<string, unknown> | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof GeoUpstreamHttpError) {
    return { upstreamStatus: cause.status, upstreamErrorCode: cause.errorCode ?? null };
  }
  if (cause instanceof Error) {
    return { upstreamError: cause.name };
  }
  return undefined;
}

/**
 * 全失败码共用的脱敏诊断：异常类名 + 类型化错误的非密钥字段
 * （GatewayBillingError 的 code/status；model_failed 时经
 * upstreamFailureDiagnostic 取上游 HTTP 状态/业务码）。自由文本 message
 * 可能夹带请求细节，一律不进日志。只进日志，不进 DB 或返回值。
 */
function failureDiagnostic(error: unknown): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {
    errorName: error instanceof Error ? error.name : typeof error,
  };
  if (error instanceof GatewayBillingError) {
    diagnostic.billingCode = error.code;
    diagnostic.billingStatus = error.status;
  }
  return { ...diagnostic, ...upstreamFailureDiagnostic(error) };
}

export function materialLogProjection(input: {
  operation: 'import-file' | 'import-text' | 'fetch-website' | 'parse' | 'extract' | 'propose-candidates' | 'retry' | 'delete';
  workspaceId: string;
  sessionId: string;
  materialId?: string;
  status: 'started' | 'completed' | 'failed';
  error?: unknown;
}): Record<string, string> {
  const safeIdentifier = (value: string) => /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : 'invalid';
  return {
    operation: input.operation,
    workspaceId: safeIdentifier(input.workspaceId),
    sessionId: safeIdentifier(input.sessionId),
    ...(input.materialId ? { materialId: safeIdentifier(input.materialId) } : {}),
    status: input.status,
    ...(input.error ? { errorCode: errorCode(input.error) } : {}),
  };
}

export async function fetchWebsiteMaterial(
  rawUrl: string,
  deps: WebsiteFetchDependencies = {},
  parentSignal?: AbortSignal,
): Promise<{ finalUrl: string; html: string; displayName: string }> {
  const fetchImpl = deps.fetch ?? (undiciFetch as unknown as WebsiteFetchDependencies['fetch']);
  const dispatcherFor = deps.dispatcherFor ?? buildSsrfGuardedDispatcher;
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error('website_url_rejected');
  }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const safety = isUrlSchemeSafe(current);
    if (!safety.ok || current.username || current.password) throw new Error('website_url_rejected');
    const dispatcher = await dispatcherFor(current).catch(() => {
      throw new Error('website_url_rejected');
    });
    let response: Response;
    try {
      response = await withAbortSignal(
        parentSignal,
        (signal) => fetchImpl!(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { Accept: 'text/html,application/xhtml+xml,text/plain' },
          ...(dispatcher ? { dispatcher } : {}),
        }),
        { timeoutMs: WEBSITE_TIMEOUT_MS },
      );
      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAX_REDIRECTS) throw new Error('website_too_many_redirects');
        const location = response.headers.get('location');
        if (!location) throw new Error('website_redirect_rejected');
        let redirected: URL;
        try {
          redirected = new URL(location, current);
        } catch {
          throw new Error('website_redirect_rejected');
        }
        const redirectSafety = isUrlSchemeSafe(redirected);
        if (!redirectSafety.ok || redirected.username || redirected.password) {
          throw new Error('website_redirect_rejected');
        }
        current = redirected;
        continue;
      }
      if (!response.ok) throw new Error('website_fetch_failed');
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
        throw new Error('website_content_type_unsupported');
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_WEBSITE_BYTES) throw new Error('website_too_large');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_WEBSITE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('website_too_large');
          }
          chunks.push(value);
        }
      } else {
        const value = new Uint8Array(await response.arrayBuffer());
        if (value.byteLength > MAX_WEBSITE_BYTES) throw new Error('website_too_large');
        chunks.push(value);
        size = value.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!html.trim()) throw new Error('material_empty');
      return {
        finalUrl: current.toString(),
        html,
        displayName: `${(current.hostname.replace(/[^a-zA-Z0-9.-]/g, '_') || 'website').slice(0, 170)}.html`,
      };
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'material_processing_failed') throw error;
      throw new Error('website_fetch_failed');
    } finally {
      if (dispatcher) await dispatcher.close().catch(() => {});
    }
  }
  throw new Error('website_too_many_redirects');
}

export class MaterialImportService {
  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly materialPort: BrandMaterialPort,
    private readonly extraction: GeoTextCapability,
    private readonly authority: Pick<KnowledgeAuthority, 'propose' | 'inspect'>,
    private readonly websiteDeps: WebsiteFetchDependencies = {},
    private readonly keywordSearch?: Pick<GeoKeywordSearchCapability, 'search' | 'searchSources'>,
    private readonly extractionTimeoutMs: number = DEFAULT_EXTRACTION_TIMEOUT_MS,
    /** 网关计费（票 07）：材料导入 20 点/份，失败份退回；缺省跳过。 */
    private readonly permits?: GeoBillingPermitPort,
  ) {}

  async importFiles(sourcePaths: readonly string[]): Promise<MaterialProcessResult[]> {
    const results: MaterialProcessResult[] = [];
    for (const sourcePath of sourcePaths) {
      try {
        const material = await this.materialPort.importFile(sourcePath);
        results.push(await this.process(material.id));
      } catch (error) {
        results.push({ ok: false, errorCode: errorCode(error) === 'material_processing_failed'
          ? 'material_import_failed'
          : errorCode(error) });
      }
    }
    return results;
  }

  async importPastedText(text: string, displayName = '粘贴资料.txt'): Promise<MaterialProcessResult> {
    try {
      const material = await this.materialPort.importText({
        inputKind: 'pasted-text',
        displayName,
        text,
      });
      return this.process(material.id);
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) === 'material_processing_failed'
        ? 'material_import_failed'
        : errorCode(error) };
    }
  }

  async importWebsite(url: string, parentSignal?: AbortSignal): Promise<MaterialProcessResult> {
    try {
      const fetched = await fetchWebsiteMaterial(url, this.websiteDeps, parentSignal);
      const material = await this.materialPort.importText({
        inputKind: 'website-url',
        displayName: fetched.displayName,
        text: fetched.html,
        sourceUrl: fetched.finalUrl,
      });
      return this.process(material.id);
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) === 'material_processing_failed'
        ? 'website_fetch_failed'
        : errorCode(error) };
    }
  }

  async processMany(materialIds: readonly string[]): Promise<MaterialProcessResult[]> {
    const results: MaterialProcessResult[] = [];
    for (const materialId of materialIds) results.push(await this.process(materialId));
    return results;
  }

  /**
   * js_ai material-to-facts 契约的 "enrich real competitors"：品牌整体竞品
   * （本次抽取 + 已确认权威值）不足 ranking 的 5 家陈列位时，用真实检索结果
   * 补足。富化名一律 inferred（低置信）并携带检索原文摘录；与材料已抽出的
   * 竞品合并为同一条候选，避免同键多条候选顺序采纳时互相覆盖。检索或解析
   * 失败不影响其他字段，但 process() 随后仍会产出可补充的 competitors 必审行。
   */
  private async enrichCompetitors(
    context: BrandMaterialContext,
    facts: ExtractedProfileFact[],
    signal?: AbortSignal,
  ): Promise<ExtractedProfileFact | null> {
    // 富化各出口的固定码投影（脱敏契约同上方 degraded 行）：只有状态码与
    // 数量，不落品牌名/检索内容，保证一次真实导入可事后诊断。
    const logOutcome = (projection: Record<string, unknown>): void => {
      console.log(`[materials] ${JSON.stringify({
        operation: 'competitor-search',
        ...projection,
      })}`);
    };
    if (!this.keywordSearch) {
      logOutcome({ status: 'skipped', errorCode: 'keyword_search_unavailable' });
      return null;
    }
    const normalize = (value: string) => value.trim().toLowerCase();
    const brandCompetitors = new Set<string>();
    const knownCompetitors = new Set<string>();
    const excludedNames = new Set<string>([normalize(context.brandName)]);
    const excludedDisplay = new Map<string, string>([[normalize(context.brandName), context.brandName]]);
    const knownDisplay = new Map<string, string>();
    let industry = '';
    let serviceArea = '';
    const materialProducts = new Set<string>();
    const remember = (store: Map<string, string>, value: string) => {
      const trimmed = value.trim();
      if (trimmed) store.set(normalize(trimmed), trimmed);
    };
    for (const fact of facts) {
      for (const value of Array.isArray(fact.value) ? fact.value : [fact.value]) {
        if (fact.field === 'competitors') {
          knownCompetitors.add(normalize(value));
          remember(knownDisplay, value);
          if (fact.scope.kind === 'brand') brandCompetitors.add(normalize(value));
        }
        if (fact.field === 'relatedBrands' || fact.field === 'shortNames' || fact.field === 'fullName') {
          excludedNames.add(normalize(value));
          remember(excludedDisplay, value);
        }
        if (fact.field === 'industry' && !industry) industry = value.trim();
        if (fact.field === 'serviceArea' && !serviceArea) serviceArea = value.trim();
        if (fact.field === 'products' && fact.scope.kind === 'brand' && value.trim()) {
          materialProducts.add(value.trim());
        }
      }
    }
    try {
      const current = await this.authority.inspect({
        subject: context.brandName,
        predicate: 'enterprise-profile.competitors',
        scope: { entityScope: 'brand' },
      });
      if (current) {
        const confirmed = JSON.parse(current.normalizedValueJson) as unknown;
        for (const value of Array.isArray(confirmed) ? confirmed : [confirmed]) {
          if (typeof value !== 'string' || !value.trim()) continue;
          brandCompetitors.add(normalize(value));
          knownCompetitors.add(normalize(value));
          remember(knownDisplay, value);
        }
      }
    } catch {
      // 权威值读取失败时只按本次抽取计数，不阻断富化。
    }
    const deficit = COMPETITOR_ENRICHMENT_TARGET - brandCompetitors.size;
    if (deficit <= 0) {
      logOutcome({ status: 'skipped', errorCode: 'deficit_zero' });
      return null;
    }
    // 画像注入（js_ai 契约）：四条件判别需要 products/serviceArea——本次材料值
    // 优先，缺失时用已确认权威值补齐；都没有时提示词声明未知并收紧判别。
    const products = new Set<string>(materialProducts);
    try {
      const [productsFact, serviceAreaFact] = await Promise.all([
        products.size > 0
          ? null
          : this.authority.inspect({
            subject: context.brandName,
            predicate: 'enterprise-profile.products',
            scope: { entityScope: 'brand' },
          }),
        serviceArea
          ? null
          : this.authority.inspect({
            subject: context.brandName,
            predicate: 'enterprise-profile.servicearea',
            scope: { entityScope: 'brand' },
          }),
      ]);
      for (const fact of [productsFact, serviceAreaFact]) {
        if (!fact) continue;
        const parsed = JSON.parse(fact.normalizedValueJson) as unknown;
        for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
          if (typeof value !== 'string' || !value.trim()) continue;
          if (fact === productsFact) products.add(value.trim());
          else if (!serviceArea) serviceArea = value.trim();
        }
      }
    } catch {
      // 画像补齐失败不阻断富化，提示词按未知降级。
    }
    // js_ai 检索腿契约：3 个互补 query（排行榜形召回全景、口碑形召回本地同行
    // 讨论页、品牌点名形）；榜单语料混有的国际大牌由富化提示词的画像锚定与
    // 榜单警示过滤（js_ai 验证形态）。
    const areaIndustry = [serviceArea, industry].filter(Boolean).join(' ');
    const queries = areaIndustry
      ? [
          `${areaIndustry} 排行榜 十大品牌 对比`,
          `${areaIndustry} 哪家好 推荐 口碑`,
          `${context.brandName} 主要竞争对手 同行`,
        ]
      : [`${context.brandName} 主要竞争对手 同行品牌`];
    // this.keywordSearch 的非空收窄进闭包即失效，提为局部常量供逐 query 调用。
    const keywordSearch = this.keywordSearch;
    // 语料优先豆包搜索结构化召回（逐条 Title/Summary 纯检索结果、无 LLM 改写，
    // 跨 query 按 URL 去重——js_ai doubaoSearchProbe 契约）；能力缺失或全部
    // 失败时回落 enable_search 生成语料。逐 query 容错，部分失败不拖垮整轮。
    const generatedCorpus = async (): Promise<string> =>
      (await Promise.all(queries.map(async (query) => {
        try {
          return await keywordSearch.search(query, { signal });
        } catch {
          return '';
        }
      }))).join('\n');
    const searchSources = keywordSearch.searchSources;
    const searchResult =
      typeof searchSources === "function"
        ? await (async () => {
            let failed = 0;
            const results = await Promise.all(
              queries.map((query) =>
                searchSources
                  .call(keywordSearch, query, { signal })
                  .catch(() => {
                    failed += 1;
                    return [] as GeoKeywordSearchSource[];
                  }),
              ),
            );
            const seen = new Set<string>();
            const corpus: string[] = [];
            for (const sources of results) {
              for (const source of sources) {
                if (seen.has(source.url)) continue;
                seen.add(source.url);
                corpus.push(
                  [source.title, source.summary, `来源：${source.url}`]
                    .filter(Boolean)
                    .join("\n"),
                );
              }
            }
          if (corpus.length > 0) return corpus.join('\n');
          if (failed > 0) {
            // 固定码降级投影（脱敏契约同 materialLogProjection）：结构化召回
            // 调用失败时回落生成语料，可诊断但不阻断主导入。合法零结果不记。
            console.log(`[materials] ${JSON.stringify({
              operation: 'competitor-search',
              status: 'degraded',
              errorCode: 'doubao_search_unavailable',
            })}`);
          }
          return await generatedCorpus();
        })()
      : await generatedCorpus();
    if (!searchResult.trim()) {
      logOutcome({ status: 'skipped', errorCode: 'search_corpus_empty' });
      return null;
    }
    let suggestions: CompetitorSuggestion[];
    try {
      const response = await this.extraction.complete([
        { role: 'system', content: '只执行竞品结构化抽取；不要调用工具。' },
        { role: 'user', content: competitorEnrichmentPrompt({
          brandName: context.brandName,
          industry,
          products: [...products],
          serviceArea,
          knownCompetitors: [...knownDisplay.values()],
          excludedNames: [...excludedDisplay.values()],
          deficit,
          searchResult,
        }) },
      ], { signal });
      suggestions = parseCompetitorSuggestions(response, searchResult, {
        knownCompetitors,
        excludedNames,
        deficit,
      });
    } catch (error) {
      logOutcome({
        status: 'skipped',
        errorCode: error instanceof Error && error.message === 'model_response_invalid'
          ? 'model_response_invalid'
          : 'enrichment_model_failed',
      });
      return null;
    }
    if (suggestions.length === 0) {
      logOutcome({ status: 'skipped', errorCode: 'no_qualified_suggestions' });
      return null;
    }
    logOutcome({ status: 'ok', count: suggestions.length });
    return {
      field: 'competitors',
      value: suggestions.map((suggestion) => suggestion.name),
      provenance: 'inferred',
      sourceExcerpt: suggestions
        .map((suggestion) => `${suggestion.name}：${suggestion.sourceExcerpt}`)
        .join(' … ')
        .slice(0, 4_000),
      confidence: 0.5,
      scope: { kind: 'brand' },
    };
  }

  /**
   * 坏 JSON（截断/格式错误）是 provider 的瞬时输出质量问题：同一超时信号内
   * 自动重抽一次，两次都坏才落 model_response_invalid 终态。model_failed
   * （provider 调用失败）不重试，避免掩盖 provider 故障。合法输出无其他
   * 事实时仍继续联网腿并产出必审 competitors 行。
   */
  private async extractFacts(
    context: BrandMaterialContext,
    material: BrandMaterial,
    text: string,
    signal: AbortSignal,
  ): Promise<ExtractedProfileFact[]> {
    for (let attempt = 0; ; attempt += 1) {
      let response: string;
      try {
        response = await this.extraction.complete([
          { role: 'system', content: '只执行企业 Profile 结构化抽取；不要调用工具。' },
          { role: 'user', content: extractionPrompt(context, material, text) },
        ], { signal });
      } catch (cause) {
        // 保留 cause 供 process() 的故障诊断日志提取非密钥字段
        // （上游 HTTP 状态/网关业务码）；对外错误码仍是固定的 model_failed。
        throw new Error('model_failed', { cause });
      }
      try {
        return parseProfileFacts(response, context, text);
      } catch (error) {
        if (attempt === 0 && error instanceof Error && error.message === 'model_response_invalid') continue;
        throw error;
      }
    }
  }

  async process(materialId: string): Promise<MaterialProcessResult> {
    let attempt: MaterialProcessingAttempt;
    const candidateIds: string[] = [];
    try {
      attempt = await this.materialPort.begin(materialId);
    } catch (error) {
      return { ok: false, materialId, errorCode: errorCode(error) };
    }
    // 计费（票 07）：材料导入 20 点/份，最小成败单位 = 单份处理 attempt。
    // permitId 绑定 attempt：同一 attempt 的网络重试重放同一 permit；显式
    // 重试失败份是新的 attempt（上轮失败已回补）。begin 被拒（已处理/状态
    // 无效）在上面提前返回，不扣点。permit 申请失败按本份失败收尾，未取得
    // 的 permit 不回报。
    const permitId = `mat:${attempt.id}`;
    let permitAcquired = false;
    const settlePermit = async (outcome: 'success' | 'failure') => {
      if (!this.permits || !permitAcquired) return;
      await this.permits.reportUnit(permitId, 0, outcome).catch(() => undefined);
    };
    try {
      if (this.permits) {
        await this.permits.apply({
          permitId,
          operation: 'material_import',
          units: 1,
        });
        permitAcquired = true;
      }
      const [context, material, bytes] = await Promise.all([
        this.materialPort.context(),
        this.materialPort.get(materialId),
        this.materialPort.content(materialId),
      ]).catch((error) => {
        // management hop 的自由文本错误(含 content 端点的原生 fetch 异常)
        // 统一收敛为固定码,不落泛化兜底。
        if (errorCode(error) === 'material_processing_failed') {
          throw new Error('material_management_failed');
        }
        throw error;
      });
      if (context.workspaceId !== this.identity.workspaceId
        || material.workspaceId !== this.identity.workspaceId) {
        throw new Error('material_identity_mismatch');
      }
      const text = await parseBrandMaterial(material, bytes).catch((error) => {
        if (error instanceof Error && ['material_type_unsupported', 'material_empty'].includes(error.message)) throw error;
        throw new Error('material_parse_failed');
      });
      // provider 挂起的硬上限：信号到点后 fetch 中止，落入 catch 的
      // model_failed 终态，材料不会永远停在 processing。
      const extractionSignal = AbortSignal.timeout(this.extractionTimeoutMs);
      const facts = await this.extractFacts(context, material, text, extractionSignal);
      const enrichedCompetitors = await this.enrichCompetitors(context, facts, extractionSignal);
      if (enrichedCompetitors) {
        const mergeIndex = facts.findIndex(
          (fact) => fact.field === 'competitors' && fact.scope.kind === 'brand',
        );
        if (mergeIndex >= 0) {
          const base = facts[mergeIndex];
          const baseNames = Array.isArray(base.value) ? base.value : [base.value];
          facts[mergeIndex] = {
            ...base,
            ...enrichedCompetitors,
            value: [...baseNames, ...enrichedCompetitors.value as string[]],
          };
        } else {
          facts.push(enrichedCompetitors);
        }
      }
      // 竞品是排行榜的必审事实：材料未明写且联网腿无合格结果时也必须在
      // 第一张事实确认卡出现。空数组表达「当前没有可采信候选」，让用户可
      // 直接更改/补充；绝不以合作商、前东家或模型记忆凑数。
      if (
        !facts.some(
          (fact) => fact.field === "competitors" && fact.scope.kind === "brand",
        )
      ) {
        let confirmedCompetitors: string[] = [];
        try {
          const current = await this.authority.inspect({
            subject: context.brandName,
            predicate: "enterprise-profile.competitors",
            scope: { entityScope: "brand" },
          });
          const parsed = current
            ? (JSON.parse(current.normalizedValueJson) as unknown)
            : [];
          confirmedCompetitors = (Array.isArray(parsed) ? parsed : [parsed])
            .filter(
              (value): value is string =>
                typeof value === "string" && Boolean(value.trim()),
            )
            .map((value) => value.trim());
        } catch {
          // 读取失败仍产出空的必审竞品行；用户可在卡片内补充。
        }
        facts.push({
          field: "competitors",
          value: [...new Set(confirmedCompetitors)],
          provenance: "inferred",
          sourceExcerpt:
            confirmedCompetitors.length > 0
              ? "当前已确认竞品（本次材料与联网检索未发现新的合格竞品）"
              : "材料未提供明确竞品，联网检索也未获得合格候选，请用户确认并补充",
          confidence: confirmedCompetitors.length > 0 ? 1 : 0,
          scope: { kind: "brand" },
        });
      }
      const candidates: KnowledgeCandidate[] = [];
      for (const fact of facts) {
        const subject = fact.scope.kind === 'brand'
          ? context.brandName
          : `${context.brandName}/${fact.scope.productLine}`;
        let candidate: KnowledgeCandidate;
        try {
          candidate = await this.authority.propose({
            rawInput: `material:${materialId}; enterprise-profile:${fact.field}; provenance:${fact.provenance}`,
            origin: 'model-inferred',
            intent: 'knowledge-update',
            key: {
              subject,
              predicate: `enterprise-profile.${fact.field}`,
              scope: fact.scope.kind === 'brand'
                ? { entityScope: 'brand' }
                : { entityScope: 'product-line', productLine: fact.scope.productLine },
            },
            value: fact.value,
            source: {
              materialId,
              excerpt: fact.sourceExcerpt ?? '基于材料上下文的模型推断（待确认）',
              confidence: fact.confidence,
              profileProvenance: fact.provenance,
            },
          });
        } catch {
          throw new Error('knowledge_candidate_failed');
        }
        candidateIds.push(candidate.id);
        candidates.push(candidate);
      }
      const updated = await this.materialPort.finish({
        attemptId: attempt.id,
        materialId,
        status: 'awaiting-confirmation',
        candidateIds,
      });
      await settlePermit('success');
      return {
        ok: true,
        material: updated,
        candidateIds,
        candidates: candidates.map(toKnowledgeCardCandidate),
        attemptNumber: attempt.attemptNumber,
      };
    } catch (error) {
      const code = errorCode(error);
      // 所有失败码都打一条脱敏诊断（原 model_failed 特例的推广）：真实原因
      // 不再只以泛化 code 留在 DB，日志可定位计费/上游/解析层故障。
      console.log(`[materials] extract diagnostic ${JSON.stringify({
        materialId,
        errorCode: code,
        ...failureDiagnostic(error),
      })}`);
      await this.materialPort.finish({
        attemptId: attempt.id,
        materialId,
        status: 'failed',
        candidateIds,
        errorCode: code,
      }).catch(() => {});
      await settlePermit('failure');
      return { ok: false, materialId, errorCode: code };
    }
  }
}

export function safeMaterialDisplayName(sourcePath: string): string {
  return basename(sourcePath).slice(0, 180);
}
