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
import type { CompetitorDisplayDetail } from '../../shared/geo/competitorDetails';
import {
  deriveServiceScope,
  resolveBrandName,
  type BrandProfile,
  type ServiceScope,
} from '../../shared/geo/profileInjection';
import { buildSsrfGuardedDispatcher, isUrlSchemeSafe } from '../utils/ssrf';
import { withAbortSignal } from '../utils/cancellation';
import { managementApi, managementApiBytes } from '../utils/management-api-client';
import { GatewayBillingError, type GeoBillingPermitPort } from './billing-permit';
import type { KnowledgeAuthority, KnowledgeCandidate } from './knowledge-authority';
import { KNOWLEDGE_EXCERPT_MAX_LENGTH } from './knowledge-authority';
import { GeoUpstreamHttpError } from './provider-capabilities';
import type {
  GeoKeywordSearchCapability,
  GeoTextCapability,
} from './provider-capabilities';

const MAX_WEBSITE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 120_000;
const MAX_REDIRECTS = 3;
const WEBSITE_TIMEOUT_MS = 15_000;
/**
 * 单次材料抽取（含竞品富化的联网检索）的硬上限。后台处理不再受
 * 代理 120s 请求超时约束，但 provider 挂起必须落回 failed 终态，不能让
 * 材料永远停在 processing。
 */
const DEFAULT_EXTRACTION_TIMEOUT_MS = 10 * 60_000;
/**
 * ranking 陈列位 1 为本品牌、2–6 为真实竞品（5 家）。第一阶段
 * 给用户最多 10 家带地域/同类业务的联网候选，留出确认与去重空间。
 */
const COMPETITOR_ENRICHMENT_TARGET = 10;

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
 * 竞品富化兜底提示词（ADR-0007）：仅当结构化召回（searchSources）不可用
 * 或返回为空时，回落到 enable_search 合并式调用——检索与结构化抽取在同一
 * 次调用内完成，无快照可比对（存在闸降级），地域闸照常执行。
 */
function competitorEnrichmentPrompt(input: {
  brandName: string;
  industry: string;
  products: string[];
  serviceArea: string;
  knownCompetitors: string[];
  excludedNames: string[];
  deficit: number;
  searchFocus: string;
}): string {
  const productText = input.products.length > 0 ? input.products.join('、') : input.industry || '目标业务';
  return [
    '你是同城竞品识别引擎，本次调用可直接联网检索。先检索，再判别，只返回 JSON，不要 markdown。',
    '',
    '## 目标品牌画像',
    `- 品牌：${input.brandName}`,
    `- 行业：${input.industry || '未知'}`,
    `- 核心产品/服务：${productText}`,
    input.serviceArea
      ? `- 服务区域：${input.serviceArea}（竞品必须在此区域或紧邻区域实体经营）`
      : '- 服务区域：未知——只取与目标品牌同城的本地机构，全国性品牌一律不取',
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
    '## 本次检索重点',
    input.searchFocus,
    '',
    `按上述重点联网检索，从检索所得中找出最多 ${input.deficit} 个真实存在的直接竞争品牌（四个条件同时满足）。`,
    '规则：只允许输出经检索确认真实存在的公司/品牌名，不得凭记忆输出检索未提及的名字；'
    + '每家必须输出 region（所在地域）、similarBusiness（与目标品牌重合的具体业务）和 sourceExcerpt'
    + '（检索所得中支撑该品牌真实存在与竞争关系的事实摘要，不超过 200 字）；'
    + '数量不足时按实际数量输出，检索不到同层级本地同行就输出空数组——宁缺毋滥，凑不够不硬凑。',
    '输出：{"competitors":[{"name":"公司名","region":"所在地域","similarBusiness":"具体同类业务","sourceExcerpt":"事实摘要"}]}',
  ].join('\n');
}

/**
 * 快照内竞品识别提示词（ADR-0007 主路径）：输入是 searchSources 的真实
 * 检索快照（纯引擎召回、不经 LLM 改写），模型只做「从语料认名字」——
 * 与材料腿「从材料文本抽 15 字段」哲学对称。名字必须逐字取自快照，
 * 存在闸（本地字符串比对）随后兜住漏网幻觉。
 */
function competitorExtractionPrompt(input: {
  brandName: string;
  industry: string;
  products: string[];
  anchor: string;
  knownCompetitors: string[];
  excludedNames: string[];
  deficit: number;
  corpus: string;
}): string {
  const productText = input.products.length > 0 ? input.products.join('、') : input.industry || '目标业务';
  return [
    '你是同城竞品识别引擎。下方是针对目标业务的真实搜索引擎结果快照（编号）。'
    + '只返回 JSON，不要 markdown。',
    '',
    '## 目标品牌画像',
    `- 品牌：${input.brandName}`,
    `- 行业：${input.industry || '未知'}`,
    `- 核心产品/服务：${productText}`,
    `- 服务区域：${input.anchor}（竞品必须在此区域或紧邻区域实体经营）`,
    '- 体量层级：按画像判断（单体门店/地方级服务商，或区域连锁）；连锁品牌按其区域层级取同层级同行。',
    '',
    '## 判别标准——四个条件必须同时满足，缺一不可',
    '1. 同体量层级：与目标品牌同层级争同一批散客；全国/跨区域连锁总部、上市集团、'
    + '上游原料/设备厂商、公立大机构、权威标杆是不同层级，不是竞品。',
    `2. 同赛道：经营与「${productText}」高度重叠的业务——看具体产品/服务，不看行业大类。`,
    `3. 同地域：在「${input.anchor}」或紧邻区域有实体经营。`,
    '4. 竞争关系：客户会拿来与目标品牌二选一比价——供应商、客户/甲方、合作方、'
    + '平台渠道（美团/抖音/新氧/小红书等）都不是竞品。',
    '',
    '## 榜单语料警示',
    '快照常混有「国家/地区 + 品牌 + 英文名」的国际品牌榜单行文（如「以色列摩雷Morel」'
    + '「美国来福Rockford Fosgate」）——这类国际/全国级设备或商品品牌与本地服务商不在同一层级，一律不取；'
    + '「选择一家靠谱的」「三大」「性价比高」等散文/品类/评价语不是企业专名，不取。',
    '',
    `已知竞品（不得重复输出）：${input.knownCompetitors.length > 0 ? input.knownCompetitors.join('、') : '无'}`,
    `排除名称（品牌自身、别名、合作商、上下游、关联品牌，绝不能作为竞品输出）：${input.excludedNames.join('、')}`,
    '',
    `只允许从下方快照文本中识别最多 ${input.deficit} 个真实存在的直接竞争品牌（四个条件同时满足），`
    + '禁止输出快照里没有出现的名字；每家输出 name（逐字取自快照原文的企业/品牌名）和 region'
    + '（快照显示的经营地域）；数量不足时按实际数量输出，快照里没有同层级本地同行就输出空数组'
    + '——宁缺毋滥，凑不够不硬凑。',
    '输出：{"competitors":[{"name":"公司名","region":"所在地域"}]}',
    '',
    '## 检索快照',
    input.corpus,
  ].join('\n');
}

interface CompetitorSuggestion extends CompetitorDisplayDetail {
  sourceExcerpt: string;
}

const MATERIAL_COMPETITOR_SIGNAL =
  "(?:竞品|竞争对手|竞争者|直接竞争|二选一|比价|对比|替代(?:方案|选项)?)";
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

/** 竞品名的唯一键口径：富化解析、已知/排除名单与 process() 合并去重共用，
 * 与 competitorDetails 的元数据按名匹配（toLocaleLowerCase('zh-CN')）一致。 */
function normalizeCompetitorKey(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

/**
 * 竞品名公共闸（两条富化路径共用）：排除名单（品牌自身/别名/关联主体）
 * 按双向子串匹配——目标品牌「九味牛」要连「成都九味牛食品」一起拦下
 * （js_ai dedupeAndFilterCompetitors 契约）；短名形近变体（错别字）由
 * isSimilarSelfName 一并拦下；已知竞品去重。
 */
function passesCompetitorNameGates(
  name: string,
  limits: {
    knownCompetitors: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
  },
): boolean {
  const normalized = normalizeCompetitorKey(name);
  if (!normalized) return false;
  if ([...limits.excludedNames].some(
    (excluded) => excluded === normalized || excluded.includes(normalized) || normalized.includes(excluded)
      || isSimilarSelfName(normalized, excluded),
  )) return false;
  return !limits.knownCompetitors.has(normalized);
}

/**
 * 地域闸（ADR-0007 代码硬闸）：候选 region 必须落在地域锚白名单内。
 * 白名单段可含「市/区/县」后缀或为「城市+区县」复合短名（如「成都新都」），
 * 双向按去后缀的包含关系比对——拦的是「武汉 vs 成都新都」级跨城错配，
 * 不做精确地理判定（同市跨区放行，紧邻语义由确认卡裁决）。
 */
function regionInServiceScope(region: string, scope: ServiceScope): boolean {
  const parts = region.split(/[，,、；;/|\s]+/).map((part) => part.trim()).filter(Boolean);
  return parts.some((part) => {
    const candidate = part.replace(/[市区县]$/, '');
    if (!candidate) return false;
    return scope.allowed.some((allowed) => {
      const anchor = allowed.replace(/[市区县]$/, '');
      if (candidate.length >= 2 && anchor.includes(candidate)) return true;
      return anchor.length >= 2 && candidate.includes(anchor);
    });
  });
}

/**
 * 快照内候选解析（主路径）：name 逐字取自快照 + region 必填；名字闸同
 * 兜底路径。存在性不在此判——本地比对快照语料是后续 enrichCompetitors
 * 的确定性闸门，构造保证 + 兜底校验双层。
 */
function parseCompetitorNames(
  raw: string,
  limits: {
    knownCompetitors: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
    deficit: number;
  },
): Array<{ name: string; region: string }> {
  const parsed = extractJsonObject(raw);
  if (!Array.isArray(parsed.competitors)) throw new Error('model_response_invalid');
  const seen = new Set<string>();
  const suggestions: Array<{ name: string; region: string }> = [];
  for (const item of parsed.competitors) {
    if (suggestions.length >= limits.deficit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === "string" ? holder.name.trim().slice(0, 60) : "";
    const region = typeof holder.region === 'string' && holder.region.trim()
      ? holder.region.trim().slice(0, 40)
      : '';
    if (!name || !region) continue;
    const normalized = normalizeCompetitorKey(name);
    if (!passesCompetitorNameGates(name, limits)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push({ name, region });
  }
  return suggestions;
}

/**
 * 兜底路径（enable_search 合并式）候选解析：结构校验（name/region/
 * similarBusiness/sourceExcerpt 齐）+ 摘录内非竞争关系排除 + 名字闸。
 * 存在闸在此路径无快照可比，明确降级（ADR-0007）。
 */
function parseCompetitorSuggestions(
  raw: string,
  limits: {
    knownCompetitors: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
    deficit: number;
  },
): CompetitorSuggestion[] {
  const parsed = extractJsonObject(raw);
  if (!Array.isArray(parsed.competitors)) throw new Error('model_response_invalid');
  const seen = new Set<string>();
  const suggestions: CompetitorSuggestion[] = [];
  for (const item of parsed.competitors) {
    if (suggestions.length >= limits.deficit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === "string" ? holder.name.trim().slice(0, 60) : "";
    const region = typeof holder.region === 'string' && holder.region.trim()
      ? holder.region.trim().slice(0, 40)
      : '';
    const similarBusiness = typeof holder.similarBusiness === 'string'
      && holder.similarBusiness.trim()
      ? holder.similarBusiness.trim().slice(0, 100)
      : '';
    const sourceExcerpt =
      typeof holder.sourceExcerpt === "string"
        ? holder.sourceExcerpt.trim().slice(0, 4_000)
        : "";
    if (!name || !region || !similarBusiness || !sourceExcerpt) continue;
    // 关系轻门：摘录里名字附近出现供应/合作/前东家等关系词的整条剔除，
    // 拦下模型把上下游改写成竞品的常见错误。
    if (namedRelation(sourceExcerpt, name, NON_COMPETITOR_RELATION)) continue;
    const normalized = normalizeCompetitorKey(name);
    if (!passesCompetitorNameGates(name, limits)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push({ name, region, similarBusiness, sourceExcerpt });
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
    private readonly keywordSearch?:
      Pick<GeoKeywordSearchCapability, 'search' | 'searchSources'>,
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
   * js_ai material-to-facts 契约的 "enrich real competitors"（ADR-0007 重写）：
   * 品牌整体竞品（本次抽取 + 已确认权威值）不足 10 家备选时联网补足。主路径
   * 为「取名于真实检索」——searchSources 纯引擎快照 ×2 → 一次普通抽取从快照
   * 认名字 → 本地双闸（存在闸：名字逐字见于快照；地域闸：region 命中地域锚
   * 白名单）；enable_search 合并式调用降级为兜底（无快照，存在闸降级）。
   * 无地域锚（serviceArea 缺失/全国类）整轮跳过，不联网。富化名一律
   * inferred（低置信），最终由确认卡裁决；与材料已抽出的竞品合并为同一条
   * 候选，避免同键多条候选顺序采纳时互相覆盖。
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
    const normalize = normalizeCompetitorKey;
    const brandCompetitors = new Set<string>();
    const knownCompetitors = new Set<string>();
    const excludedNames = new Set<string>([normalize(context.brandName)]);
    const excludedDisplay = new Map<string, string>([[normalize(context.brandName), context.brandName]]);
    const knownDisplay = new Map<string, string>();
    let industry = '';
    let serviceArea = '';
    const materialProducts = new Set<string>();
    // 身份/地址字段供 resolveBrandName 与 deriveServiceScope 消费（ADR-0007
    // 接线：查询用知识库裁决名 + 派生地域锚，不再透传脏文本/工作区名）。
    const identityValues: Record<'fullName' | 'shortNames' | 'addresses', string[]> = {
      fullName: [],
      shortNames: [],
      addresses: [],
    };
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
        if ((fact.field === 'fullName' || fact.field === 'shortNames' || fact.field === 'addresses')
          && value.trim()) {
          identityValues[fact.field].push(value.trim());
        }
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
    // 画像注入（ADR-0007 接线）：本次材料值优先，缺失时用已确认权威值补齐
    // （products/serviceArea/addresses/fullName/shortNames），供
    // resolveBrandName（查询与提示词用知识库裁决名，非工作区名）与
    // deriveServiceScope（地域锚派生，不再透传 serviceArea 脏文本）消费。
    const products = new Set<string>(materialProducts);
    const identityProfile: Record<
      'fullName' | 'shortNames' | 'addresses' | 'serviceArea',
      string[]
    > = {
      fullName: [...identityValues.fullName],
      shortNames: [...identityValues.shortNames],
      addresses: [...identityValues.addresses],
      serviceArea: serviceArea ? [serviceArea] : [],
    };
    try {
      const [
        productsFact,
        serviceAreaFact,
        addressesFact,
        fullNameFact,
        shortNamesFact,
      ] = await Promise.all([
        products.size > 0
          ? null
          : this.authority.inspect({
              subject: context.brandName,
              predicate: 'enterprise-profile.products',
              scope: { entityScope: 'brand' },
            }),
        identityProfile.serviceArea.length > 0
          ? null
          : this.authority.inspect({
              subject: context.brandName,
              predicate: 'enterprise-profile.servicearea',
              scope: { entityScope: 'brand' },
            }),
        identityProfile.addresses.length > 0
          ? null
          : this.authority.inspect({
              subject: context.brandName,
              predicate: 'enterprise-profile.addresses',
              scope: { entityScope: 'brand' },
            }),
        identityProfile.fullName.length > 0
          ? null
          : this.authority.inspect({
              subject: context.brandName,
              predicate: 'enterprise-profile.fullname',
              scope: { entityScope: 'brand' },
            }),
        identityProfile.shortNames.length > 0
          ? null
          : this.authority.inspect({
              subject: context.brandName,
              predicate: 'enterprise-profile.shortnames',
              scope: { entityScope: 'brand' },
            }),
      ]);
      const merge = (
        fact: { normalizedValueJson: string } | null,
        into: 'products' | 'serviceArea' | 'addresses' | 'fullName' | 'shortNames',
      ) => {
        if (!fact) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(fact.normalizedValueJson);
        } catch {
          return;
        }
        for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
          if (typeof value !== 'string' || !value.trim()) continue;
          if (into === 'products') products.add(value.trim());
          else if (into === 'serviceArea') identityProfile.serviceArea.push(value.trim());
          else identityProfile[into].push(value.trim());
        }
      };
      merge(productsFact, 'products');
      merge(serviceAreaFact, 'serviceArea');
      merge(addressesFact, 'addresses');
      merge(fullNameFact, 'fullName');
      merge(shortNamesFact, 'shortNames');
    } catch {
      // 画像补齐失败不阻断富化，按已有材料值降级。
    }
    const profile: BrandProfile = {
      ...(identityProfile.fullName.length > 0 ? { fullName: identityProfile.fullName } : {}),
      ...(identityProfile.shortNames.length > 0 ? { shortNames: identityProfile.shortNames } : {}),
      ...(identityProfile.addresses.length > 0 ? { addresses: identityProfile.addresses } : {}),
      ...(identityProfile.serviceArea.length > 0 ? { serviceArea: identityProfile.serviceArea } : {}),
    };
    const brandName = resolveBrandName(profile, context.brandName);
    const scope = deriveServiceScope(profile);
    if (!scope) {
      // 无锚不富化（ADR-0007）：serviceArea 缺失或「全国/线上」类声明时，
      // 联网查询必然退化为全国榜文形态，是跨城错配的主要来源——整轮跳过，
      // 不追问。卡上若无任何竞品行则以空值行被动说明原因。
      logOutcome({ status: 'skipped', errorCode: 'service_scope_missing' });
      const hasCompetitorRow = facts.some((fact) => fact.field === 'competitors')
        || brandCompetitors.size > 0;
      if (hasCompetitorRow) return null;
      return {
        field: 'competitors',
        value: [],
        provenance: 'inferred',
        sourceExcerpt:
          '服务区域未确认，竞品联网补全已跳过——请先确认服务区域，确认后可让助手补查本地竞品',
        confidence: 0,
        scope: { kind: 'brand' },
      };
    }
    // 检索查询（地域锚为硬性前缀）：排行榜形召回全景 + 口碑形召回本地同行。
    const querySubject = industry || [...products][0] || '';
    const anchorSubject = querySubject ? `${scope.primary} ${querySubject}` : scope.primary;
    const queries = [
      `${anchorSubject} 排行榜 十大品牌 对比`,
      `${anchorSubject} 哪家好 推荐 口碑 本地同行`,
    ];
    // this.keywordSearch 的非空收窄进闭包即失效，提为局部常量供逐 query 调用。
    const keywordSearch = this.keywordSearch;
    const limits = { knownCompetitors, excludedNames, deficit };
    // 提议 value 只含本次新增名称：KnowledgeAuthority propose 对数组字段做
    // 增量合并（current 在前、新增去重追加），既有权威值由该契约保住，
    // 不在待确认候选里重复呈现。材料抽出的名字在 process() 合并处加入。
    // 权威值只存名称（ADR-0007 元数据退役）：region 只出现在证据文本里。
    const buildEnrichmentFact = (
      rows: Array<{ name: string; region: string; evidence: string }>,
    ): ExtractedProfileFact => ({
      field: 'competitors',
      value: rows.map((row) => row.name),
      provenance: 'inferred',
      sourceExcerpt: rows
        .map((row) => `${row.name}（${row.region}）：${row.evidence}`)
        .join(' … ')
        .slice(0, KNOWLEDGE_EXCERPT_MAX_LENGTH),
      confidence: 0.5,
      scope: { kind: 'brand' },
    });
    // 主路径（ADR-0007）：纯引擎快照（不经 LLM 改写）→ 一次普通抽取从快照
    // 认名字 → 本地双闸。存在性由构造保证，闸门兜住抽取时的漏网幻觉。
    const searchSourcesFn = keywordSearch.searchSources?.bind(keywordSearch);
    const sourceGroups = searchSourcesFn
      ? await Promise.all(queries.map(async (query) => {
          try {
            return await searchSourcesFn(query, { signal, count: 20 });
          } catch {
            // 单 query 检索失败不拖垮另一条；两条全空则走 enable_search 兜底。
            return [];
          }
        }))
      : [];
    const sources = sourceGroups.flat();
    if (sources.length > 0) {
      const sourceTexts = sources.map((source) =>
        `${source.title} ${source.summary ?? ''}`.replace(/\s+/g, ' ').trim(),
      );
      const sourceNorms = sourceTexts.map(normalizeEvidenceText);
      const corpusNorm = sourceNorms.join('\n');
      const corpusLines = sources.slice(0, 30).map((source, index) =>
        `[${index + 1}] ${(source.summary ? `${source.title} — ${source.summary}` : source.title)
          .replace(/\s+/g, ' ').trim().slice(0, 400)}`,
      );
      let parsedNames: Array<{ name: string; region: string }> | null = null;
      for (let attempt = 0; attempt < 2 && parsedNames === null; attempt += 1) {
        let response: string;
        try {
          response = await this.extraction.complete([
            { role: 'system', content: '只执行快照内的竞品名识别；不要调用工具，不要输出快照之外的品牌。' },
            { role: 'user', content: competitorExtractionPrompt({
              brandName,
              industry,
              products: [...products],
              anchor: scope.primary,
              knownCompetitors: [...knownDisplay.values()],
              excludedNames: [...excludedDisplay.values()],
              deficit,
              corpus: corpusLines.join('\n'),
            }) },
          ], { signal, maxTokens: 2048 });
        } catch {
          break;
        }
        try {
          parsedNames = parseCompetitorNames(response, limits);
        } catch {
          // 坏 JSON 重抽一次（同 extractFacts 契约），两次都坏落 invalid。
        }
      }
      if (parsedNames === null) {
        logOutcome({ status: 'skipped', errorCode: 'model_response_invalid' });
        return null;
      }
      const suggestions: Array<{ name: string; region: string; evidence: string }> = [];
      for (const { name, region } of parsedNames) {
        if (suggestions.length >= deficit) break;
        const nameNorm = normalizeEvidenceText(name);
        if (!nameNorm || !corpusNorm.includes(nameNorm)) continue; // 存在闸
        if (!regionInServiceScope(region, scope)) continue; // 地域闸
        const matchedIndex = sourceNorms.findIndex((text) => text.includes(nameNorm));
        if (matchedIndex >= 0) {
          // 关系闸：快照里名字附近出现供应/合作/前东家等关系词的剔除。
          if (namedRelation(sourceTexts[matchedIndex], name, NON_COMPETITOR_RELATION)) continue;
        }
        suggestions.push({
          name,
          region,
          evidence: matchedIndex >= 0 ? sourceTexts[matchedIndex].slice(0, 200) : '',
        });
      }
      if (suggestions.length === 0) {
        logOutcome({ status: 'skipped', errorCode: 'no_qualified_suggestions' });
        return null;
      }
      logOutcome({ status: 'ok', count: suggestions.length });
      return buildEnrichmentFact(suggestions);
    }
    // 兜底路径（ADR-0007）：enable_search 合并式调用，检索与判别同一次完成。
    // 存在闸无快照可比（明确降级）；地域闸照常执行。
    const prompts = queries.map((focus) => competitorEnrichmentPrompt({
      brandName,
      industry,
      products: [...products],
      serviceArea: scope.primary,
      knownCompetitors: [...knownDisplay.values()],
      excludedNames: [...excludedDisplay.values()],
      deficit,
      searchFocus: focus,
    }));
    // 逐 query 容错：一条联网回答失败（检索异常或非 JSON）不拖垮另一条；
    // 两条全失败则安全回落为空竞品待用户补充，不用未验证名称硬凑。
    const responses = (await Promise.all(prompts.map(async (prompt) => {
      try {
        return await keywordSearch.search(prompt, { signal });
      } catch {
        return null;
      }
    }))).filter((response): response is string => typeof response === 'string' && response.trim().length > 0);
    if (responses.length === 0) {
      logOutcome({ status: 'skipped', errorCode: 'search_corpus_empty' });
      return null;
    }
    const suggestions: Array<{ name: string; region: string; evidence: string }> = [];
    const seen = new Set<string>();
    let invalidResponses = 0;
    for (const response of responses) {
      let parsed: CompetitorSuggestion[];
      try {
        parsed = parseCompetitorSuggestions(response, limits);
      } catch {
        invalidResponses += 1;
        continue;
      }
      for (const suggestion of parsed) {
        if (suggestions.length >= deficit) break;
        if (!regionInServiceScope(suggestion.region, scope)) continue;
        const normalized = normalizeCompetitorKey(suggestion.name);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        suggestions.push({
          name: suggestion.name,
          region: suggestion.region,
          evidence: suggestion.sourceExcerpt.slice(0, 200),
        });
      }
    }
    if (suggestions.length === 0) {
      // 全部响应都不是合法 JSON 是模型输出质量问题；有合法响应但没有
      // 过闸候选是召回为空——两者都安全回落必审行，但固定码分开。
      logOutcome({
        status: 'skipped',
        errorCode: invalidResponses === responses.length
          ? 'model_response_invalid'
          : 'no_qualified_suggestions',
      });
      return null;
    }
    logOutcome({ status: 'ok-fallback', count: suggestions.length });
    return buildEnrichmentFact(suggestions);
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
            value: [...new Map(
              [...baseNames, ...enrichedCompetitors.value as string[]]
                .map((name) => [normalizeCompetitorKey(name), name.trim()]),
            ).values()],
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
