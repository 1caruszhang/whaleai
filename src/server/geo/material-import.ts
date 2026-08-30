import AdmZip from 'adm-zip';
import { appendFileSync } from 'node:fs';
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
import {
  isMaterialImageExtension,
  type MaterialImageAsset,
  type MaterialImageCategoryCode,
} from '../../shared/geo/materialImages';
import { toKnowledgeCardCandidate } from '../../shared/geo/knowledgeCard';
import { registeredDomain } from '../../shared/geo/channelRecall';
import type { CompetitorDisplayDetail } from '../../shared/geo/competitorDetails';
import {
  deriveCompetitorScope,
  resolveBrandName,
  type BrandProfile,
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
import {
  buildImageTaggingPrompt,
  isPoolableDimensions,
  MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS,
  MATERIAL_IMAGE_MAX_TAGGABLE_BYTES,
  materialImageMediaType,
  parseImageTaggingResponse,
  probeImageDimensions,
} from './material-image';

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

/** 潜在竞品层上限（ADR-0007 两层名单）：只做排行 roster 补位与知识备查，
 * 5 家封顶足够，不占直接层的确认空间。 */
const COMPETITOR_POTENTIAL_TARGET = 5;

/**
 * 检索语料域名封顶（ADR-0007 语料多样性）：同一可注册域最多保留 3 条。
 * 张仔纪霸屏事故（2026-08-31）：40 条源里 19/20 来自 4 个软文站，单一
 * 品牌的 GEO 投放把多品牌并列的列表页/品类文挤出语料，抽取只剩 1 家可认。
 * 封顶不辨内容，只按域名分组保检索序——是通用机制，无行业词。
 */
const COMPETITOR_SOURCE_DOMAIN_CAP = 3;

/**
 * 两段式自适应触发线（ADR-0007 D7，第五写实跑裁决）：主路径两层幸存合计
 * 不足 2 家即视为语料池太薄（大概率困在自身投放软文池），触发盘点词重写
 * 换池补枪。阈值取 2 而非 5：补枪目标是「换个池子再试一次」，不是硬凑满
 * 名额——凑数仍由 fail-closed 门槛把关。
 */
const COMPETITOR_RETRY_MIN_SURVIVORS = 2;

/**
 * 正文抓取（用户裁决 2026-08-31「正文全部读取」）：品牌最密集的列表文
 * （「N 家服务商汇总」类）常被引擎摘要截断在第 1 家——常是品牌自身投放，
 * 第 2~N 家在截断线下模型不可见、存在闸也不放行。对头部源抓网页正文
 * 并进语料（复用网址导入的 SSRF 防护/重定向/类型/大小闸）。best-effort：
 * 单页失败静默跳过，不拖垮主流程。
 */
const COMPETITOR_PAGE_FETCH_LIMIT = 8;
const COMPETITOR_PAGE_TEXT_CHARS = 1_500;
const COMPETITOR_PAGE_TIMEOUT_MS = 8_000;

/** 检索源（正文抓取后）：summary 为引擎摘要，pageText 为抓取正文（已截断）。 */
type CompetitorCorpusSource = {
  title: string;
  url: string;
  summary?: string;
  pageText?: string;
};

/**
 * 竞品富化的本地诊断转储（仅显式设置 XIAOJING_DEBUG_COMPETITOR_DUMP 时
 * 生效）：把查询词、检索快照标题/摘要、抽取原始响应、闸后幸存数落到
 * 指定文件，并同步打进统一日志（`[materials-competitor-debug]` 前缀，
 * 与脱敏契约的 `[materials]` 固定码投影明确区隔）。生产不设此变量即
 * 零落盘零日志。
 */
const COMPETITOR_DEBUG_DUMP = process.env.XIAOJING_DEBUG_COMPETITOR_DUMP?.trim();
function debugDumpCompetitorSearch(record: Record<string, unknown>): void {
  if (!COMPETITOR_DEBUG_DUMP) return;
  console.log(`[materials-competitor-debug] ${JSON.stringify(record)}`);
  try {
    appendFileSync(COMPETITOR_DEBUG_DUMP, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // 诊断写盘失败不影响富化主流程。
  }
}

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
  'potentialCompetitors',
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

/** 材料图片入池写入（ADR-0008）：sha256 为跨来源唯一键，重复内容幂等跳过。 */
export interface SaveMaterialImageInput {
  sourceMaterialId: string;
  sha256: string;
  fileExt: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  description: string;
  category: MaterialImageCategoryCode;
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
    status: 'awaiting-confirmation' | 'processed' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }): Promise<BrandMaterial>;
  list(input: { materialIds?: string[]; limit?: number }): Promise<BrandMaterialListItem[]>;
  /** 材料图片候选池写入；同 sha256 已在池时返回既有条目并标记 deduplicated。 */
  saveImageAsset(input: SaveMaterialImageInput): Promise<{ id: string; deduplicated: boolean }>;
  /** 候选清单（供生成注入与预览取回消费方）。 */
  listImageAssets(input?: { limit?: number }): Promise<MaterialImageAsset[]>;
  /** 候选图片内容取回（预览换 blob 的字节源）。 */
  imageAssetContent(imageId: string): Promise<Uint8Array>;
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

/** 图片入池的脱敏 outcome（诊断日志固定码，字面量联合防拼错）。 */
type MaterialImagePoolOutcome =
  | 'pooled'
  | 'deduplicated'
  | 'tagging-unavailable'
  | 'too-large'
  | 'dimensions-unreadable'
  | 'below-min-dimension'
  | 'tagging-unparsed'
  | 'icon-decoration'
  | 'degraded';

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
    status: 'awaiting-confirmation' | 'processed' | 'failed';
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

  async saveImageAsset(input: SaveMaterialImageInput): Promise<{ id: string; deduplicated: boolean }> {
    const result = await managementApi('/api/brand-materials/images/save', 'POST', this.envelope({ ...input }));
    if (result.ok !== true) throw managementError(result);
    return result.image as { id: string; deduplicated: boolean };
  }

  async listImageAssets(input: { limit?: number } = {}): Promise<MaterialImageAsset[]> {
    const result = await managementApi('/api/brand-materials/images/list', 'POST', this.envelope(
      input.limit !== undefined ? { limit: input.limit } : {},
    ));
    if (result.ok !== true) throw managementError(result);
    return result.images as MaterialImageAsset[];
  }

  async imageAssetContent(imageId: string): Promise<Uint8Array> {
    return (await managementApiBytes(
      '/api/brand-materials/images/content',
      this.envelope({ imageId }),
      { maxBytes: 20 * 1024 * 1024, timeoutMs: 30_000 },
    )).bytes;
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
 * 竞品纪律（层级原则、纳入信号、前东家最高优先级排除、认全展示用户裁决）。
 */
function extractionPrompt(
  context: BrandMaterialContext,
  material: BrandMaterial,
  text: string,
  confirmedIndustry = '',
): string {
  return [
    '你是企业 Profile 事实抽取引擎。阅读下方材料文本，抽取该品牌的企业档案。只返回 JSON，不要 markdown。',
    `品牌：${context.brandName}`,
    `允许的产品线：${context.productLines.length > 0 ? context.productLines.join('、') : '无'}`,
    `材料名：${material.displayName}`,
    ...(confirmedIndustry
      ? [`已确认行业（先前导入经用户确认）：${confirmedIndustry}。本次 industry 必须与之一致，`
        + '除非新材料逐字写出了矛盾的行业信息（此时 provenance 标 extracted 并附原文证据）。']
      : []),
    '',
    '## 事实类字段（从材料逐字复制；材料没有就省略，不要推断）',
    '- fullName（标量）：品牌完整的注册全称。',
    '- shortNames（数组）：简称/缩写/昵称。',
    '- addresses（数组）：街道级具体地址（街道+门牌号、楼栋、楼层）；区/市/区域名不是地址。',
    '- industry（标量，必填）：两级写法「大类/细分品类」——大类用通行行业大类词'
    + '（餐饮、教育培训、汽车服务、家居建材……），细分取材料里最具体的品类词'
    + '（如「餐饮/高校食堂干蒸菜档口」「汽车服务/音响改装」）。材料只支撑到'
    + '大类时可以只写大类。禁止三类脏值：公司形态词（「XX餐饮管理有限公司」'
    + '里的「餐饮管理」是法人形态不是行业）、招商/加盟等业务模式词（行业描述'
    + '做什么，不描述怎么卖）、行业大类词单独混进细分位（「餐饮/餐饮」无意义）。'
    + '同一材料重复导入时行业取值必须稳定——按材料业务主体判，不按措辞抽样。',
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
    '- potentialCompetitors（数组）：抢同一批客户、但三同（同品类/同模式/同区域）'
    + '缺一角的潜在竞品：同品类不同区域的连锁、同区域不同品类的替代业态、'
    + '品类标杆单店（无加盟输出）等。同样只收材料明确点名的名字，禁止编造；'
    + '判不准归 potentialCompetitors 而不是 competitors（宁低勿高）。',
    '- derivedKeywords（数组）：客户可能搜索的 GEO/SEO 关键词，生成 5-15 个，一律 inferred。',
    '',
    '## 竞品检索词（顺手产出，管线瞬时值，不是事实）',
    '读完材料后写 2 条搜索引擎查询词（每条 ≤25 字、含地域），用于检索目标品牌',
    '的竞品。两条必须覆盖两个不同的语料池，不得同池近义重复：',
    '- 第 1 条以【目标客户】的口吻写需求问句——客户带着具体问题搜：目标客户是',
    '  经营者/采购方（加盟商、企业采购）→「地域 + 品类/项目 + 加盟/合作/供应商',
    '  哪家好/怎么选」；终端消费者 →「地域 + 品类 + 排行榜/哪家好/口碑」。客户',
    '  是谁由材料决定（targetCustomers 字段的判定同源），不套固定模板。这条',
    '  命中的是招商/比价类内容池。',
    '- 第 2 条以中立的行业观察者口吻写品类盘点——「地域 + 品类 + 品牌 有哪些/',
    '  盘点/名单」，不得出现加盟、招商、合作、供应商这类客户口吻词，且品类',
    '  要用品类本身的大众通用词形：去掉材料里的经营场景限定词——业务发生在',
    '  哪不等于品类叫什么（「高校食堂档口」是场景，「干蒸菜」才是品类），',
    '  行业媒体或普通顾客怎么称呼这个品类就怎么写。这条要命中的是品类分析',
    '  文章、本地探店/口碑与多品牌并列的列表页——竞品名最密集的语料；带',
    '  客户口吻或场景限定都会把检索拉回自身的招商软文池（2026-08-31 两起',
    '  事故：两条全带加盟口吻 0 召回品类品牌；「高校食堂干蒸菜品牌盘点」',
    '  仍困旧池）。',
    '',
    '## provenance、scope 与输出',
    '- extracted=材料逐字证据（必须 sourceExcerpt）；inferred=基于上下文推断（必须待用户确认）；'
    + 'asked 只用于用户结构化补充，本次不得输出。必填字段'
    + `（${REQUIRED_ENTERPRISE_PROFILE_FIELDS.join(', ')}）材料没有明确值时可以 inferred，但绝不能伪装 extracted。`,
    '- scope 只能是 {"kind":"brand"} 或 {"kind":"product-line","productLine":"允许的产品线之一"}；'
    + '同一字段可分别输出品牌整体值和产品线值。',
    '- 数组字段必须保持原子项数组，不把多个产品/客群/优势拼成一个长字符串。',
    '- 输出：{"competitorSearchQueries":["查询词1","查询词2"],'
    + '"facts":[{"field":"industry","value":"人工智能","provenance":"extracted",'
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
    + '【认全展示，用户裁决】把检索所得里所有能识别出的真实品牌全部报出来——宁可多报待用户逐项删除，'
    + '不要自我审查漏报；仍然绝对禁止：检索未提及的名字、自身与排除名单、前东家/供应商等非竞争关系。',
    '输出：{"competitors":[{"name":"公司名","region":"所在地域","similarBusiness":"具体同类业务","sourceExcerpt":"事实摘要"}]}',
  ].join('\n');
}

/**
 * 快照内竞品识别提示词（ADR-0007 主路径）：输入是 searchSources 的真实
 * 检索快照（纯引擎召回、不经 LLM 改写），模型只做「从语料认名字」——
 * 与材料腿「从材料文本抽 16 字段」哲学对称。名字必须逐字取自快照，
 * 存在闸（本地字符串比对）随后兜住漏网幻觉。
 */
function competitorExtractionPrompt(input: {
  brandName: string;
  industry: string;
  products: string[];
  targetCustomers: string[];
  customerCases: string[];
  coreAdvantages: string[];
  anchor: string;
  knownCompetitors: string[];
  excludedNames: string[];
  deficit: number;
  corpus: string;
}): string {
  const productText = input.products.length > 0 ? input.products.join('、') : input.industry || '目标业务';
  const joinLimited = (values: string[], limit: number) =>
    (values.length > 0 ? values.slice(0, limit).join('、') : '');
  return [
    '你是同城竞品识别引擎。下方是针对目标业务的真实搜索引擎结果快照（编号）。'
    + '只返回 JSON，不要 markdown。',
    '',
    '## 目标品牌画像',
    `- 品牌：${input.brandName}`,
    `- 行业：${input.industry || '未知'}`,
    `- 核心产品/服务：${productText}`,
    `- 目标客户：${joinLimited(input.targetCustomers, 4) || '未明示（从产品/案例推断）'}`,
    `- 经营场景/客户案例：${joinLimited(input.customerCases, 4) || '未明示'}`,
    `- 核心优势：${joinLimited(input.coreAdvantages, 4) || '未明示'}`,
    `- 服务区域：${input.anchor}（竞品必须在此区域或紧邻区域实体经营）`,
    '- 体量层级：按画像判断（单体门店/地方级服务商，或区域连锁）；连锁品牌按其区域层级取同层级同行。',
    '',
    '## 判别标准',
    '0.【客户口径，最先判】先从画像确定目标品牌的客户是谁（终端消费者 / 企业采购方 / '
    + '创业者·加盟商……）。竞品 = 争夺**同一批客户**预算的对手；候选服务的客户群与目标'
    + '客户群不同（例如目标客户是创业者，候选却是直接服务终端消费者的门店/品牌），无论'
    + '品类多相近都不是竞品——direct、potential 两层都不进。例：食堂档口项目输出品牌'
    + '（客户是创业者）——干蒸菜项目/加盟输出品牌才是竞品，直接服务食客的同品类餐厅不是。',
    '1. 同体量层级：与目标品牌同层级争同一批客户；全国/跨区域连锁总部、上市集团、'
    + '上游原料/设备厂商、公立大机构、权威标杆是不同层级，不是竞品。',
    `2. 同赛道：经营与「${productText}」高度重叠的业务——看具体产品/服务，不看行业大类。`,
    `3. 同地域：在「${input.anchor}」或紧邻区域有实体经营。`,
    '4. 竞争关系：客户会拿来与目标品牌二选一比价——供应商、客户/甲方、合作方、'
    + '平台渠道（美团/抖音/新氧/小红书等）都不是竞品。',
    '',
    '## 两层名单（ADR-0007）',
    '- direct（直接竞品）：四条件全部满足——同品类、同模式（加盟/档口/连锁形态一致）、'
    + '同区域，与目标品牌强竞争。',
    '- potential（潜在竞品）：抢同一批客户、但四条件缺一角——同品类不同区域的连锁、'
    + '同区域不同品类的替代业态、品类标杆单店（自身不做加盟输出）等。',
    '判不准归 potential（宁低勿高）；两层都不得输出与已知竞品/排除名单重复的名字。',
    '同名自检（输出前逐行核对）：同一品牌的不同写法——全称/简称、「（城市）」地域中缀、'
    + '「·系列/品类」尾巴、繁简体、注册名与品牌名（××餐饮管理有限公司＝××）——是同一家，'
    + '只报一次且用品类媒体最通行的叫法；同一品牌的旗下公司/子品牌/副牌/产品线/关联运营'
    + '主体也视为同一家，只报主品牌；两层之间不得同品牌重复（direct 报过的 potential 不得再报）。',
    '',
    '## 榜单语料警示',
    '快照常混有「国家/地区 + 品牌 + 英文名」的国际品牌榜单行文（如「以色列摩雷Morel」'
    + '「美国来福Rockford Fosgate」）——这类国际/全国级设备或商品品牌与本地服务商不在同一层级，一律不取；'
    + '「选择一家靠谱的」「三大」「性价比高」等散文/品类/评价语不是企业专名，不取。',
    '',
    `已知竞品（不得重复输出）：${input.knownCompetitors.length > 0 ? input.knownCompetitors.join('、') : '无'}`,
    `排除名称（品牌自身、别名、合作商、上下游、关联品牌，绝不能作为竞品输出）：${input.excludedNames.join('、')}`,
    '',
    `只允许从下方快照文本中识别：direct 最多 ${input.deficit} 个直接竞争品牌、`
    + `potential 最多 ${COMPETITOR_POTENTIAL_TARGET} 个潜在竞品，禁止输出快照里没有出现的名字；每家输出 name`
    + '（逐字取自快照原文的企业/品牌名）和 region（快照显示的经营地域）。',
    '【认全展示，用户裁决】把快照里所有能识别出的真实品牌全部报出来——分层'
    + '（direct/potential）只是你的最佳判断标签，宁可多报待用户逐项删除，不要'
    + '自我审查漏报；判不准、边缘、拿不稳的都报，报了由用户在卡片上核对来源'
    + '链接后裁决。仍然绝对禁止：快照里没有的名字（幻觉）、自身与排除名单、'
    + '前东家/供应商等非竞争关系、平台渠道、国际品牌榜单行文。',
    '输出：{"direct":[{"name":"公司名","region":"所在地域"}],'
    + '"potential":[{"name":"公司名","region":"所在地域"}]}',
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
  "(?:前东家|曾任职于|供职于|曾任|出身于|工作于|师承|合作(?:方|商|伙伴|品牌)?|战略合作|供应商|供货商|经销(?:商|品牌)?|代理(?:商|品牌)?|客户|甲方|设备品牌|仪器品牌|器材品牌|平台渠道|母公司|子公司|兄弟品牌|同集团|隶属于|投资方|旗下|子品牌|副牌|关联公司|运营主体|运营公司)";

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
  // 文本侧过一遍繁→简：候选名已归简，繁体源页（榕邊…）不做映射时
  // 名字永远匹配不上，关系闸会静默失效（放行）。
  const text = toSimplifiedChinese(excerpt);
  return new RegExp(
    `(?:${relation})${gap}${escapedName}|${escapedName}${gap}(?:${relation})`,
    "i",
  ).test(text);
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
  return toSimplifiedChinese(value).toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

/** 竞品名的唯一键口径：富化解析、已知/排除名单与 process() 合并去重共用。
 * 注意：本口径含繁→简映射（存在闸/关系闸两侧同映射）；competitorDetails
 * 存量元数据读侧的按名匹配仍是纯 toLocaleLowerCase——繁体存量名走该读侧
 * 时不做归一，属接受的存量兼容差异。 */
function normalizeCompetitorKey(value: string): string {
  // 括号段（（广州）/【旗舰】等）是注册名里的地域/系列中缀，不是品牌身份：
  // 剥离后再比对，否则「张仔纪（广州）餐饮管理有限公司」与「张仔纪餐饮
  // 管理有限公司」互不为子串，同名双份上卡（2026-08-31 第三写实跑）。
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

function toSimplifiedChinese(value: string): string {
  return value.replace(/[\u3400-\u9fff]/g, (ch) => TRADITIONAL_TO_SIMPLIFIED[ch] ?? ch);
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
 * 地域闸（城市/区县锚专用，ADR-0007）：候选 region 必须落在锚白名单内。
 * 白名单段可含「市/区/县」后缀或为「城市+区县」复合短名（如「成都新都」），
 * 双向按去后缀的包含关系比对——拦的是「武汉 vs 成都新都」级跨城错配，
 * 不做精确地理判定（同市跨区放行，紧邻语义由确认卡裁决）。
 * 省级锚（allowed 为空）不经此闸：地域相关性由抽取模型自证。
 */
function regionInServiceScope(region: string, allowed: readonly string[]): boolean {
  const parts = region.split(/[，,、；;/|\s]+/).map((part) => part.trim()).filter(Boolean);
  return parts.some((part) => {
    const candidate = part.replace(/[市区县]$/, '');
    if (!candidate) return false;
    return allowed.some((anchorRaw) => {
      const anchor = anchorRaw.replace(/[市区县]$/, '');
      if (candidate.length >= 2 && anchor.includes(candidate)) return true;
      return anchor.length >= 2 && candidate.includes(anchor);
    });
  });
}

/**
 * 快照内候选解析（主路径，ADR-0007 两层名单）：name 逐字取自快照 + region
 * 必填；名字闸同兜底路径。潜在层与直接层做跨层互斥（归一名相等或互为子串
 * 的不留双份）。存在性不在此判——本地比对快照语料是后续 enrichCompetitors
 * 的确定性闸门，构造保证 + 兜底校验双层。
 * 形状校验与兜底路径同契约：direct 数组缺失（含旧版 competitors 形态）抛
 * model_response_invalid 触发同信号内重抽一次；potential 缺失容忍为空层。
 */
function parseCompetitorNames(
  raw: string,
  limits: {
    knownCompetitors: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
    deficit: number;
    regionHints?: readonly string[];
  },
): { direct: Array<{ name: string; region: string }>; potential: Array<{ name: string; region: string }> } {
  const parsed = extractJsonObject(raw);
  if (!Array.isArray(parsed.direct)) throw new Error('model_response_invalid');
  const parseTier = (
    rows: unknown,
    cap: number,
    blockedBy: ReadonlyArray<{ name: string; region: string }> = [],
  ): Array<{ name: string; region: string }> => {
    // 层内互斥与跨层同口径：sameBrandIdentity（归一键嵌套 + ·分段交叉），
    // 同品牌多形态（注册名变体/马甲尾巴/地域前缀）只留先出现的一份。
    const seen: Array<{ name: string; region: string }> = [];
    const suggestions: Array<{ name: string; region: string }> = [];
    if (!Array.isArray(rows)) return suggestions;
    for (const item of rows) {
      if (suggestions.length >= cap) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const holder = item as Record<string, unknown>;
      // 繁体源页名归一为简体存储（存在闸比对两侧同映射，证据摘录保留原文）；
      // 存储名忠实模型原报、不做截断——「·」前的段未必是品牌（顺德·渔文乐
      // 的品牌是渔文乐），截断会把地域削成品牌名（第四写实跑教训）；
      // 描述短语（引号包裹、「相关」句式）不是品牌名，剔除。
      const name = typeof holder.name === "string"
        ? toSimplifiedChinese(holder.name.trim()).slice(0, 30)
        : "";
      const region = typeof holder.region === 'string' && holder.region.trim()
        ? holder.region.trim().slice(0, 40)
        : '';
      if (!name || !region) continue;
      if (/["“”‘’「」『』]/.test(name) || name.includes('相关')) continue;
      if (!passesCompetitorNameGates(name, limits)) continue;
      if (seen.some(
        (existing) => sameBrandIdentity(existing.name, name,
          [existing.region, region, ...(limits.regionHints ?? [])]),
      )) continue;
      // 跨层互斥：与另一层已有名字同品牌的直接丢弃。
      if (blockedBy.some(
        (blocked) => sameBrandIdentity(blocked.name, name,
          [blocked.region, region, ...(limits.regionHints ?? [])]),
      )) continue;
      seen.push({ name, region });
      suggestions.push({ name, region });
    }
    return suggestions;
  };
  const direct = parseTier(parsed.direct, limits.deficit);
  const potential = parseTier(parsed.potential, COMPETITOR_POTENTIAL_TARGET, direct);
  return { direct, potential };
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
  const seen: string[] = [];
  const suggestions: CompetitorSuggestion[] = [];
  for (const item of parsed.competitors) {
    if (suggestions.length >= limits.deficit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    // 与主路径同口径：繁体归简、描述短语（引号/「相关」句式）剔除、层内
    // 嵌套互斥；存储名忠实原报不截断（同 brandCoreName 撤销理由）。
    const name = typeof holder.name === "string"
      ? toSimplifiedChinese(holder.name.trim()).slice(0, 30)
      : "";
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
    if (/["“”‘’「」『』]/.test(name) || name.includes('相关')) continue;
    // 关系轻门：摘录里名字附近出现供应/合作/前东家等关系词的整条剔除，
    // 拦下模型把上下游改写成竞品的常见错误。
    if (namedRelation(sourceExcerpt, name, NON_COMPETITOR_RELATION)) continue;
    const normalized = normalizeCompetitorKey(name);
    if (!passesCompetitorNameGates(name, limits)) continue;
    if (seen.some(
      (existing) => existing === normalized || existing.includes(normalized) || normalized.includes(existing),
    )) continue;
    seen.push(normalized);
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
 * 材料抽取顺手产出的竞品检索词（管线瞬时值，不落库、不上卡）：模型读完
 * 材料后以【目标客户】的口吻写查询词——目标客户视角由模型从材料判定
 * （经营者→项目/加盟语料池；终端消费者→榜单/口碑语料池），代码零行业
 * 词。形状不符返回空数组，富化回落默认「品类+排行榜/口碑」形态。
 */
export function parseCompetitorSearchQueries(raw: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.competitorSearchQueries)) return [];
  return parsed.competitorSearchQueries
    .filter((query): query is string => typeof query === 'string')
    .map((query) => query.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 2);
}

/**
 * 盘点词重写提示（两段式自适应第二轮）：把「第一轮召回全是自身投放」的
 * 事实喂给模型，让它重写一条去场景、去招商的纯品类盘点查询词。反馈式
 * 重写远比首写时的抽象规则可靠（第五写实跑：首写规则约束下模型仍把
 * 「食堂」带进盘点词，整池塌回软文）。
 */
function inventoryRetryPrompt(input: {
  brandName: string;
  industry: string;
  products: string[];
  anchor: string;
  queries: readonly string[];
  corpusTitles: readonly string[];
}): string {
  return [
    '你是搜索查询词优化器。任务：为品牌竞品检索重写一条「品类盘点」查询词。',
    `品牌：${input.brandName}`,
    `行业：${input.industry || '未知'}；产品/项目：${input.products.join('、') || '未知'}；地域锚：${input.anchor}`,
    '此前查询词召回的语料标题（几乎全是目标品牌自己的投放内容，几乎没有其他品牌名）：',
    ...input.corpusTitles.map((title, index) => `${index + 1}. ${title.slice(0, 60)}`),
    `此前查询词：${input.queries.join('；')}`,
    '',
    '请写一条全新的查询词，规则：',
    '- 形态固定：「地域 + 品类 + 品牌有哪些」（或 品牌 盘点/名单）',
    '- 品类只留最核心的大众品类词：去掉经营场景词（业务发生在哪不等于品类叫什么——'
    + '食堂/档口/团餐这类场景词会把检索拉回招商软文池）、去掉招商词（加盟/招商/合作/供应商）',
    '- 与此前查询词不得相同或近义；≤25 字；地域用上面的地域锚',
    '只返回 JSON：{"query":"查询词"}',
  ].join('\n');
}

/**
 * 重写查询词解析：{"query":"…"} 取非空字符串（trim、截 60 字）；与第一轮
 * 查询相同/为空/仍带招商词（加盟/招商/合作/供应商——商务通用词，非行业
 * 词）的一律判无效返回 null，避免浪费一次补枪。纯函数。
 */
export function parseRetryQuery(raw: string, existingQueries: readonly string[]): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed.query !== 'string') return null;
  const query = parsed.query.trim().slice(0, 60);
  if (!query || query.length < 4) return null;
  if (existingQueries.some((existing) => existing === query)) return null;
  if (/加盟|招商|合作|供应商/.test(query)) return null;
  return query;
}

/**
 * 检索语料域名封顶的分组键：复用共享层 registeredDomain（可注册域近似值，
 * 子域/前缀不参与分组，com.cn 等两段公共后缀取倒数三段——后缀清单只此一
 * 份，渠道召回侧同源）。解析失败/非 URL 原样返回，退化为每条独立成组
 * （不影响封顶正确性，只少合并）。纯函数。
 */
export function sourceDomainKey(url: string): string {
  return registeredDomain(url) ?? url;
}

/** 检索语料按 URL 去重（保首现检索序）：两条查询词召回同一篇文章只算一份，
 * 不占语料名额；URL 为空/空白的源无分组意义，一并丢弃。纯函数。 */
export function dedupeSourcesByUrl<T extends { url: string }>(sources: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const source of sources) {
    const key = source.url.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(source);
  }
  return kept;
}

/**
 * 同品牌身份判定（层内/跨层互斥用）：两个名字指向同一品牌时 true。两条
 * 通道：①归一键（简体+小写+剥括号中缀）相等或互为子串——注册名变体
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
    const key = normalizeCompetitorKey(value);
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

/** 同一可注册域最多保留 cap 条（保检索序，先到先得）。cap 非正数时原样
 * 返回全量副本。纯函数，配合 dedupeSourcesByUrl 使用。 */
export function capSourcesPerDomain<T extends { url: string }>(sources: readonly T[], cap: number): T[] {
  if (!Number.isFinite(cap) || cap <= 0) return [...sources];
  const perDomain = new Map<string, number>();
  const kept: T[] = [];
  for (const source of sources) {
    const key = sourceDomainKey(source.url);
    const count = perDomain.get(key) ?? 0;
    if (count >= cap) continue;
    perDomain.set(key, count + 1);
    kept.push(source);
  }
  return kept;
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
    // 两层竞品（ADR-0007）同受自名/形近剔除——品牌自身进哪层都不是竞品。
    if (
      fact.field !== 'relatedBrands'
      && fact.field !== 'competitors'
      && fact.field !== 'potentialCompetitors'
    ) return [fact];
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
    // 两层竞品同过竞争信号/关系/交叉排除门（ADR-0007：本地闸对两层恒开）。
    if (fact.field !== "competitors" && fact.field !== "potentialCompetitors") return [fact];
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

/**
 * HTML → 纯文本（正文抓取用）：剥 script/style/noscript 块与全部标签、
 * 解码常见实体、折叠空白。品牌名是文本节点，粗糙的正则剥离足够；不需要
 * DOM（源页五花八门，构建树反而脆）。纯函数。
 */
export function textFromHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
          headers: {
            Accept: 'text/html,application/xhtml+xml,text/plain',
            // 无 UA/桌面 UA 会被部分站点回 JS 空壳或 301 到桌面壳（toutiao：
            // m. 站仅对移动 UA 下发服务端渲染正文，桌面壳正文 0 字）；移动
            // UA 对其余站点无碍——正文抓取与网址导入共用此头。
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
              + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          },
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
      Pick<GeoKeywordSearchCapability, 'search' | 'searchSources' | 'describeImage'>,
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
   * 认名字（两层名单：direct 直接竞品 + potential 潜在竞品，用户裁决
   * 2026-08-30）→ 本地双闸（存在闸：名字逐字见于快照，恒开；地域闸：城市/
   * 区县锚字符串比对，省级锚交模型自证）；enable_search 合并式调用降级为
   * 兜底（无快照，存在闸降级，仅直接层）。无地域锚（serviceArea 缺失/全国类）
   * 整轮跳过，不联网。富化名一律 inferred（低置信），最终由确认卡裁决；与
   * 材料已抽出的同字段竞品合并为同一条候选，避免同键多条候选顺序采纳时
   * 互相覆盖。
   */
  private async enrichCompetitors(
    context: BrandMaterialContext,
    facts: ExtractedProfileFact[],
    signal?: AbortSignal,
    materialQueries: readonly string[] = [],
  ): Promise<ExtractedProfileFact[]> {
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
      return [];
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
    // 客户口径画像（用户裁决 2026-08-30「一劳永逸」版）：目标客户/场景
    // 案例/核心优势注入富化提示词——竞品判别第一步「客户是谁」由这些
    // 字段回答，代码零行业词。
    const audienceProfile: Record<'targetCustomers' | 'customerCases' | 'coreAdvantages', string[]> = {
      targetCustomers: [],
      customerCases: [],
      coreAdvantages: [],
    };
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
      if (fact.scope.kind === 'brand'
        && (fact.field === 'targetCustomers' || fact.field === 'customerCases' || fact.field === 'coreAdvantages')) {
        for (const value of Array.isArray(fact.value) ? fact.value : [fact.value]) {
          if (typeof value === 'string' && value.trim()) audienceProfile[fact.field].push(value.trim());
        }
      }
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
      return [];
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
    const scope = deriveCompetitorScope(profile);
    if (!scope) {
      // 无锚不富化（ADR-0007）：serviceArea 缺失或「全国/线上」类声明时，
      // 联网查询必然退化为全国榜文形态，是跨城错配的主要来源——整轮跳过，
      // 不追问。卡上若无任何竞品行则以空值行被动说明原因。
      logOutcome({ status: 'skipped', errorCode: 'service_scope_missing' });
      const hasCompetitorRow = facts.some((fact) => fact.field === 'competitors')
        || brandCompetitors.size > 0;
      if (hasCompetitorRow) return [];
      return [{
        field: 'competitors',
        value: [],
        provenance: 'inferred',
        sourceExcerpt:
          '材料未提供可定位的服务区域，竞品联网补全已跳过——可补充服务区域后重新导入，或直接让助手补查本地竞品',
        confidence: 0,
        scope: { kind: 'brand' },
      }];
    }
    // 地域闸只在城市/区县锚（字符串可直接比对）时硬拦；省级锚（广东省等）
    // 不做省→市代码映射，地域相关性由抽取模型自证（ADR-0007 用户裁决
    // 2026-08-30）——查询锚定与提示词纪律兜底，过界候选由确认卡删除。
    // 检索查询（一劳永逸版，用户裁决 2026-08-30）：材料抽取时模型以【目标
    // 客户口吻】顺手产出的查询词优先（经营者→项目/加盟语料池；终端消费者
    // →榜单/口碑语料池，代码零行业词）；抽取未产出时回落默认形态——
    // 主语取具体产品赛道（同赛道纪律：看 products 不看 industry 大类，
    // 「餐饮管理」伞词召回百强榜全国连锁，必空手而归）。
    const querySubject = [...products][0] || industry || '';
    const anchorSubject = querySubject ? `${scope.primary} ${querySubject}` : scope.primary;
    const defaultQueries = [
      `${anchorSubject} 排行榜 十大品牌 对比`,
      `${anchorSubject} 哪家好 推荐 口碑 本地同行`,
    ];
    const queries = materialQueries.length > 0 ? [...materialQueries] : defaultQueries;
    // this.keywordSearch 的非空收窄进闭包即失效，提为局部常量供逐 query 调用。
    const keywordSearch = this.keywordSearch;
    const limits = { knownCompetitors, excludedNames, deficit,
      // 服务区锚作地域段提示：sameBrandIdentity 剔除地域段后再比分段。
      regionHints: [scope.primary, ...scope.allowed] };
    // 提议 value 只含本次新增名称：KnowledgeAuthority propose 对数组字段做
    // 增量合并（current 在前、新增去重追加），既有权威值由该契约保住，
    // 不在待确认候选里重复呈现。材料抽出的名字在 process() 合并处加入。
    // 权威值只存名称（ADR-0007 元数据退役）：region 与来源链接只出现在证据
    // 文本里——每行「名（地域）：快照（来源：<url>）」，确认卡展开可点开复核。
    const buildEnrichmentFact = (
      field: 'competitors' | 'potentialCompetitors',
      rows: Array<{ name: string; region: string; evidence: string; evidenceUrl?: string }>,
    ): ExtractedProfileFact => ({
      field,
      value: rows.map((row) => row.name),
      provenance: 'inferred',
      sourceExcerpt: rows
        .map((row) => `${row.name}（${row.region}）：${row.evidence}`
          + (row.evidenceUrl ? `（来源：${row.evidenceUrl}）` : ''))
        .join(' … ')
        .slice(0, KNOWLEDGE_EXCERPT_MAX_LENGTH),
      confidence: 0.5,
      scope: { kind: 'brand' },
    });
    // 主路径（ADR-0007）：纯引擎快照（不经 LLM 改写）→ 一次普通抽取从快照
    // 认名字 → 本地双闸。存在性由构造保证，闸门兜住抽取时的漏网幻觉。
    debugDumpCompetitorSearch({ event: 'enrich-start', queries, scope, deficit });
    const searchSourcesFn = keywordSearch.searchSources?.bind(keywordSearch);
    const sourceGroups = searchSourcesFn
      ? await Promise.all(queries.map(async (query) => {
          try {
            return await searchSourcesFn(query, { signal, count: 20 });
          } catch (error) {
            debugDumpCompetitorSearch({ event: 'search-source-failed', query, error: String(error) });
            // 单 query 检索失败不拖垮另一条；两条全空则走 enable_search 兜底。
            return [];
          }
        }))
      : [];
    // 语料多样性两步裁剪：先按 URL 去重（两条查询召回同一篇只算一份），再按
    // 可注册域封顶——防单一品牌的 GEO 投放霸屏软文站挤出列表页/品类文（张仔纪
    // 事故：19/20 同四站）。裁剪后的列表同源供给模型快照与存在闸语料。
    const sources = capSourcesPerDomain(
      dedupeSourcesByUrl(sourceGroups.flat()),
      COMPETITOR_SOURCE_DOMAIN_CAP,
    );
    debugDumpCompetitorSearch({
      event: 'sources',
      counts: sourceGroups.map((group) => group.length),
      kept: sources.length,
      sample: sources.slice(0, 20).map((source) => ({
        title: source.title,
        summary: (source.summary ?? '').slice(0, 200),
        url: source.url,
      })),
    });
    if (sources.length > 0) {
      // 正文抓取（见 COMPETITOR_PAGE_* 常量注释）：头部源抓网页正文并入
      // 语料。单页 8s 超时上限，失败/反爬/非文本一律静默跳过。
      const fetchPageTexts = async (
        targets: ReadonlyArray<{ url: string }>,
      ): Promise<Map<string, string>> => {
        const pages = new Map<string, string>();
        const settled = await Promise.allSettled(targets.map(async (target) => {
          const pageSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(COMPETITOR_PAGE_TIMEOUT_MS)])
            : AbortSignal.timeout(COMPETITOR_PAGE_TIMEOUT_MS);
          // 搜索结果常含 http:// 明文链（toutiao m. 站等），scheme 白名单只收
          // https——抓取前升级协议（绝大多数站点 https 可达或本就 301 到
          // https）；来源身份仍是引擎给的原 URL（证据链接不变）。
          const fetchUrl = target.url.replace(/^http:\/\//i, 'https://');
          const page = await fetchWebsiteMaterial(fetchUrl, this.websiteDeps, pageSignal);
          const text = textFromHtml(page.html).slice(0, COMPETITOR_PAGE_TEXT_CHARS);
          return text.length >= 40 ? ([target.url, text] as const) : null;
        }));
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) {
            pages.set(result.value[0], result.value[1]);
          }
        }
        debugDumpCompetitorSearch({
          event: 'page-fetch',
          attempted: targets.length,
          ok: pages.size,
        });
        return pages;
      };
      const withPageTexts = (
        list: ReadonlyArray<{ title: string; url: string; summary?: string }>,
        pages: ReadonlyMap<string, string>,
      ): CompetitorCorpusSource[] => list.map((source) => ({
        ...source,
        ...(pages.has(source.url) ? { pageText: pages.get(source.url) } : {}),
      }));
      const pageTexts = await fetchPageTexts(sources.slice(0, COMPETITOR_PAGE_FETCH_LIMIT));
      const corpusSources = withPageTexts(sources, pageTexts);
      // 语料上下文与抽取/闸门闭包化：两段式自适应的第二轮换池补枪时复用
      // 同一套构造与闸门，保证两轮都满足「模型可见语料 = 存在闸语料」。
      const corpusOf = (corpusSources: readonly CompetitorCorpusSource[]) => {
        const sourceTexts = corpusSources.map((source) =>
          `${source.title} ${source.summary ?? ''}`.replace(/\s+/g, ' ').trim(),
        );
        const sourceNorms = sourceTexts.map(normalizeEvidenceText);
        // 全文语料（摘要 + 抓取正文）：存在闸与命中定位用；关系闸仍用摘要
        // 文本——列表文正文满是「加盟/合作」措辞，按正文判关系会整页误杀。
        const fullNorms = corpusSources.map((source) =>
          normalizeEvidenceText(
            `${source.title} ${source.summary ?? ''} ${source.pageText ?? ''}`.replace(/\s+/g, ' ').trim(),
          ),
        );
        return {
          sourceTexts,
          sourceNorms,
          fullNorms,
          corpusNorm: fullNorms.join('\n'),
          corpusLines: corpusSources.slice(0, 30).map((source, index) =>
            `[${index + 1}] ${(source.summary ? `${source.title} — ${source.summary}` : source.title)
              .replace(/\s+/g, ' ').trim().slice(0, 400)}${source.pageText ? `｜正文：${source.pageText}` : ''}`,
          ),
        };
      };
      const extractNames = async (
        corpusLines: readonly string[],
      ): Promise<ReturnType<typeof parseCompetitorNames> | null> => {
        let parsedNames: ReturnType<typeof parseCompetitorNames> | null = null;
        for (let attempt = 0; attempt < 2 && parsedNames === null; attempt += 1) {
          let response: string;
          try {
            response = await this.extraction.complete([
              { role: 'system', content: '只执行快照内的竞品名识别；不要调用工具，不要输出快照之外的品牌。' },
              { role: 'user', content: competitorExtractionPrompt({
                brandName,
                industry,
                products: [...products],
                targetCustomers: audienceProfile.targetCustomers,
                customerCases: audienceProfile.customerCases,
                coreAdvantages: audienceProfile.coreAdvantages,
                anchor: scope.primary,
                knownCompetitors: [...knownDisplay.values()],
                excludedNames: [...excludedDisplay.values()],
                deficit,
                corpus: corpusLines.join('\n'),
              }) },
            ], { signal, maxTokens: 2048 });
            debugDumpCompetitorSearch({ event: 'extraction-response', attempt, response: response.slice(0, 4_000) });
          } catch {
            break;
          }
          try {
            parsedNames = parseCompetitorNames(response, limits);
          } catch {
            // 坏 JSON 重抽一次（同 extractFacts 契约），两次都坏落 invalid。
          }
        }
        return parsedNames;
      };
      // 两层名单走同一组本地闸（存在/关系恒开，地域闸仅城市锚）——分层是
      // 模型的语义判断（用户裁决 2026-08-30），闸门只保「名字真实出自快照」。
      const gateWith = (
        corpus: ReturnType<typeof corpusOf>,
        corpusSources: readonly CompetitorCorpusSource[],
      ) => (rows: Array<{ name: string; region: string }>, cap: number) => {
        const survivors: Array<{ name: string; region: string; evidence: string; evidenceUrl: string }> = [];
        for (const { name, region } of rows) {
          if (survivors.length >= cap) break;
          const nameNorm = normalizeEvidenceText(name);
          if (!nameNorm || !corpus.corpusNorm.includes(nameNorm)) continue; // 存在闸（全文语料）
          // 地域闸（仅城市/区县锚）：省级锚无 allowed 白名单，模型自证。
          if (scope.granularity === 'city' && !regionInServiceScope(region, scope.allowed)) continue;
          const matchedIndex = corpus.fullNorms.findIndex((text) => text.includes(nameNorm));
          if (matchedIndex >= 0) {
            // 关系闸（摘要文本）：快照摘要里名字附近出现供应/合作/前东家等
            // 关系词的剔除——正文里的招商措辞不参与，防列表文整页误杀。
            if (namedRelation(corpus.sourceTexts[matchedIndex], name, NON_COMPETITOR_RELATION)) continue;
          }
          let evidence = matchedIndex >= 0 ? corpus.sourceTexts[matchedIndex].slice(0, 200) : '';
          if (
            matchedIndex >= 0
            && !corpus.sourceNorms[matchedIndex].includes(nameNorm)
          ) {
            // 摘要里没有、只在正文里的名字：证据从正文命中处就近截取。
            const pageText = corpusSources[matchedIndex].pageText ?? '';
            const at = pageText.indexOf(name);
            if (at >= 0) {
              evidence = pageText.slice(Math.max(0, at - 40), at + 160).replace(/\s+/g, ' ').trim();
            }
          }
          survivors.push({
            name,
            region,
            evidence,
            evidenceUrl: matchedIndex >= 0 ? corpusSources[matchedIndex].url : '',
          });
        }
        return survivors;
      };

      const corpus = corpusOf(corpusSources);
      const parsedNames = await extractNames(corpus.corpusLines);
      if (parsedNames === null) {
        logOutcome({ status: 'skipped', errorCode: 'model_response_invalid' });
        return [];
      }
      const gateTier = gateWith(corpus, corpusSources);
      let directSuggestions = gateTier(parsedNames.direct, deficit);
      let potentialSuggestions = gateTier(parsedNames.potential, COMPETITOR_POTENTIAL_TARGET);

      // 两段式自适应（ADR-0007 D7，第五写实跑裁决）：模型写盘点词是非确定
      // 性的——第四写实跑「广东 干蒸菜 品牌 有哪些」换来了品类池（渔文乐/
      // 蒸简单），第五写实跑「广东食堂干蒸菜品牌有哪些」多带一个场景词整池
      // 就塌回自身投放软文、名单只剩 1 家。提示词约束不可靠，改为结果驱动：
      // 幸存不足时让模型看着「召回全是自身投放」的事实重写一条去场景/去招商
      // 的盘点词，换池补一枪；合并语料重新抽取、重新过闸，重试链路任何一步
      // 失败都保住第一轮结果。
      let usedRetry = false;
      if (
        searchSourcesFn
        && directSuggestions.length + potentialSuggestions.length < COMPETITOR_RETRY_MIN_SURVIVORS
      ) {
        try {
          const rewrite = await this.extraction.complete([
            { role: 'system', content: '只重写一条搜索查询词；只返回 JSON。' },
            { role: 'user', content: inventoryRetryPrompt({
              brandName,
              industry,
              products: [...products],
              anchor: scope.primary,
              queries,
              corpusTitles: sources.slice(0, 10).map((source) => source.title),
            }) },
          ], { signal, maxTokens: 512 });
          debugDumpCompetitorSearch({ event: 'retry-rewrite', response: rewrite.slice(0, 1_000) });
          const retryQuery = parseRetryQuery(rewrite, queries);
          if (retryQuery) {
            const retryGroup = await searchSourcesFn(retryQuery, { signal, count: 20 })
              .catch((error: unknown) => {
                debugDumpCompetitorSearch({ event: 'search-source-failed', query: retryQuery, error: String(error) });
                return [] as Array<{ title: string; url: string; summary?: string }>;
              });
            const retryPages = await fetchPageTexts(
              retryGroup.slice(0, COMPETITOR_PAGE_FETCH_LIMIT),
            );
            const mergedRaw = capSourcesPerDomain(
              dedupeSourcesByUrl([...sources, ...retryGroup]),
              COMPETITOR_SOURCE_DOMAIN_CAP,
            );
            const merged = withPageTexts(mergedRaw, retryPages).map((source) => ({
              ...source,
              ...(pageTexts.has(source.url) ? { pageText: pageTexts.get(source.url) } : {}),
            }));
            if (merged.length > sources.length) {
              debugDumpCompetitorSearch({ event: 'retry-corpus', query: retryQuery, kept: merged.length });
              const retryCorpus = corpusOf(merged);
              const retryParsed = await extractNames(retryCorpus.corpusLines);
              if (retryParsed) {
                usedRetry = true;
                const retryGate = gateWith(retryCorpus, merged);
                const retryDirect = retryGate(retryParsed.direct, deficit);
                const retryPotential = retryGate(retryParsed.potential, COMPETITOR_POTENTIAL_TARGET);
                const regionHints = [scope.primary, ...scope.allowed];
                const notSeen = (
                  row: { name: string; region: string },
                  existing: ReadonlyArray<{ name: string; region: string }>,
                ) => !existing.some(
                  (keptRow) => sameBrandIdentity(keptRow.name, row.name,
                    [keptRow.region, row.region, ...regionHints]),
                );
                directSuggestions = [
                  ...retryDirect,
                  ...directSuggestions.filter((row) => notSeen(row, retryDirect)),
                ].slice(0, deficit);
                potentialSuggestions = [
                  ...retryPotential,
                  ...potentialSuggestions.filter((row) => notSeen(row, retryPotential)),
                ].slice(0, COMPETITOR_POTENTIAL_TARGET);
              }
            }
          }
        } catch {
          // 重试链路任何失败（重写坏 JSON/检索异常/抽取失败）保第一轮结果。
        }
      }
      debugDumpCompetitorSearch({
        event: 'survivors',
        path: usedRetry ? 'retry' : 'main',
        parsedDirect: parsedNames.direct.length,
        parsedPotential: parsedNames.potential.length,
        directSurvivors: directSuggestions.map((row) => row.name),
        potentialSurvivors: potentialSuggestions.map((row) => row.name),
      });
      if (directSuggestions.length === 0 && potentialSuggestions.length === 0) {
        logOutcome({ status: 'skipped', errorCode: 'no_qualified_suggestions', path: usedRetry ? 'retry' : 'main' });
        return [];
      }
      logOutcome({
        status: 'ok',
        path: usedRetry ? 'retry' : 'main',
        count: directSuggestions.length,
        potentialCount: potentialSuggestions.length,
      });
      return [
        ...directSuggestions.length > 0 ? [buildEnrichmentFact('competitors', directSuggestions)] : [],
        ...potentialSuggestions.length > 0
          ? [buildEnrichmentFact('potentialCompetitors', potentialSuggestions)]
          : [],
      ];
    }
    // 兜底路径（ADR-0007）：enable_search 合并式调用，检索与判别同一次完成。
    // 存在闸无快照可比（明确降级）；地域闸仅城市/区县锚执行（同主路径）。
    debugDumpCompetitorSearch({ event: 'fallback-start', queries });
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
        const response = await keywordSearch.search(prompt, { signal });
        debugDumpCompetitorSearch({ event: 'fallback-response', response: response.slice(0, 4_000) });
        return response;
      } catch (error) {
        debugDumpCompetitorSearch({ event: 'fallback-failed', error: String(error) });
        return null;
      }
    }))).filter((response): response is string => typeof response === 'string' && response.trim().length > 0);
    if (responses.length === 0) {
      logOutcome({ status: 'skipped', errorCode: 'search_corpus_empty', path: 'fallback' });
      return [];
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
        if (scope.granularity === 'city'
          && !regionInServiceScope(suggestion.region, scope.allowed)) continue;
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
        path: 'fallback',
        errorCode: invalidResponses === responses.length
          ? 'model_response_invalid'
          : 'no_qualified_suggestions',
      });
      return [];
    }
    logOutcome({ status: 'ok-fallback', path: 'fallback', count: suggestions.length });
    return [buildEnrichmentFact('competitors', suggestions)];
  }

  /**
   * 坏 JSON（截断/格式错误）是 provider 的瞬时输出质量问题：同一超时信号内
   * 自动重抽一次，两次都坏才落 model_response_invalid 终态。model_failed
   * （provider 调用失败）不重试，避免掩盖 provider 故障。合法输出无其他
   * 事实时仍继续联网腿并产出必审 competitors 行。
   */
  /**
   * 已确认行业锚（行业稳定性，用户裁决 2026-08-31）：行业字段历次导入在
   * 「餐饮管理/团餐/食堂档口招商加盟」间摇摆——无锚点时模型按当次措辞抽
   * 样。用户确认过一次即锚定：后续导入的抽取提示词携带该值，材料逐字矛盾
   * 才允许推翻（推翻需 extracted 级证据）。
   */
  private async confirmedIndustry(context: BrandMaterialContext): Promise<string> {
    try {
      const current = await this.authority.inspect({
        subject: context.brandName,
        predicate: 'enterprise-profile.industry',
        scope: { entityScope: 'brand' },
      });
      if (!current) return '';
      const parsed = JSON.parse(current.normalizedValueJson) as unknown;
      const value = typeof parsed === 'string' ? parsed.trim() : '';
      return value.slice(0, 60);
    } catch {
      // 读取失败按无锚处理，不阻塞抽取。
      return '';
    }
  }

  private async extractFacts(
    context: BrandMaterialContext,
    material: BrandMaterial,
    text: string,
    signal: AbortSignal,
  ): Promise<{ facts: ExtractedProfileFact[]; competitorSearchQueries: string[] }> {
    for (let attempt = 0; ; attempt += 1) {
      let response: string;
      try {
        response = await this.extraction.complete([
          { role: 'system', content: '只执行企业 Profile 结构化抽取；不要调用工具。' },
          { role: 'user', content: extractionPrompt(context, material, text, await this.confirmedIndustry(context)) },
        ], { signal });
      } catch (cause) {
        // 保留 cause 供 process() 的故障诊断日志提取非密钥字段
        // （上游 HTTP 状态/网关业务码）；对外错误码仍是固定的 model_failed。
        throw new Error('model_failed', { cause });
      }
      try {
        // 竞品检索词与 facts 同源同响应：抽取模型已读完材料，顺手产出
        // 目标客户视角的查询词（管线瞬时值）。
        return {
          facts: parseProfileFacts(response, context, text),
          competitorSearchQueries: parseCompetitorSearchQueries(response),
        };
      } catch (error) {
        if (attempt === 0 && error instanceof Error && error.message === 'model_response_invalid') continue;
        throw error;
      }
    }
  }

  /**
   * 独立图片材料的导入终态（ADR-0008 T2）：不产出任何知识候选，材料直接
   * 落 processed。配图候选池的每一步（尺寸闸、打标、入库）失败都只影响
   * 该图是否入池，绝不把材料导入打成 failed——一次模型抖动不能卡死导入。
   */
  private async importImageMaterial(
    attempt: MaterialProcessingAttempt,
    material: BrandMaterial,
    bytes: Uint8Array,
  ): Promise<MaterialProcessResult> {
    let outcome: MaterialImagePoolOutcome = 'pooled';
    try {
      outcome = await this.poolTaggedImage(material, bytes);
    } catch (error) {
      // 打标调用/入库的异常统一按降级收尾；固定码投影与文本抽取诊断同款。
      outcome = 'degraded';
      console.log(`[materials] image diagnostic ${JSON.stringify({
        materialId: material.id,
        errorCode: errorCode(error),
      })}`);
    }
    console.log(`[materials] image-import ${JSON.stringify({
      materialId: material.id,
      outcome,
    })}`);
    const updated = await this.materialPort.finish({
      attemptId: attempt.id,
      materialId: material.id,
      status: 'processed',
      candidateIds: [],
    });
    return {
      ok: true,
      material: updated,
      candidateIds: [],
      candidates: [],
      attemptNumber: attempt.attemptNumber,
    };
  }

  /** 打标入池管线：返回脱敏 outcome；调用方只用于日志与终态，不用于分支失败。 */
  private async poolTaggedImage(material: BrandMaterial, bytes: Uint8Array): Promise<MaterialImagePoolOutcome> {
    const describeImage = this.keywordSearch?.describeImage;
    if (!describeImage) return 'tagging-unavailable';
    if (bytes.byteLength > MATERIAL_IMAGE_MAX_TAGGABLE_BYTES) return 'too-large';
    const dimensions = probeImageDimensions(bytes, material.fileExt);
    if (!dimensions) return 'dimensions-unreadable';
    if (!isPoolableDimensions(dimensions)) return 'below-min-dimension';
    const prompt = buildImageTaggingPrompt();
    // 与文本抽取同款硬上限：打标挂起到期即降级，材料不停在 processing。
    const raw = await describeImage(
      {
        system: prompt.system,
        prompt: prompt.prompt,
        bytes,
        mediaType: materialImageMediaType(material.fileExt),
      },
      { signal: AbortSignal.timeout(this.extractionTimeoutMs) },
    );
    const tag = parseImageTaggingResponse(raw);
    if (!tag) return 'tagging-unparsed';
    if (tag.category === 'icon-decoration') return 'icon-decoration';
    const saved = await this.materialPort.saveImageAsset({
      sourceMaterialId: material.id,
      sha256: material.sha256,
      fileExt: material.fileExt,
      mediaType: materialImageMediaType(material.fileExt),
      byteSize: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      description: tag.description.slice(0, MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS),
      category: tag.category,
    });
    return saved.deduplicated ? 'deduplicated' : 'pooled';
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
      // 独立图片材料（ADR-0008 T2）：跳过文本/画像抽取，直接走视觉打标
      // 入池；打标与入池的一切失败都是降级（不入池、不阻塞导入）。
      if (isMaterialImageExtension(material.fileExt)) {
        const result = await this.importImageMaterial(attempt, material, bytes);
        await settlePermit('success');
        return result;
      }
      const text = await parseBrandMaterial(material, bytes).catch((error) => {
        if (error instanceof Error && ['material_type_unsupported', 'material_empty'].includes(error.message)) throw error;
        throw new Error('material_parse_failed');
      });
      // provider 挂起的硬上限：信号到点后 fetch 中止，落入 catch 的
      // model_failed 终态，材料不会永远停在 processing。
      const extractionSignal = AbortSignal.timeout(this.extractionTimeoutMs);
      const extracted = await this.extractFacts(context, material, text, extractionSignal);
      const facts = extracted.facts;
      const enrichedCompetitors = await this.enrichCompetitors(
        context,
        facts,
        extractionSignal,
        extracted.competitorSearchQueries,
      );
      // 两层名单（competitors/potentialCompetitors）各自并入既有同字段事实：
      // 数组值按归一键去重合并（材料名在前、富化新增追加），避免同一
      // fact key 多条候选顺序采纳互相覆盖。
      for (const enriched of enrichedCompetitors) {
        const mergeIndex = facts.findIndex(
          (fact) => fact.field === enriched.field && fact.scope.kind === 'brand',
        );
        if (mergeIndex >= 0) {
          const base = facts[mergeIndex];
          const baseNames = Array.isArray(base.value) ? base.value : [base.value];
          facts[mergeIndex] = {
            ...base,
            ...enriched,
            value: [...new Map(
              [...baseNames, ...enriched.value as string[]]
                .map((name) => [normalizeCompetitorKey(name), name.trim()]),
            ).values()],
          };
        } else {
          facts.push(enriched);
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
