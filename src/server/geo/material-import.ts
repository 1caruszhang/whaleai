import AdmZip from 'adm-zip';
import { basename } from 'node:path';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import * as XLSX from 'xlsx';

import {
  ENTERPRISE_PROFILE_FIELDS,
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
import type { KnowledgeAuthority, KnowledgeCandidate } from './knowledge-authority';
import type { GeoKeywordSearchCapability, GeoTextCapability } from './provider-capabilities';

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
/** ranking 陈列位 1 为本品牌、2–6 为真实竞品；竞品富化目标即这 5 家。 */
const COMPETITOR_ENRICHMENT_TARGET = 5;

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

function extractionPrompt(context: BrandMaterialContext, material: BrandMaterial, text: string): string {
  return [
    '你是企业 Profile 事实抽取器。只返回 JSON，不要 markdown。',
    `品牌：${context.brandName}`,
    `允许的产品线：${context.productLines.length > 0 ? context.productLines.join('、') : '无'}`,
    `材料名：${material.displayName}`,
    `字段：${ENTERPRISE_PROFILE_FIELDS.join(', ')}`,
    `必填字段语义保持：${REQUIRED_ENTERPRISE_PROFILE_FIELDS.join(', ')}；材料没有明确值时可以 inferred，但绝不能伪装 extracted。`,
    '竞品消歧：competitors 只收直接竞争品牌（同类可替代产品/服务的其他品牌）；合作商、供应商、经销商、上下游公司、投资或母子公司关系属于 relatedBrands，不得进入 competitors；品牌自身及其别名不得进入 competitors。',
    '来源层级：extracted=材料逐字证据（必须 sourceExcerpt）；inferred=基于上下文推断（必须待用户确认）；asked 只用于用户结构化补充，本次不得输出。',
    'scope 只能是 {"kind":"brand"} 或 {"kind":"product-line","productLine":"允许的产品线之一"}。',
    '同一字段可分别输出品牌整体值和产品线值。数组字段必须保持原子项数组，不把多个产品/客群/优势拼成一个长字符串。',
    '输出：{"facts":[{"field":"industry","value":"人工智能","provenance":"extracted","sourceExcerpt":"原文","confidence":0.95,"scope":{"kind":"brand"}}]}',
    '材料文本：',
    text,
  ].join('\n');
}

function competitorEnrichmentPrompt(input: {
  brandName: string;
  industry: string;
  knownCompetitors: string[];
  excludedNames: string[];
  deficit: number;
  searchResult: string;
}): string {
  return [
    '你是竞品事实抽取器。只返回 JSON，不要 markdown。',
    `品牌：${input.brandName}`,
    `行业：${input.industry || '未知'}`,
    `已知竞品（不得重复输出）：${input.knownCompetitors.length > 0 ? input.knownCompetitors.join('、') : '无'}`,
    `排除名称（品牌自身、别名、合作商、上下游、关联品牌，绝不能作为竞品输出）：${input.excludedNames.join('、')}`,
    `从下方检索结果中找出最多 ${input.deficit} 个真实存在的直接竞争品牌（同类可替代产品/服务）。`,
    '规则：只允许输出在检索结果文本中字面出现的公司/品牌名，检索结果未提及的不得输出；合作商、供应商、经销商、上下游公司、投资或母子公司关系不是竞品；每个名字必须给出 sourceExcerpt（检索结果中包含该名字的原文片段，不超过 200 字）；数量不足时按实际数量输出，没有则输出空数组。',
    '输出：{"competitors":[{"name":"公司名","sourceExcerpt":"原文片段"}]}',
    '检索结果：',
    input.searchResult,
  ].join('\n');
}

interface CompetitorSuggestion {
  name: string;
  sourceExcerpt: string;
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
  const haystack = searchResult.toLowerCase();
  const seen = new Set<string>();
  const suggestions: CompetitorSuggestion[] = [];
  for (const item of parsed.competitors) {
    if (suggestions.length >= limits.deficit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === 'string' ? holder.name.trim() : '';
    const sourceExcerpt = typeof holder.sourceExcerpt === 'string'
      ? holder.sourceExcerpt.trim().slice(0, 4_000)
      : '';
    if (!name || !sourceExcerpt) continue;
    const normalized = name.toLowerCase();
    // 反虚构：名字必须字面出现在检索文本中，且不与已知竞品/关联主体重复。
    if (!haystack.includes(normalized)) continue;
    if (limits.knownCompetitors.has(normalized)
      || limits.excludedNames.has(normalized)
      || seen.has(normalized)) continue;
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

function cleanValue(field: EnterpriseProfileField, input: unknown): string | string[] | null {
  if (ARRAY_PROFILE_FIELDS.has(field)) {
    const values = Array.isArray(input) ? input : [input];
    const cleaned = values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    return cleaned.length > 0 ? [...new Set(cleaned)] : null;
  }
  return typeof input === 'string' && input.trim() ? input.trim() : null;
}

export function parseProfileFacts(
  raw: string,
  context: BrandMaterialContext,
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
  return facts;
}

function errorCode(error: unknown): MaterialErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate))
    ?? 'material_processing_failed';
}

export function materialLogProjection(input: {
  operation: 'import-file' | 'import-text' | 'fetch-website' | 'parse' | 'extract' | 'propose-candidates' | 'retry';
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
    private readonly keywordSearch?: Pick<GeoKeywordSearchCapability, 'search'>,
    private readonly extractionTimeoutMs: number = DEFAULT_EXTRACTION_TIMEOUT_MS,
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
   * 失败按 independent-best-effort 静默跳过，不影响主导入结果。
   */
  private async enrichCompetitors(
    context: BrandMaterialContext,
    facts: ExtractedProfileFact[],
    signal?: AbortSignal,
  ): Promise<ExtractedProfileFact | null> {
    if (!this.keywordSearch) return null;
    const normalize = (value: string) => value.trim().toLowerCase();
    const brandCompetitors = new Set<string>();
    const knownCompetitors = new Set<string>();
    const excludedNames = new Set<string>([normalize(context.brandName)]);
    const excludedDisplay = new Map<string, string>([[normalize(context.brandName), context.brandName]]);
    const knownDisplay = new Map<string, string>();
    let industry = '';
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
    if (deficit <= 0) return null;
    let searchResult: string;
    try {
      searchResult = await this.keywordSearch.search(
        [context.brandName, industry, '主要竞争对手 同行品牌'].filter(Boolean).join(' '),
        { signal },
      );
    } catch {
      return null;
    }
    if (!searchResult.trim()) return null;
    let suggestions: CompetitorSuggestion[];
    try {
      const response = await this.extraction.complete([
        { role: 'system', content: '只执行竞品结构化抽取；不要调用工具。' },
        { role: 'user', content: competitorEnrichmentPrompt({
          brandName: context.brandName,
          industry,
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
    } catch {
      return null;
    }
    if (suggestions.length === 0) return null;
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
   * （provider 调用失败）与 no_facts_extracted（合法输出无事实）不重试，
   * 避免掩盖 provider 故障。
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
      } catch {
        throw new Error('model_failed');
      }
      try {
        return parseProfileFacts(response, context);
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
    try {
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
      if (facts.length === 0) throw new Error('no_facts_extracted');
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
      return {
        ok: true,
        material: updated,
        candidateIds,
        candidates: candidates.map(toKnowledgeCardCandidate),
        attemptNumber: attempt.attemptNumber,
      };
    } catch (error) {
      const code = errorCode(error);
      await this.materialPort.finish({
        attemptId: attempt.id,
        materialId,
        status: 'failed',
        candidateIds,
        errorCode: code,
      }).catch(() => {});
      return { ok: false, materialId, errorCode: code };
    }
  }
}

export function safeMaterialDisplayName(sourcePath: string): string {
  return basename(sourcePath).slice(0, 180);
}
