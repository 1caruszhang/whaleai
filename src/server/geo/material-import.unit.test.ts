import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import type { KnowledgeCandidate, KnowledgeCurrentFact, KnowledgeProposalInput } from './knowledge-authority';
import { GatewayBillingError } from './billing-permit';
import {
  MaterialImportService,
  sameBrandIdentity,
  capSourcesPerDomain,
  dedupeSourcesByUrl,
  fetchWebsiteMaterial,
  isSimilarSelfName,
  materialLogProjection,
  parseBrandMaterial,
  parseCompetitorSearchQueries,
  parseRetryQuery,
  parseProfileFacts,
  sourceDomainKey,
  type BrandMaterial,
  type BrandMaterialContext,
  type BrandMaterialPort,
  type SaveMaterialImageInput,
} from './material-import';
import { MATERIAL_IMAGE_MAX_TAGGABLE_BYTES } from './material-image';

const context: BrandMaterialContext = {
  workspaceId: 'brand-07',
  brandName: '鲸跃科技',
  productLines: ['旗舰产品'],
};

function parseTestProfileFacts(
  raw: string,
  targetContext: BrandMaterialContext = context,
  sourceText = raw,
) {
  return parseProfileFacts(raw, targetContext, sourceText);
}

function material(overrides: Partial<BrandMaterial> = {}): BrandMaterial {
  return {
    id: 'material-07',
    workspaceId: 'brand-07',
    importedBySessionId: 'session-07',
    inputKind: 'pasted-text',
    displayName: '资料.txt',
    fileExt: 'txt',
    mediaType: 'text/plain',
    relativePath: 'materials/material-07.txt',
    byteSize: 12,
    sha256: 'a'.repeat(64),
    source: { type: 'pasted-text' },
    status: 'stored',
    attemptCount: 0,
    createdAt: '2026-08-15T00:00:00Z',
    updatedAt: '2026-08-15T00:00:00Z',
    ...overrides,
  };
}

/** 最小 PNG 头（签名 + IHDR 宽高），尺寸探测只读头部。 */
function pngFixtureBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class FakeMaterialPort implements BrandMaterialPort {
  readonly trace: string[] = [];
  readonly finishes: Array<{
    attemptId: string;
    materialId: string;
    status: 'awaiting-confirmation' | 'processed' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }> = [];
  readonly materials = new Map<string, BrandMaterial>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly savedImages: SaveMaterialImageInput[] = [];
  readonly imageAssets = new Map<string, {
    id: string;
    input: SaveMaterialImageInput;
    deduplicated: boolean;
  }>();
  next = 0;
  /** saveImageAsset 抛错开关（存储故障降级用例）。 */
  failImageSave = false;

  async context() { return context; }
  async importFile(sourcePath: string) {
    this.trace.push(`store:file:${sourcePath}`);
    if (sourcePath.includes('broken')) throw new Error('material_import_failed');
    if (sourcePath.endsWith('.png') || sourcePath.endsWith('.jpg')) {
      const ext = sourcePath.split('.').at(-1) as 'png' | 'jpg';
      const item = material({
        id: `file-${++this.next}`,
        inputKind: 'file',
        displayName: '实拍.png',
        fileExt: ext,
        mediaType: ext === 'png' ? 'image/png' : 'image/jpeg',
        sha256: 'b'.repeat(64),
      });
      this.materials.set(item.id, item);
      this.bytes.set(item.id, pngFixtureBytes(800, 600));
      return item;
    }
    const item = material({ id: `file-${++this.next}`, inputKind: 'file', displayName: 'profile.md' });
    this.materials.set(item.id, item);
    this.bytes.set(item.id, new TextEncoder().encode('公司全称：鲸跃科技'));
    return item;
  }
  async importText(input: { inputKind: 'pasted-text' | 'website-url'; displayName: string; text: string; sourceUrl?: string }) {
    this.trace.push(`store:${input.inputKind}`);
    const item = material({
      id: `text-${++this.next}`,
      inputKind: input.inputKind,
      displayName: input.displayName,
      fileExt: input.inputKind === 'website-url' ? 'html' : 'txt',
      mediaType: input.inputKind === 'website-url' ? 'text/html' : 'text/plain',
    });
    this.materials.set(item.id, item);
    this.bytes.set(item.id, new TextEncoder().encode(input.text));
    return item;
  }
  async get(id: string) { return this.materials.get(id) ?? material({ id }); }
  async content(id: string) { return this.bytes.get(id) ?? new TextEncoder().encode('公司全称：鲸跃科技'); }
  async delete(id: string) {
    this.trace.push(`delete:${id}`);
    this.materials.delete(id);
    this.bytes.delete(id);
  }
  async begin(id: string) {
    this.trace.push(`begin:${id}`);
    const item = this.materials.get(id);
    if (item) item.attemptCount += 1;
    return { id: `attempt-${id}-${item?.attemptCount ?? 1}`, materialId: id, attemptNumber: item?.attemptCount ?? 1 };
  }
  async finish(input: { attemptId: string; materialId: string; status: 'awaiting-confirmation' | 'processed' | 'failed'; candidateIds: string[]; errorCode?: string }) {
    this.trace.push(`finish:${input.materialId}:${input.status}`);
    this.finishes.push(input);
    const item = this.materials.get(input.materialId) ?? material({ id: input.materialId });
    item.status = input.status;
    item.lastErrorCode = input.errorCode;
    this.materials.set(item.id, item);
    return item;
  }
  async saveImageAsset(input: SaveMaterialImageInput) {
    this.trace.push(`save-image:${input.sha256.slice(0, 8)}`);
    if (this.failImageSave) throw new Error('material_store_failed');
    this.savedImages.push(input);
    const existing = [...this.imageAssets.values()].find((asset) => asset.input.sha256 === input.sha256);
    if (existing) return { id: existing.id, deduplicated: true };
    const id = `image-${this.imageAssets.size + 1}`;
    this.imageAssets.set(id, { id, input, deduplicated: false });
    return { id, deduplicated: false };
  }
  async listImageAssets(input: { limit?: number } = {}) {
    return [...this.imageAssets.values()]
      .slice(0, input.limit ?? 100)
      .map(({ id, input: saved }) => ({
        id,
        workspaceId: 'brand-07',
        sha256: saved.sha256,
        fileExt: saved.fileExt,
        mediaType: saved.mediaType,
        byteSize: saved.byteSize,
        width: saved.width,
        height: saved.height,
        description: saved.description,
        category: saved.category,
        sourceMaterialId: saved.sourceMaterialId,
        sourceMaterialName: '实拍.png',
        relativePath: `media/images/${saved.sha256}.${saved.fileExt}`,
        createdAt: '2026-08-31T00:00:00Z',
        updatedAt: '2026-08-31T00:00:00Z',
      }));
  }
  async imageAssetContent(imageId: string) {
    const asset = this.imageAssets.get(imageId);
    if (!asset) throw new Error('material_not_found');
    return new TextEncoder().encode(JSON.stringify(asset.input));
  }
  readonly listed: BrandMaterial[] = [];
  async list(input: { materialIds?: string[]; limit?: number }) {
    const source = input.materialIds
      ? this.listed.filter((item) => input.materialIds!.includes(item.id))
      : this.listed.slice(0, input.limit ?? 10);
    return source.map((item) => ({
      material: item,
      candidateIds: this.finishes
        .filter((finish) => finish.materialId === item.id && finish.status === 'awaiting-confirmation')
        .flatMap((finish) => finish.candidateIds),
    }));
  }
}

function extractionResponse() {
  return JSON.stringify({
    facts: [
      {
        field: 'fullName',
        value: '鲸跃科技有限公司',
        provenance: 'extracted',
        sourceExcerpt: '公司全称：鲸跃科技有限公司',
        confidence: 0.96,
        scope: { kind: 'brand' },
      },
      {
        field: 'products',
        value: ['智能客服', '知识助手'],
        provenance: 'inferred',
        scope: { kind: 'product-line', productLine: '旗舰产品' },
      },
    ],
  });
}

function candidate(predicate: string, overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    id: `candidate-${predicate}`,
    workspaceId: 'brand-07',
    sessionId: 'session-07',
    key: {
      subject: '鲸跃科技',
      predicate,
      scopeJson: '{}',
      effectiveFrom: null,
      effectiveTo: null,
      identity: `brand|${predicate}|{}||`,
    },
    valueJson: '"鲸跃科技"',
    normalizedValueJson: '"鲸跃科技"',
    unit: null,
    source: { materialId: 'material-07', excerpt: '公司全称：鲸跃科技有限公司', confidence: 0.9 },
    origin: 'model-inferred',
    intent: 'knowledge-update',
    status: 'awaiting-confirmation',
    baseVersion: 0,
    proposedAt: '2026-08-15T00:00:00Z',
    current: null,
    ...overrides,
  };
}

function service(port: FakeMaterialPort, overrides: {
  complete?: () => Promise<string>;
  /** 依次返回的模型响应（先 profile 抽取，再竞品富化抽取）；耗尽后回落 complete。 */
  completeResponses?: string[];
  fetch?: typeof fetch;
  propose?: (input: KnowledgeProposalInput) => Promise<KnowledgeCandidate>;
  inspect?: (key: { subject: string; predicate: string }) => Promise<KnowledgeCurrentFact | null>;
  search?: (prompt: string) => Promise<string>;
  /** 豆包搜索结构化召回（js_ai doubaoSearchProbe 形态）。 */
  searchSources?: (
    query: string,
    options?: { signal?: AbortSignal; count?: number },
  ) => Promise<Array<{ title: string; url: string; summary?: string }>>;
  /** 材料图片视觉打标（lite image_url 调用的 fake）。 */
  describeImage?: (
    input: { system: string; prompt: string; bytes: Uint8Array; mediaType: string },
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
  /** 缩短抽取硬上限，验证 provider 挂起会落回 failed 终态。 */
  extractionTimeoutMs?: number;
} = {}) {
  const fallback = vi.fn(overrides.complete ?? (async () => extractionResponse()));
  let queueIndex = 0;
  const complete = vi.fn(async (...args: Parameters<typeof fallback>) => {
    if (overrides.completeResponses && queueIndex < overrides.completeResponses.length) {
      const response = overrides.completeResponses[queueIndex];
      queueIndex += 1;
      return response;
    }
    return fallback(...args);
  });
  const propose = vi.fn(overrides.propose ?? (async (input: KnowledgeProposalInput) => (
    candidate(input.key.predicate)
  )));
  const inspect = vi.fn(overrides.inspect ?? (async () => null));
  const searchSources = overrides.searchSources ? vi.fn(overrides.searchSources) : undefined;
  const describeImage = overrides.describeImage ? vi.fn(overrides.describeImage) : undefined;
  // 结构化召回/打标可用性测试需要断言「生成语料未被调用」，兜底 spy 同时暴露到返回对象。
  const search = overrides.search
    ? vi.fn(overrides.search)
    : (searchSources || describeImage)
      ? vi.fn(async () => { throw new Error('generated search unavailable'); })
      : undefined;
  const capability = search || searchSources || describeImage
    ? {
      search: search!,
      ...(searchSources ? { searchSources } : {}),
      ...(describeImage ? { describeImage } : {}),
    }
    : undefined;
  return {
    complete,
    propose,
    inspect,
    search,
    searchSources,
    describeImage,
    value: new MaterialImportService(
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      port,
      { slot: 'extraction', complete },
      { propose, inspect },
      overrides.fetch ? { fetch: overrides.fetch, dispatcherFor: async () => undefined } : {},
      capability,
      overrides.extractionTimeoutMs,
    ),
  };
}

describe('MaterialImportService', () => {
  it('stores pasted text before extraction and routes every fact through KnowledgeAuthority with brand/product-line scope', async () => {
    const port = new FakeMaterialPort();
    const current = service(port);
    const result = await current.value.importPastedText('公司全称：鲸跃科技有限公司');

    expect(result.ok).toBe(true);
    expect(port.trace[0]).toBe('store:pasted-text');
    expect(port.trace[1]).toMatch(/^begin:text-/);
    expect(current.propose).toHaveBeenCalledTimes(3);
    expect(current.propose.mock.calls[0][0]).toMatchObject({
      origin: 'model-inferred',
      intent: 'knowledge-update',
      key: {
        subject: '鲸跃科技',
        predicate: 'enterprise-profile.fullName',
        scope: { entityScope: 'brand' },
      },
      rawInput: expect.not.stringContaining('公司全称：鲸跃科技有限公司'),
      source: {
        excerpt: '公司全称：鲸跃科技有限公司',
        confidence: 0.96,
        profileProvenance: 'extracted',
      },
    });
    expect(current.propose.mock.calls[1][0]).toMatchObject({
      key: {
        subject: '鲸跃科技/旗舰产品',
        predicate: 'enterprise-profile.products',
        scope: { entityScope: 'product-line', productLine: '旗舰产品' },
      },
      source: {
        excerpt: '基于材料上下文的模型推断（待确认）',
        profileProvenance: 'inferred',
      },
    });
    // 成功结果携带卡片裁决所需的候选投影（ADR-0001 批量确认卡）。
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.candidateIds).toEqual([
      "candidate-enterprise-profile.fullName",
      "candidate-enterprise-profile.products",
      "candidate-enterprise-profile.competitors",
    ]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates?.[0]).toMatchObject({
      id: 'candidate-enterprise-profile.fullName',
      workspaceId: 'brand-07',
      sessionId: 'session-07',
      status: 'awaiting-confirmation',
      key: { subject: '鲸跃科技', predicate: 'enterprise-profile.fullName' },
      source: { materialId: 'material-07', confidence: 0.9 },
      current: null,
    });
  });

  it('isolates a failed file and retries only the selected material', async () => {
    const port = new FakeMaterialPort();
    const current = service(port);
    const imported = await current.value.importFiles(['/picked/broken.pdf', '/picked/profile.md']);
    expect(imported).toHaveLength(2);
    expect(imported[0]).toEqual({ ok: false, errorCode: 'material_import_failed' });
    expect(imported[1].ok).toBe(true);
    const success = imported[1];
    if (!success.ok) throw new Error('expected success');

    port.trace.length = 0;
    const retried = await current.value.process(success.material.id);
    expect(retried.ok).toBe(true);
    expect(port.trace).toEqual([
      `begin:${success.material.id}`,
      `finish:${success.material.id}:awaiting-confirmation`,
    ]);
  });

  it('marks the material failed when extraction hangs past its hard timeout instead of staying processing', async () => {
    const port = new FakeMaterialPort();
    const complete = vi.fn(
      (_messages: readonly { role: string; content: string }[], options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          // 真实能力在 fetch 上响应 abort；fake 同样只在信号触发时落败。
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const propose = vi.fn(async (input: KnowledgeProposalInput) => candidate(input.key.predicate));
    const hung = new MaterialImportService(
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      port,
      { slot: 'extraction', complete },
      { propose, inspect: async () => null },
      {},
      undefined,
      25,
    );
    const stored = await port.importText({
      inputKind: 'pasted-text',
      displayName: '挂起材料.txt',
      text: '公司资料',
    });

    const result = await hung.process(stored.id);

    expect(result).toEqual({ ok: false, materialId: stored.id, errorCode: 'model_failed' });
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(propose).not.toHaveBeenCalled();
    expect(port.finishes.at(-1)).toMatchObject({
      materialId: stored.id,
      status: 'failed',
      errorCode: 'model_failed',
    });
  });

  it('marks only the current material failed when the extraction model fails', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, { complete: async () => { throw new Error('secret body'); } });
    const result = await current.value.importPastedText('公司资料');
    expect(result).toMatchObject({ ok: false, errorCode: 'model_failed' });
    expect(port.trace.at(-1)).toMatch(/finish:text-1:failed/);
  });

  // 回归：带内层花括号的截断 JSON 曾让 JSON.parse 的原生 SyntaxError 落入
  // material_processing_failed 泛化兜底，掩盖了真实原因。
  it('maps a braced but unparseable model response to model_response_invalid after one retry', async () => {
    const port = new FakeMaterialPort();
    const truncated = '{"facts": [{"field": "industry", "value": "医美诊所"';
    const current = service(port, { completeResponses: [truncated, truncated] });
    const result = await current.value.importPastedText('公司资料');

    expect(result).toEqual({ ok: false, materialId: 'text-1', errorCode: 'model_response_invalid' });
    expect(current.complete).toHaveBeenCalledTimes(2);
    expect(port.finishes.at(-1)).toMatchObject({
      materialId: 'text-1',
      status: 'failed',
      errorCode: 'model_response_invalid',
    });
  });

  it('recovers with one automatic re-extraction when the first response is unparseable', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: ['{"facts": [{"field": "industry", "value": "医美诊所"', extractionResponse()],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.complete).toHaveBeenCalledTimes(2);
    expect(current.propose).toHaveBeenCalled();
  });

  it('maps free-form management hop failures to material_management_failed', async () => {
    class UnreachableContextPort extends FakeMaterialPort {
      override async context(): Promise<BrandMaterialContext> {
        throw new Error('Management API unreachable: fetch failed');
      }
    }
    const port = new UnreachableContextPort();
    const current = service(port);
    const stored = await port.importText({
      inputKind: 'pasted-text',
      displayName: '资料.txt',
      text: '公司资料',
    });

    const result = await current.value.process(stored.id);

    expect(result).toEqual({ ok: false, materialId: stored.id, errorCode: 'material_management_failed' });
    expect(current.complete).not.toHaveBeenCalled();
  });

  it('records candidates already proposed when a later candidate fails', async () => {
    const port = new FakeMaterialPort();
    let calls = 0;
    const current = service(port, {
      propose: async (input) => {
        calls += 1;
        if (calls === 2) throw new Error('authority unavailable');
        return candidate(input.key.predicate);
      },
    });

    const result = await current.value.importPastedText('公司资料');

    expect(result).toMatchObject({ ok: false, errorCode: 'knowledge_candidate_failed' });
    expect(port.finishes.at(-1)).toMatchObject({
      status: 'failed',
      candidateIds: ['candidate-enterprise-profile.fullName'],
    });
  });

  it('rejects a material projection from another brand before parsing or extraction', async () => {
    const port = new FakeMaterialPort();
    const foreign = material({ id: 'foreign', workspaceId: 'brand-other' });
    port.materials.set(foreign.id, foreign);
    port.bytes.set(foreign.id, new TextEncoder().encode('private foreign brand body'));
    const current = service(port);

    await expect(current.value.process('foreign')).resolves.toEqual({
      ok: false,
      materialId: 'foreign',
      errorCode: 'material_identity_mismatch',
    });
    expect(current.complete).not.toHaveBeenCalled();
    expect(current.propose).not.toHaveBeenCalled();
  });

  it('supports a fake-fetched website without real network and stores raw HTML first', async () => {
    const port = new FakeMaterialPort();
    const fetch = vi.fn(async () => new Response('<html><body>鲸跃科技</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const current = service(port, { fetch: fetch as typeof globalThis.fetch });
    const result = await current.value.importWebsite('https://brand.example/about');
    expect(result.ok).toBe(true);
    expect(port.trace[0]).toBe('store:website-url');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("competitor enrichment (ADR-0007 source-grounded extraction)", () => {
  const withAreaResponse = JSON.stringify({ facts: [
    { field: 'industry', value: '智能客服', provenance: 'extracted', sourceExcerpt: '行业：智能客服' },
    { field: 'serviceArea', value: '成都新都', provenance: 'extracted', sourceExcerpt: '服务成都新都' },
  ] });
  const corpus = [
    {
      title: '新都智能客服公司排行榜',
      url: 'https://example.com/rank',
      summary: '成都新都智能客服十大品牌：云帆信息口碑靠前，星河智能位列第二',
    },
    {
      title: '新都智能客服哪家好',
      url: 'https://example.com/qa',
      summary: '本地人选智能客服，云帆信息与星河智能常被拿来对比',
    },
  ];
  const namesJson = JSON.stringify({ direct: [
    { name: '云帆信息', region: '成都新都' },
    { name: '星河智能', region: '成都' },
  ] });

  function competitorsCallOf(current: ReturnType<typeof service>) {
    return current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
  }

  it('extracts competitor names from real search snippets and proposes a names-only inferred candidate', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, namesJson],
      searchSources: async () => corpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 主路径：2 次互补检索（排行榜形 + 口碑形），地域锚为硬性前缀。
    expect(current.searchSources).toHaveBeenCalledTimes(2);
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries[0]).toContain('成都新都 智能客服 排行榜');
    expect(queries[1]).toContain('成都新都 智能客服 哪家好');
    // 两次模型调用：主 profile 抽取 + 快照内认名字（合并式不变式翻转）。
    expect(current.complete).toHaveBeenCalledTimes(2);
    expect(current.search).not.toHaveBeenCalled();
    const competitorsCall = competitorsCallOf(current);
    expect(competitorsCall).toBeTruthy();
    expect(competitorsCall?.[0]).toMatchObject({
      value: ['云帆信息', '星河智能'],
      source: { profileProvenance: 'inferred' },
    });
    // ADR-0007 元数据退役：摘录是纯证据文本（名（地域）：快照），无审计头。
    expect(competitorsCall?.[0].source.excerpt).toContain('云帆信息（成都新都）：');
    expect(competitorsCall?.[0].source.excerpt).toContain('星河智能（成都）：');
    expect(competitorsCall?.[0].source.excerpt).not.toContain('xiaojing-competitor-details');
  });

  it('existence gate drops names that do not appear verbatim in any snippet', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '成都新都' },
        { name: '凭空科技', region: '成都新都' },
      ] })],
      searchSources: async () => corpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 抽取模型漏网的幻觉名（快照里没有）被本地存在闸拦下。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('region gate drops out-of-scope candidates even when they exist in snippets', async () => {
    const port = new FakeMaterialPort();
    const corpusWithWuhan = [...corpus, {
      title: '武汉智能客服排行榜',
      url: 'https://example.com/wuhan',
      summary: '武汉智能客服十大品牌：武汉楚才科技排名第一',
    }];
    const current = service(port, {
      completeResponses: [withAreaResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '成都新都' },
        { name: '武汉楚才科技', region: '武汉' },
      ] })],
      searchSources: async () => corpusWithWuhan,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 跨城候选真实存在（存在闸放行）但不在地域锚白名单内，被地域闸剔除。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('province-level service areas anchor the search and leave region relevance to the model', async () => {
    // 炊班主事故回归 + ADR-0007 用户裁决 2026-08-30：省级锚（广东省）不再
    // 整轮跳过；地域相关性由抽取模型自证，代码不做省→市映射——深圳/广州
    // 候选不经字符串地域闸直接进卡，过界者由确认卡逐行删除兜底。
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '智能客服', provenance: 'extracted', sourceExcerpt: '行业：智能客服' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const provinceCorpus = [
      {
        title: '广东智能客服公司排行榜',
        url: 'https://example.com/gd-rank',
        summary: '广东智能客服十大品牌：云帆信息（深圳）口碑靠前，星河智能（广州）位列第二',
      },
    ];
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '深圳' },
        { name: '星河智能', region: '广州' },
      ] })],
      searchSources: async () => provinceCorpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.searchSources).toHaveBeenCalledTimes(2);
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries[0]).toContain('广东 智能客服 排行榜');
    expect(queries[1]).toContain('广东 智能客服 哪家好');
    // 省级锚 allowed 为空：存在闸照常（名字逐字见于快照），地域闸不拦。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息', '星河智能']);
    expect(competitorsCallOf(current)?.[0].source.excerpt).toContain('云帆信息（深圳）：');
  });

  it('builds queries from the concrete product track, not the industry umbrella (炊班主 recall regression)', async () => {
    // 行业伞词（餐饮管理）召回百强榜全国连锁，与档口加盟不同赛道——查询
    // 主语必须取具体产品（同赛道纪律），否则抽取按宁缺毋滥必然空手。
    const trackResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业：餐饮管理' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
      { field: 'products', value: ['干蒸菜档口项目'], provenance: 'extracted', sourceExcerpt: '核心项目：干蒸菜档口' },
    ] });
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [trackResponse, JSON.stringify({ direct: [
        { name: '张仔纪', region: '广州' },
      ] })],
      searchSources: async () => [{
        title: '广东干蒸菜加盟品牌甄选',
        url: 'https://example.com/gz-rank',
        summary: '张仔纪（广州）餐饮管理有限公司以顺德干蒸技艺位居榜首',
      }],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries[0]).toContain('广东 干蒸菜档口项目 排行榜');
    expect(queries[0]).not.toContain('餐饮管理');
    expect(competitorsCallOf(current)?.[0].value).toEqual(['张仔纪']);
  });

  it('proposes a separate potential-competitor fact alongside the direct roster (ADR-0007 two tiers)', async () => {
    // 两层名单（省级锚场景）：direct 三同全中；potential 抢同一批客户但
    // 缺一角（同品类不同区域/替代业态）。两层同过存在/关系闸；跨层重复名
    // （星河智能）只留直接层一份。省级锚无字符串地域闸——「省外连锁品牌
    // （重庆）」这类同品类跨区域潜在竞品正是要留给排行补位的形态。
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [JSON.stringify({ facts: [
        { field: 'industry', value: '智能客服', provenance: 'extracted', sourceExcerpt: '行业：智能客服' },
        { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
      ] }), JSON.stringify({
        direct: [
          { name: '云帆信息', region: '深圳' },
          { name: '星河智能', region: '广州' },
        ],
        potential: [
          { name: '星河智能', region: '广州' },
          { name: '省外连锁品牌', region: '重庆' },
          { name: '替代业态品牌', region: '深圳' },
        ],
      })],
      searchSources: async () => [
        {
          title: '广东智能客服公司排行榜',
          url: 'https://example.com/gd-rank',
          summary: '云帆信息（深圳）与星河智能（广州）位居前列',
        },
        {
          title: '重庆同类项目排行',
          url: 'https://example.com/cq',
          summary: '省外连锁品牌在重庆开出多家同类档口',
        },
        {
          title: '深圳替代业态',
          url: 'https://example.com/alt',
          summary: '替代业态品牌以相邻品类经营深圳社区店',
        },
      ],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // propose 入口 predicate 保留 camelCase（大小写归一在 Authority 内做）。
    const tierCall = (predicate: string) => current.propose.mock.calls.find(
      ([input]) => input.key.predicate.toLowerCase() === predicate,
    );
    expect(tierCall('enterprise-profile.competitors')?.[0].value)
      .toEqual(['云帆信息', '星河智能']);
    // 跨层互斥：星河智能已在直接层，潜在层不再重复。
    const potential = tierCall('enterprise-profile.potentialcompetitors');
    expect(potential?.[0].value).toEqual(['省外连锁品牌', '替代业态品牌']);
    expect(potential?.[0].source.excerpt).toContain('省外连锁品牌（重庆）：');
    expect(potential?.[0].source.profileProvenance).toBe('inferred');
  });

  it('prefers the model-authored customer-voice queries from the material extraction (一劳永逸版)', async () => {
    // 材料抽取顺手产出 competitorSearchQueries：富化直接使用（双池：第 1 条
    // 客户口吻、第 2 条中立盘点口吻），代码零行业词；不再拼默认形态。
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [JSON.stringify({
        competitorSearchQueries: ['广东 干蒸菜 食堂档口项目 加盟', '广东 干蒸菜 品牌 有哪些'],
        facts: [
          { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业' },
          { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
        ],
      }), JSON.stringify({ direct: [
        { name: '张仔纪', region: '广州' },
      ], potential: [] })],
      searchSources: async () => [{
        title: '广东干蒸菜项目加盟甄选',
        url: 'https://example.com/jm',
        summary: '张仔纪以标准化干蒸技术输出位居加盟口碑榜首',
      }],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries).toEqual([
      '广东 干蒸菜 食堂档口项目 加盟',
      '广东 干蒸菜 品牌 有哪些',
    ]);
    expect(queries[0]).not.toContain('排行榜');
  });

  it('caps sources per registrable domain so one advertorial mill cannot crowd out the corpus', async () => {
    // 张仔纪霸屏回归（2026-08-31 真实运行：40 条源里 19/20 来自 4 个软文站，
    // 9 条点名张仔纪、5 条是品牌自己投放）：同一可注册域最多 3 条，先按 URL
    // 去重再保序封顶；被挤出语料的名字过不了存在闸——存在闸语料与模型可见
    // 语料同源，两条腿看到的是同一份裁剪结果。
    const millCorpus = [1, 2, 3, 4].map((n) => ({
      title: `干蒸菜加盟测评${n}`,
      url: `https://m-mill.com/article-${n}`,
      summary: `干蒸菜加盟对比第${n}篇：品牌${
        ['云帆信息', '星河智能', '江澜数据', '泓川软件'][n - 1]
      }口碑居前`,
    }));
    const listCorpus = [{
      title: '干蒸菜品牌有哪些',
      url: 'https://example.org/list',
      summary: '干蒸菜品牌盘点：泽言网络与恒启智联均在列',
    }];
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '成都新都' },
        { name: '星河智能', region: '成都' },
        { name: '江澜数据', region: '成都' },
        { name: '泓川软件', region: '成都' },
        { name: '泽言网络', region: '成都新都' },
      ], potential: [] })],
      searchSources: async () => [...millCorpus, ...listCorpus],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 第 4 条同域软文被挤出语料：只出现在其中的泓川软件过不了存在闸；
    // 其他域的列表页品牌（泽言网络）保留。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息', '星河智能', '江澜数据', '泽言网络']);
    const snapshotPrompt = (current.complete.mock.calls[1] as unknown as [
      readonly { role: string; content: string }[],
    ])[0][1].content;
    expect(snapshotPrompt).not.toContain('泓川软件');
    expect(snapshotPrompt).toContain('泽言网络');
  });

  it('collapses same-brand disguises across tiers and cites the matched source URL (马甲回归 2026-08-31)', async () => {
    // 张仔纪实跑回归：直接层收了探店帖马甲「张仔纪·老顺德干蒸菜」，潜在层又
    // 收了软文马甲「张仔纪干蒸菜」——跨层互斥因子串互不包含没拦住，同品牌
    // 双份上卡；「·」首段归一后两个马甲同核「张仔纪」，潜在层被拦。证据行
    // 带命中源 URL，确认卡展开可直接点开复核。
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业：餐饮管理' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const disguiseCorpus = [
      {
        title: '广州干蒸菜探店',
        url: 'https://weitoutiao.example/store-review',
        summary: '终于吃上了张仔纪·老顺德干蒸菜（金菊路店），十几块一碟白饭任装',
      },
      {
        title: '干蒸菜加盟品牌盘点',
        url: 'https://mill.example/jm-list',
        summary: '张仔纪干蒸菜与蒸武门·广式蒸饭均入选品牌名录，面向创业者输出',
      },
    ];
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({
        direct: [{ name: '张仔纪·老顺德干蒸菜', region: '广州' }],
        potential: [
          { name: '张仔纪干蒸菜', region: '广东' },
          { name: '蒸武门·广式蒸饭', region: '广东' },
        ],
      })],
      searchSources: async () => disguiseCorpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 存储名忠实原报不截断；马甲同品牌由分段交叉归一识别（共享「张仔纪」
    // 段），跨层互斥拦下潜在层的张仔纪马甲。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['张仔纪·老顺德干蒸菜']);
    const potential = current.propose.mock.calls.find(
      ([input]) => input.key.predicate.toLowerCase() === 'enterprise-profile.potentialcompetitors',
    );
    expect(potential?.[0].value).toEqual(['蒸武门·广式蒸饭']);
    // 证据行带命中源 URL：直接层命中探店帖源。
    expect(competitorsCallOf(current)?.[0].source.excerpt).toContain('（来源：https://weitoutiao.example/store-review）');
    expect(potential?.[0].source.excerpt).toContain('（来源：https://mill.example/jm-list）');
  });

  it('fires a pool-swap retry when survivors are thin and merges the richer corpus (两段式自适应)', async () => {
    // 第五写实跑裁决：盘点词的非确定性不可靠——场景词漏进盘点词，整池塌回
    // 自身投放软文、名单只剩 1 家。结果驱动补枪：幸存 <2 时让模型看着召回
    // 标题重写去场景/去招商的盘点词，换池补一枪；合并语料重新抽取重新过闸，
    // 两轮幸存按同品牌身份并集。
    const provinceResponse = JSON.stringify({
      competitorSearchQueries: ['广东大学食堂干蒸菜档口加盟哪家好', '广东食堂干蒸菜品牌有哪些'],
      facts: [
        { field: 'industry', value: '餐饮/高校食堂干蒸菜档口', provenance: 'extracted', sourceExcerpt: '行业' },
        { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '区域' },
      ],
    });
    const thinCorpus = [{
      title: '炊班主档口方案',
      url: 'https://mill.example/thin',
      summary: '炊班主面向创业者输出干蒸菜档口方案，张仔纪亦在同赛道布局',
    }];
    const richCorpus = [
      {
        title: '干蒸菜品类观察',
        url: 'https://zhihu.example/category',
        summary: '顺德干蒸菜品类一年扩张上百家：渔文乐、蒸简单原盅蒸饭均在扩张名单',
      },
      {
        title: '干蒸菜品牌有哪些',
        url: 'https://list.example/brands',
        summary: '广东干蒸菜品牌盘点：张仔纪、渔文乐、蒸简单原盅蒸饭、容边排骨饭',
      },
    ];
    const port = new FakeMaterialPort();
    let searchCall = 0;
    const current = service(port, {
      completeResponses: [
        provinceResponse,
        JSON.stringify({ direct: [{ name: '张仔纪', region: '广州' }], potential: [] }),
        JSON.stringify({ query: '广东 干蒸菜 品牌 有哪些' }),
        JSON.stringify({
          direct: [{ name: '张仔纪', region: '广州' }],
          potential: [
            { name: '渔文乐', region: '顺德' },
            { name: '蒸简单原盅蒸饭', region: '广东' },
          ],
        }),
      ],
      searchSources: async () => {
        searchCall += 1;
        return searchCall <= 2 ? thinCorpus : richCorpus;
      },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 第三枪换池：重写词生效且确实检索。
    expect(current.searchSources).toHaveBeenCalledTimes(3);
    expect(current.searchSources!.mock.calls[2][0]).toBe('广东 干蒸菜 品牌 有哪些');
    // 合并语料后的第二轮结果与第一轮并集：张仔纪（同身份只一份）+ 两个品类品牌。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['张仔纪']);
    const potential = current.propose.mock.calls.find(
      ([input]) => input.key.predicate.toLowerCase() === 'enterprise-profile.potentialcompetitors',
    );
    expect(potential?.[0].value).toEqual(['渔文乐', '蒸简单原盅蒸饭']);
  });

  it('collapses parenthesized-region disguises of the same brand (括号马甲回归 2026-08-31)', async () => {
    // 第三写实跑回归：直接层同时收了「张仔纪（广州）餐饮管理有限公司」与
    // 「张仔纪餐饮管理有限公司」——括号中缀（广州）让两个名字互不为子串，
    // 嵌套互斥失效、同品牌双份上卡。归一键剥离括号段后两马甲同核，只留先
    // 出现的一份。
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业：餐饮管理' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const parenCorpus = [
      {
        title: '干蒸菜加盟甄选',
        url: 'https://mill.example/a',
        summary: '1. 张仔纪（广州）餐饮管理有限公司：岭南古法干蒸，门店超 100 家',
      },
      {
        title: '干蒸菜品牌解析',
        url: 'https://mill.example/b',
        summary: '张仔纪餐饮管理有限公司以非遗技艺为基础构建运营体系',
      },
    ];
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({
        direct: [
          { name: '张仔纪（广州）餐饮管理有限公司', region: '广州' },
          { name: '张仔纪餐饮管理有限公司', region: '广州' },
        ],
        potential: [],
      })],
      searchSources: async () => parenCorpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 括号段从归一键剥离：两马甲同核，只留先出现的一份。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['张仔纪（广州）餐饮管理有限公司']);
  });

  it('injects the customer-profile fields into the snapshot prompt and gates by customer voice', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [JSON.stringify({ facts: [
        { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业' },
        { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '区域' },
        { field: 'targetCustomers', value: ['个体创业者', '夫妻档'], provenance: 'extracted', sourceExcerpt: '合作对象' },
        { field: 'customerCases', value: ['广东财经大学直营店'], provenance: 'extracted', sourceExcerpt: '案例' },
        { field: 'coreAdvantages', value: ['团餐场景定向研发'], provenance: 'extracted', sourceExcerpt: '优势' },
      ] }), JSON.stringify({ direct: [], potential: [] })],
      searchSources: async () => [{
        title: '干蒸菜项目加盟口碑',
        url: 'https://example.com/jm',
        summary: '某品牌面向创业者输出干蒸菜档口方案',
      }],
    });
    await current.value.importPastedText('公司资料');

    const snapshotPrompt = (current.complete.mock.calls[1] as unknown as [
      readonly { role: string; content: string }[],
    ])[0][1].content;
    expect(snapshotPrompt).toContain('目标客户：个体创业者、夫妻档');
    expect(snapshotPrompt).toContain('经营场景/客户案例：广东财经大学直营店');
    expect(snapshotPrompt).toContain('核心优势：团餐场景定向研发');
  });

  it('keeps one entry for nested name variants within a tier and drops phrase-like names', async () => {
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({
        direct: [
          { name: '顺德杨廷记餐饮有限公司', region: '顺德' },
          { name: '顺德杨廷记', region: '顺德' },
          { name: '云帆信息', region: '成都新都' },
          { name: '「某品牌」点都德相关供应链企业', region: '广州' },
          { name: '与云帆相关的品牌', region: '成都' },
        ],
        potential: [],
      })],
      searchSources: async () => [
        {
          title: '顺德干蒸品牌榜',
          url: 'https://example.com/sd',
          summary: '顺德杨廷记餐饮有限公司主营干蒸菜品类；云帆信息亦在榜',
        },
      ],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 嵌套名只留先出现的一份；引号包裹/「相关」句式的描述短语剔除。
    expect(competitorsCallOf(current)?.[0].value)
      .toEqual(['顺德杨廷记餐饮有限公司', '云帆信息']);
  });

  it('normalizes traditional source-page names to simplified for storage and matching', async () => {
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({ direct: [
        { name: '榕邊干蒸鮮排骨', region: '深圳' },
      ], potential: [] })],
      searchSources: async () => [{
        title: '深圳顺德菜馆推荐',
        url: 'https://example.com/hk',
        summary: '榕邊干蒸鮮排骨是深圳人气顺德干蒸专门店',
      }],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 繁体名归简存储；存在闸两侧同映射（语料繁体、名字简体仍逐字对齐）。
    expect(competitorsCallOf(current)?.[0].value).toEqual(['榕边干蒸鲜排骨']);
  });

  it('relation gate still fires on traditional-character sources (繁简映射回归)', async () => {
    // 繁体源页里名字附近有关系词（前東家）：名字归简后关系闸必须照样命中
    // 剔除——文本侧不做映射时繁简失配，闸会静默放行。
    const provinceResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '餐饮管理', provenance: 'extracted', sourceExcerpt: '行业' },
      { field: 'serviceArea', value: '广东省', provenance: 'extracted', sourceExcerpt: '业务区域范围：广东省' },
    ] });
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [provinceResponse, JSON.stringify({ direct: [
        { name: '榕邊干蒸鮮排骨', region: '深圳' },
        { name: '云帆信息', region: '广州' },
      ], potential: [] })],
      searchSources: async () => [{
        title: '深圳顺德菜馆推荐',
        url: 'https://example.com/hk',
        summary: '榕邊干蒸鮮排骨的前東家另有其人；云帆信息是独立品牌',
      }],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('normalizes autonomous-region long names and mixed declarations to the province anchor', async () => {
    const mixedResponse = JSON.stringify({ facts: [
      { field: 'industry', value: '智能客服', provenance: 'extracted', sourceExcerpt: '行业：智能客服' },
      { field: 'serviceArea', value: '广西壮族自治区', provenance: 'extracted', sourceExcerpt: '业务区域范围：广西壮族自治区' },
    ] });
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [mixedResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '南宁' },
      ] })],
      searchSources: async () => [{
        title: '广西智能客服排行榜',
        url: 'https://example.com/gx-rank',
        summary: '广西智能客服十大品牌：云帆信息（南宁）排名第一',
      }],
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries[0]).toContain('广西 智能客服 排行榜');
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('relation gate drops names whose snippet states a non-competitive relation', async () => {
    const port = new FakeMaterialPort();
    const supplierCorpus = [...corpus, {
      title: '鲸跃科技供应商名单',
      url: 'https://example.com/vendors',
      summary: '华创精密是鲸跃科技的供应商，为其提供芯片',
    }];
    const current = service(port, {
      completeResponses: [withAreaResponse, JSON.stringify({ direct: [
        { name: '云帆信息', region: '成都新都' },
        { name: '华创精密', region: '成都新都' },
      ] })],
      searchSources: async () => supplierCorpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('skips enrichment entirely without a service anchor and surfaces a passive hint row', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [extractionResponse()],
      searchSources: async () => { throw new Error('must not search without anchor'); },
      search: async () => { throw new Error('must not search without anchor'); },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.searchSources).not.toHaveBeenCalled();
    expect(current.search).not.toHaveBeenCalled();
    const competitorsCall = competitorsCallOf(current);
    expect(competitorsCall?.[0].value).toEqual([]);
    expect(competitorsCall?.[0].source.excerpt).toContain('材料未提供可定位的服务区域');
  });

  it('skips silently without an anchor when the material already carries competitors', async () => {
    const port = new FakeMaterialPort();
    const materialCompetitors = JSON.stringify({ facts: [
      {
        field: 'competitors',
        value: ['甲品牌'],
        provenance: 'extracted',
        sourceExcerpt: '材料明确的主要竞品包括：甲品牌',
        confidence: 0.9,
        scope: { kind: 'brand' },
      },
    ] });
    const current = service(port, {
      completeResponses: [materialCompetitors],
      searchSources: async () => { throw new Error('must not search without anchor'); },
    });
    const result = await current.value.importPastedText('材料明确的主要竞品包括：甲品牌');

    expect(result.ok).toBe(true);
    expect(current.searchSources).not.toHaveBeenCalled();
    expect(competitorsCallOf(current)?.[0].value).toEqual(['甲品牌']);
  });

  it('falls back to the enable_search merged call when searchSources is unavailable', async () => {
    const port = new FakeMaterialPort();
    const mergedJson = JSON.stringify({
      competitors: [
        {
          name: '云帆信息',
          region: '成都',
          similarBusiness: '智能客服',
          sourceExcerpt: '云帆信息位于成都经营智能客服',
        },
        {
          name: '武汉楚才科技',
          region: '武汉',
          similarBusiness: '智能客服',
          sourceExcerpt: '武汉楚才科技位于武汉经营智能客服',
        },
      ],
    });
    const current = service(port, {
      completeResponses: [withAreaResponse],
      search: async () => mergedJson,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 兜底路径不再触发第二次抽取调用（检索与判别合并在 enable_search 里）。
    expect(current.complete).toHaveBeenCalledTimes(1);
    expect(current.search).toHaveBeenCalledTimes(2);
    const competitorsCall = competitorsCallOf(current);
    // 存在闸在兜底路径无快照可比（明确降级）；地域闸照常执行。
    expect(competitorsCall?.[0].value).toEqual(['云帆信息']);
    expect(competitorsCall?.[0].source.excerpt).toContain('云帆信息（成都）：');
    expect(competitorsCall?.[0].source.excerpt).not.toContain('xiaojing-competitor-details');
  });

  it('falls back when searchSources fails or returns an empty corpus', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse],
      searchSources: async () => { throw new Error('doubao search api down'); },
      search: async () => JSON.stringify({
        competitors: [
          { name: '云帆信息', region: '成都', similarBusiness: '智能客服', sourceExcerpt: '云帆信息位于成都经营智能客服' },
        ],
      }),
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.search).toHaveBeenCalledTimes(2);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('drops lookalike short-name typo variants of the brand from snapshot candidates', async () => {
    const port = new FakeMaterialPort();
    const typoCorpus = [...corpus, {
      title: '成都智能客服口碑',
      url: 'https://example.com/typo',
      summary: '鲸悦科技位于成都新都经营智能客服',
    }];
    const current = service(port, {
      completeResponses: [withAreaResponse, JSON.stringify({ direct: [
        { name: '鲸悦科技', region: '成都新都' },
        { name: '云帆信息', region: '成都新都' },
      ] })],
      searchSources: async () => typoCorpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息']);
  });

  it('merges enriched names into extracted competitors as a single candidate', async () => {
    const port = new FakeMaterialPort();
    const materialCompetitors = JSON.stringify({ facts: [
      {
        field: 'competitors',
        value: ['甲品牌'],
        provenance: 'extracted',
        sourceExcerpt: '材料明确的主要竞品包括：甲品牌',
        confidence: 0.9,
        scope: { kind: 'brand' },
      },
      { field: 'serviceArea', value: '成都新都', provenance: 'extracted', sourceExcerpt: '服务成都新都' },
    ] });
    const current = service(port, {
      completeResponses: [materialCompetitors, namesJson],
      searchSources: async () => corpus,
    });
    const result = await current.value.importPastedText('材料明确的主要竞品包括：甲品牌');

    expect(result.ok).toBe(true);
    const competitorsCalls = current.propose.mock.calls.filter(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCalls).toHaveLength(1);
    expect(competitorsCalls[0][0].value).toEqual(['甲品牌', '云帆信息', '星河智能']);
  });

  it('does not search when ten confirmed competitors already exist', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse],
      inspect: async (key) => {
        if (key.predicate !== 'enterprise-profile.competitors') return null;
        return {
          key: { subject: '鲸跃科技', predicate: key.predicate, scopeJson: '{}', identity: 'brand|competitors|{}||' },
          normalizedValueJson: JSON.stringify([
            '甲品牌', '乙品牌', '丙品牌', '丁品牌', '戊品牌',
            '己品牌', '庚品牌', '辛品牌', '壬品牌', '癸品牌',
          ]),
          unit: null,
          version: 3,
          confirmedBy: 'desktop-user',
          confirmedAt: '2026-08-15T00:00:00Z',
          sources: [],
        };
      },
      searchSources: async () => corpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result).toMatchObject({ ok: true });
    expect(current.searchSources).not.toHaveBeenCalled();
    expect(current.complete).toHaveBeenCalledTimes(1);
  });

  it('proposes only new names; the authority array-merge keeps confirmed competitors', async () => {
    // 已确认权威值由 KnowledgeAuthority propose 的数组增量合并契约保住
    // （current 在前、新增去重追加，见 knowledge-authority 单测）：提议 value
    // 只含联网新增名，已确认名称不以「待确认」形态重复出现。
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, namesJson],
      inspect: async (key) => {
        if (key.predicate === 'enterprise-profile.competitors') {
          return {
            key: { subject: '鲸跃科技', predicate: key.predicate, scopeJson: '{}', identity: 'brand|competitors|{}||' },
            normalizedValueJson: JSON.stringify(['天立教育', '丹秋教育', '领川教育']),
            unit: null,
            version: 3,
            confirmedBy: 'desktop-user',
            confirmedAt: '2026-08-15T00:00:00Z',
            sources: [],
          };
        }
        return null;
      },
      searchSources: async () => corpus,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息', '星河智能']);
  });

  it('hydrates the enrichment profile from confirmed authority facts when the material lacks them', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [extractionResponse(), namesJson],
      searchSources: async () => corpus,
      inspect: async (key) => {
        if (key.predicate === 'enterprise-profile.products') {
          return {
            key: { subject: '鲸跃科技', predicate: key.predicate, scopeJson: '{}', identity: 'brand|products|{}||' },
            normalizedValueJson: JSON.stringify(['汽车音响改装', '隔音升级']),
            unit: null,
            version: 2,
            confirmedBy: 'desktop-user',
            confirmedAt: '2026-08-15T00:00:00Z',
            sources: [],
          };
        }
        if (key.predicate === 'enterprise-profile.servicearea') {
          return {
            key: { subject: '鲸跃科技', predicate: key.predicate, scopeJson: '{}', identity: 'brand|servicearea|{}||' },
            normalizedValueJson: '"成都新都"',
            unit: null,
            version: 1,
            confirmedBy: 'desktop-user',
            confirmedAt: '2026-08-15T00:00:00Z',
            sources: [],
          };
        }
        return null;
      },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 画像（产品/服务区域）由已确认权威值补齐：驱动检索查询形态与快照
    // 抽取提示词的画像块（品牌名裁决优先知识库身份事实，非工作区名）。
    const queries = current.searchSources!.mock.calls.map(([query]) => query);
    expect(queries[0]).toContain('成都新都');
    expect(queries[0]).toContain('汽车音响改装');
    const extractionPrompt = (current.complete.mock.calls[1] as unknown as [
      readonly { role: string; content: string }[],
    ])[0][1].content;
    expect(extractionPrompt).toContain('核心产品/服务：汽车音响改装、隔音升级');
    expect(extractionPrompt).toContain('服务区域：成都新都');
  });

  it('tolerates per-query retrieval failure and aggregates deduped suggestions', async () => {
    const port = new FakeMaterialPort();
    let call = 0;
    const current = service(port, {
      completeResponses: [withAreaResponse, namesJson],
      searchSources: async () => {
        call += 1;
        if (call === 1) throw new Error('search hiccup');
        return corpus;
      },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.searchSources).toHaveBeenCalledTimes(2);
    expect(competitorsCallOf(current)?.[0].value).toEqual(['云帆信息', '星河智能']);
  });

  it('keeps an empty competitor row visible when every search path fails', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse],
      search: async () => { throw new Error('keyword-search unavailable'); },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result).toMatchObject({ ok: true });
    expect(current.propose).toHaveBeenCalledTimes(3);
    expect(current.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.objectContaining({
          predicate: "enterprise-profile.competitors",
        }),
        value: [],
        source: expect.objectContaining({ profileProvenance: "inferred" }),
      }),
    );
    expect(port.trace.at(-1)).toMatch(/finish:text-1:awaiting-confirmation/);
  });

  it("keeps an empty competitor row visible when no search capability is injected", async () => {
    const port = new FakeMaterialPort();
    const current = service(port);
    const result = await current.value.importPastedText('公司资料');

    expect(result).toMatchObject({ ok: true });
    expect(current.propose).toHaveBeenCalledTimes(3);
    expect(current.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.objectContaining({
          predicate: "enterprise-profile.competitors",
        }),
        value: [],
      }),
    );
  });

  it('logs search_corpus_empty when every fallback search response is unusable', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      const port = new FakeMaterialPort();
      const current = service(port, {
        completeResponses: [withAreaResponse],
        search: async () => { throw new Error('keyword-search unavailable'); },
      });
      await current.value.importPastedText('公司资料');

      expect(
        logs.some((line) => line.includes('"errorCode":"search_corpus_empty"')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs no_qualified_suggestions when snapshot names all fail the gates', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      const port = new FakeMaterialPort();
      const current = service(port, {
        completeResponses: [withAreaResponse, JSON.stringify({ direct: [
          { name: '武汉楚才科技', region: '武汉' },
        ] })],
        searchSources: async () => corpus,
      });
      const result = await current.value.importPastedText('公司资料');

      expect(result).toMatchObject({ ok: true });
      expect(
        logs.some((line) => line.includes('"errorCode":"no_qualified_suggestions"')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs model_response_invalid when snapshot name extraction returns prose twice', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      const port = new FakeMaterialPort();
      const current = service(port, {
        completeResponses: [withAreaResponse, '这不是 JSON', '仍不是 JSON'],
        searchSources: async () => corpus,
      });
      const result = await current.value.importPastedText('公司资料');

      expect(result).toMatchObject({ ok: true });
      expect(
        logs.some((line) => line.includes('"errorCode":"model_response_invalid"')),
      ).toBe(true);
      // 坏 JSON 重抽一次（同 extractFacts 契约）：共三次模型调用。
      expect(current.complete).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('anchors industry to the confirmed authority value and constrains its form (行业稳定性)', async () => {
    // 行业摇摆事故（2026-08-31）：8 次导入 8 个候选（餐饮管理/团餐/食堂
    // 档口招商加盟/餐饮加盟）且零确认——无锚点时模型按当次措辞抽样。修复：
    // 字段定义两级写法 + 禁公司形态/招商词脏值；用户确认过一次即注入锚，
    // 材料逐字矛盾才允许推翻。
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, namesJson],
      searchSources: async () => corpus,
      inspect: async (key) => key.predicate.toLowerCase() === 'enterprise-profile.industry'
        ? {
          key: {
            subject: key.subject,
            predicate: key.predicate,
            scopeJson: '{"entityScope":"brand"}',
            effectiveFrom: null,
            effectiveTo: null,
            identity: 'industry-anchor-1',
          },
          normalizedValueJson: '"餐饮/高校食堂干蒸菜档口"',
          unit: null,
          version: 3,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-30T00:00:00Z',
          sources: [],
        }
        : null,
    });
    await current.value.importPastedText('公司资料');

    const profilePrompt = (current.complete.mock.calls[0] as unknown as [
      readonly { role: string; content: string }[],
    ])[0][1].content;
    expect(profilePrompt).toContain('已确认行业（先前导入经用户确认）：餐饮/高校食堂干蒸菜档口');
    expect(profilePrompt).toContain('必须与之一致');
    expect(profilePrompt).toContain('两级写法「大类/细分品类」');
    expect(profilePrompt).toContain('公司形态词');
    expect(profilePrompt).toContain('招商/加盟等业务模式词');
    expect(profilePrompt).toContain('行业取值必须稳定');
  });

  it('embeds field definitions in the profile prompt and gate disciplines in the snapshot prompt', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [withAreaResponse, namesJson],
      searchSources: async () => corpus,
    });
    await current.value.importPastedText('公司资料');

    const promptOf = (index: number) =>
      (current.complete.mock.calls[index] as unknown as [
        readonly { role: string; content: string }[],
      ])[0][1].content;
    const profilePrompt = promptOf(0);
    expect(profilePrompt).toContain('fullName（标量）：品牌完整的注册全称');
    expect(profilePrompt).toContain('同体量层级');
    expect(profilePrompt).toContain('前东家');
    expect(profilePrompt).toContain('禁止凭模型记忆推断或编造');
    const snapshotPrompt = promptOf(1);
    expect(snapshotPrompt).toContain('检索快照');
    expect(snapshotPrompt).toContain('同体量层级');
    // 客户口径纪律（一劳永逸版，用户裁决 2026-08-30）：判别第 0 步先定客户。
    expect(snapshotPrompt).toContain('客户口径，最先判');
    expect(snapshotPrompt).toContain('争夺**同一批客户**预算的对手');
    expect(snapshotPrompt).toContain('食堂档口项目输出品牌');
    expect(snapshotPrompt).toContain('目标客户：未明示（从产品/案例推断）');
    expect(snapshotPrompt).toContain('榜单语料警示');
    expect(snapshotPrompt).toContain('宁缺毋滥');
    // 同名自检（用户裁决 2026-08-31：模型先判，代码归一键兜底）。
    expect(snapshotPrompt).toContain('同名自检');
    expect(snapshotPrompt).toContain('只报一次且用品类媒体最通行的叫法');
    expect(snapshotPrompt).toContain('服务区域：成都新都');
    // 快照语料随提示词下发，名字只能从中识别。
    expect(snapshotPrompt).toContain('云帆信息口碑靠前');
    // 材料腿抽取提示词顺手产出检索词（输出契约含该字段），且两条必须分池：
    // 第 1 条客户口吻问句型、第 2 条中立观察者品类盘点型（禁带招商词）——
    // 两条同池会困在单一投放软文池（张仔纪霸屏 + 余美娟缺席回归）。
    expect(profilePrompt).toContain('竞品检索词（顺手产出，管线瞬时值，不是事实）');
    expect(profilePrompt).toContain('competitorSearchQueries');
    expect(profilePrompt).toContain('两个不同的语料池');
    expect(profilePrompt).toContain('需求问句');
    expect(profilePrompt).toContain('品类盘点');
    expect(profilePrompt).toContain('不得出现加盟、招商、合作、供应商');
    expect(profilePrompt).toContain('去掉材料里的经营场景限定词');
  });
});

describe('parseCompetitorSearchQueries（材料腿顺手产出的检索词）', () => {
  it('takes at most two non-empty string queries, trims and caps each', () => {
    expect(parseCompetitorSearchQueries(JSON.stringify({
      competitorSearchQueries: [' 广东 干蒸菜档口 加盟 ', 42, '  ', '广东 干蒸菜 技术输出 哪家好'],
    }))).toEqual(['广东 干蒸菜档口 加盟', '广东 干蒸菜 技术输出 哪家好']);
  });

  it('returns [] when the field is absent or the payload is not JSON', () => {
    expect(parseCompetitorSearchQueries(JSON.stringify({ facts: [] }))).toEqual([]);
    expect(parseCompetitorSearchQueries('not json')).toEqual([]);
    expect(parseCompetitorSearchQueries(JSON.stringify({ competitorSearchQueries: '非数组' }))).toEqual([]);
  });
});

describe('检索语料域名封顶（语料多样性）', () => {
  it('derives registrable-domain keys, ignoring mobile/www prefixes and multi-label suffixes', () => {
    expect(sourceDomainKey('https://m.toutiao.com/group/1')).toBe('toutiao.com');
    expect(sourceDomainKey('http://www.chinabidding.com.cn/shangxun/x')).toBe('chinabidding.com.cn');
    expect(sourceDomainKey('https://m.chinabidding.com.cn/cyzx/y')).toBe('chinabidding.com.cn');
    expect(sourceDomainKey('https://example.org/rank')).toBe('example.org');
    expect(sourceDomainKey('https://a.b.example.com/p')).toBe('example.com');
    // 两段公共后缀全类（共享 registeredDomain 清单）：edu.cn/co.uk 取倒数
    // 三段，不坍缩成公共后缀本身共享同一个封顶名额。
    expect(sourceDomainKey('https://www.pku.edu.cn/admissions')).toBe('pku.edu.cn');
    expect(sourceDomainKey('https://bbc.co.uk/news')).toBe('bbc.co.uk');
    // 非 URL 输入不炸：原样作为分组键（退化为每条独立成组）。
    expect(sourceDomainKey('not a url')).toBe('not a url');
  });

  it('dedupes by URL first, then caps per domain preserving rank order', () => {
    const mill = (n: number) => ({ url: `https://m-mill.com/a${n}` });
    const org = { url: 'https://example.org/one' };
    const net = { url: 'https://example.net/two' };
    const input = [mill(1), org, mill(2), mill(1), mill(3), mill(4), net];
    expect(dedupeSourcesByUrl(input)).toEqual([mill(1), org, mill(2), mill(3), mill(4), net]);
    // 封顶保序：m-mill.com 只留检索序前 3 条，其他域各留 1 条。
    expect(capSourcesPerDomain(dedupeSourcesByUrl(input), 3)).toEqual([
      mill(1), org, mill(2), mill(3), net,
    ]);
  });

  it('keeps everything when the cap is not a positive number', () => {
    const input = [{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }];
    expect(capSourcesPerDomain(input, 0)).toEqual(input);
    expect(capSourcesPerDomain(input, Number.NaN)).toEqual(input);
  });
});

describe('sameBrandIdentity（同品牌身份判定：归一键嵌套 + ·分段交叉）', () => {
  it('collapses registration-name variants and disguise suffixes via keys and segments', () => {
    // 注册名变体：括号中缀剥离后相等/嵌套。
    expect(sameBrandIdentity('张仔纪（广州）餐饮管理有限公司', '张仔纪餐饮管理有限公司')).toBe(true);
    expect(sameBrandIdentity('顺德杨廷记餐饮有限公司', '顺德杨廷记')).toBe(true);
    // 「品牌·系列」马甲：共享「张仔纪」段。
    expect(sameBrandIdentity('张仔纪·老顺德干蒸菜', '张仔纪干蒸菜')).toBe(true);
    expect(sameBrandIdentity('粤食堂·经典蒸饭', '粤食堂')).toBe(true);
    // 「地域·品牌」马甲：共享品牌段「渔文乐」。
    expect(sameBrandIdentity('顺德·渔文乐', '渔文乐')).toBe(true);
    // 无关名字不误并。
    expect(sameBrandIdentity('云帆信息', '星河智能')).toBe(false);
  });

  it('excludes region segments so 地域·品牌 does not merge with 同地域他牌', () => {
    // 第四写实跑教训：「顺德·渔文乐」若按段盲比会与「顺德杨廷记」因共享
    // 地名段误并——regionHints 剔除地域段后只剩品牌段参与交叉。
    expect(sameBrandIdentity('顺德·渔文乐', '顺德杨廷记', ['顺德'])).toBe(false);
    expect(sameBrandIdentity('顺德·渔文乐', '渔文乐', ['顺德'])).toBe(true);
    // 服务区锚（广东省）同样剔除：段「广东」不参与身份比对。
    expect(sameBrandIdentity('广东·干蒸汇', '广东干蒸坊', ['广东省'])).toBe(false);
  });
});

describe('parseRetryQuery（两段式补枪的重写词解析）', () => {
  it('takes a valid query, trims and caps length', () => {
    expect(parseRetryQuery(JSON.stringify({ query: '  广东 干蒸菜 品牌 有哪些  ' }), ['a']))
      .toBe('广东 干蒸菜 品牌 有哪些');
  });

  it('rejects empty, duplicate, commerce-word, and malformed payloads', () => {
    expect(parseRetryQuery(JSON.stringify({ query: '' }), [])).toBeNull();
    expect(parseRetryQuery(JSON.stringify({ query: '广' }), [])).toBeNull();
    expect(parseRetryQuery(JSON.stringify({ query: '广东 干蒸菜 加盟 品牌' }), [])).toBeNull();
    expect(parseRetryQuery(JSON.stringify({ query: '广东 干蒸菜 品牌 有哪些' }), ['广东 干蒸菜 品牌 有哪些'])).toBeNull();
    expect(parseRetryQuery('not json', [])).toBeNull();
    expect(parseRetryQuery(JSON.stringify({ facts: [] }), [])).toBeNull();
  });
});

describe('website fetch safety', () => {
  it.each([
    'http://brand.example',
    'https://127.0.0.1/admin',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
  ])('rejects unsafe URL %s before fetch', async (url) => {
    const fetch = vi.fn();
    await expect(fetchWebsiteMaterial(url, { fetch, dispatcherFor: async () => undefined }))
      .rejects.toThrow('website_url_rejected');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects DNS resolving inward and a redirect to private address', async () => {
    await expect(fetchWebsiteMaterial('https://public.example', {
      fetch: vi.fn(),
      dispatcherFor: async () => { throw new Error('private dns'); },
    })).rejects.toThrow('website_url_rejected');

    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://10.0.0.1/secret' },
    }));
    await expect(fetchWebsiteMaterial('https://public.example', {
      fetch,
      dispatcherFor: async () => undefined,
    })).rejects.toThrow('website_redirect_rejected');
  });

  it('enforces redirect count, content type and streamed body size', async () => {
    const redirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: '/again' },
    }));
    await expect(fetchWebsiteMaterial('https://public.example', {
      fetch: redirect,
      dispatcherFor: async () => undefined,
    })).rejects.toThrow('website_too_many_redirects');
    expect(redirect).toHaveBeenCalledTimes(4);

    await expect(fetchWebsiteMaterial('https://public.example', {
      fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      dispatcherFor: async () => undefined,
    })).rejects.toThrow('website_content_type_unsupported');

    await expect(fetchWebsiteMaterial('https://public.example', {
      fetch: async () => new Response('x', {
        headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
      dispatcherFor: async () => undefined,
    })).rejects.toThrow('website_too_large');
  });
});

describe('profile and document compatibility', () => {
  it('keeps js_ai profile fields, required semantics and provenance safety while validating product-line scope', () => {
    const facts = parseTestProfileFacts(JSON.stringify({ facts: [
      { field: 'industry', value: 'AI', provenance: 'extracted', scope: { kind: 'brand' } },
      { field: 'coreAdvantages', value: ['快'], provenance: 'asked', scope: { kind: 'product-line', productLine: '不存在' } },
      { field: 'unknown', value: 'drop', provenance: 'extracted', sourceExcerpt: 'drop' },
    ] }), context);
    expect(facts).toEqual([
      expect.objectContaining({ field: 'industry', provenance: 'inferred', scope: { kind: 'brand' } }),
      expect.objectContaining({ field: 'coreAdvantages', value: ['快'], provenance: 'inferred', scope: { kind: 'brand' } }),
    ]);
  });

  it("splits composite list strings in array fields back into atomic items", () => {
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "competitors",
            value:
              "旭日酷车汽车音响、元音改汽车音响，美声汽车音响；声海汽车音响",
            provenance: "extracted",
            sourceExcerpt:
              "主要竞品包括旭日酷车汽车音响、元音改汽车音响、美声汽车音响、声海汽车音响",
          },
          {
            field: "customerCases",
            value: "服务200+客户，好评率98%",
            provenance: "extracted",
            sourceExcerpt: "案例",
          },
        ],
      }),
      context,
    );
    expect(facts.find((fact) => fact.field === "competitors")?.value).toEqual([
      "旭日酷车汽车音响",
      "元音改汽车音响",
      "美声汽车音响",
      "声海汽车音响",
    ]);
    // customerCases 是散文式描述，句内逗号不是列表分隔，不拆。
    expect(facts.find((fact) => fact.field === 'customerCases')?.value)
      .toEqual(['服务200+客户，好评率98%']);
  });

  it("drops the brand itself (exact and bidirectional substring) from relatedBrands and competitors", () => {
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "fullName",
            value: "鲸跃科技有限公司",
            provenance: "extracted",
            sourceExcerpt: "公司全称",
          },
          {
            field: "shortNames",
            value: ["小鲸"],
            provenance: "extracted",
            sourceExcerpt: "简称",
          },
          {
            field: "relatedBrands",
            value: ["鲸跃科技有限公司", "成都鲸跃科技", "真伙伴品牌"],
            provenance: "extracted",
            sourceExcerpt: "关联品牌",
          },
          {
            field: "competitors",
            value: ["小鲸", "云帆信息"],
            provenance: "extracted",
            sourceExcerpt: "主要竞品包括小鲸、云帆信息",
          },
        ],
      }),
      context,
    );
    expect(facts.find((fact) => fact.field === "relatedBrands")?.value).toEqual(
      ["真伙伴品牌"],
    );
    expect(facts.find((fact) => fact.field === "competitors")?.value).toEqual([
      "云帆信息",
    ]);
    // 只剩自名的数组字段整条丢弃，不产出空数组候选。
    const dropped = parseTestProfileFacts(JSON.stringify({ facts: [
      { field: 'relatedBrands', value: ['鲸跃科技'], provenance: 'inferred' },
    ] }), context);
    expect(dropped).toHaveLength(0);
  });

  it('material-leg potential tier stays an array fact and passes the same self/relation gates', () => {
    // ADR-0007 两层名单：potentialCompetitors 是数组字段（cleanValue 不得
    // 走标量分支丢弃），且与直接层同受自名/形近与 relatedBrands 交叉剔除、
    // 竞争信号门——本地闸对两层恒开。
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "fullName",
            value: "鲸跃科技有限公司",
            provenance: "extracted",
            sourceExcerpt: "公司全称",
          },
          {
            field: "relatedBrands",
            value: ["真伙伴品牌"],
            provenance: "extracted",
            sourceExcerpt: "关联品牌",
          },
          {
            field: "potentialCompetitors",
            value: ["鲸跃科技有限公司", "真伙伴品牌", "潜在品牌甲"],
            provenance: "extracted",
            sourceExcerpt: "潜在竞品包括真伙伴品牌、潜在品牌甲；鲸跃科技有限公司为自身",
          },
        ],
      }),
      context,
    );
    const potential = facts.find((fact) => fact.field === "potentialCompetitors");
    // 数组形态保住（逐项 ✕ 依赖 Array.isArray）；自名与 relatedBrands 交叉剔除。
    expect(Array.isArray(potential?.value)).toBe(true);
    expect(potential?.value).toEqual(["潜在品牌甲"]);
  });

  // 回归（品牌「炊班长」事故）：材料错别字形近变体「炊事班」不是 brandName
  // 「炊班长」/短名「炊班主」的相等或子串，旧规则放行进了竞品。
  it('drops lookalike short-name typo variants of the brand from competitors', () => {
    const brandContext: BrandMaterialContext = {
      workspaceId: 'brand-07',
      brandName: '炊班长',
      productLines: [],
    };
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "shortNames",
            value: ["炊班主"],
            provenance: "extracted",
            sourceExcerpt: "简称",
          },
          {
            field: "competitors",
            value: ["炊事班", "真功夫"],
            provenance: "extracted",
            sourceExcerpt: "主要竞品包括炊事班、真功夫",
          },
        ],
      }),
      brandContext,
    );
    // 形近变体被判自引用剔除，真实竞品不误伤。
    expect(facts.find((fact) => fact.field === 'competitors')?.value).toEqual(['真功夫']);
  });

  it("rejects former employers, partners and merely mentioned brands as competitors", () => {
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "relatedBrands",
            value: ["合作品牌乙公司"],
            provenance: "extracted",
            sourceExcerpt: "我们与合作品牌乙公司长期合作",
          },
          {
            field: "competitors",
            value: [
              "前东家甲公司",
              "合作品牌乙公司",
              "材料提及丙公司",
              "真实竞品丁公司",
            ],
            provenance: "extracted",
            sourceExcerpt:
              "创始人曾任职于前东家甲公司；我们与合作品牌乙公司长期合作；材料提及丙公司；主要竞品包括真实竞品丁公司。",
          },
        ],
      }),
      context,
    );

    expect(facts.find((fact) => fact.field === "competitors")?.value).toEqual([
      "真实竞品丁公司",
    ]);
  });

  it("rejects a model-rewritten competitor excerpt that is absent from the material", () => {
    const facts = parseTestProfileFacts(
      JSON.stringify({
        facts: [
          {
            field: "competitors",
            value: ["甲公司"],
            provenance: "extracted",
            sourceExcerpt: "主要竞争对手包括甲公司",
          },
        ],
      }),
      context,
      "供应商甲公司为我们提供设备。",
    );
    expect(facts).toEqual([]);
  });

  describe("isSimilarSelfName", () => {
    it("treats edit-distance-1 CJK short names as self references", () => {
      expect(isSimilarSelfName("炊事班", "炊班长")).toBe(true);
      expect(isSimilarSelfName("炊事班", "炊班主")).toBe(true);
      expect(isSimilarSelfName("炊 事 班", "炊班长")).toBe(true);
      expect(isSimilarSelfName("真功夫", "炊班长")).toBe(false);
      expect(isSimilarSelfName("云帆信息", "鲸跃科技")).toBe(false);
    });

    it('stays scoped to 2–4 char CJK names (length 1 exempt, length ≥5 uses legacy rules)', () => {
      // 长度 1 豁免（单字重名率太高）。
      expect(isSimilarSelfName('鲸', '鲸')).toBe(false);
      // 长度 ≥5 不启用相似度，仍只走相等/双向子串旧规则。
      expect(isSimilarSelfName('鲸跃科技有', '鲸跃科技司')).toBe(false);
      // 非 CJK 短名不适用（拉丁名缩写重名率高）。
      expect(isSimilarSelfName('abcd', 'abce')).toBe(false);
    });
  });

  // 回归：模型对同一 (field, scope) 重复输出多条事实（如多门店电话各一条）时，
  // 必须合并为一条候选；放行会造成同一 fact key 多条候选，整卡确认时第二条
  // 必然触发 knowledge_version_conflict（expected 0, actual 1）。
  it('merges duplicate same-field same-scope facts into one candidate (contactInfo array)', () => {
    const facts = parseTestProfileFacts(JSON.stringify({ facts: [
      { field: 'contactInfo', value: '18111265132', provenance: 'extracted', sourceExcerpt: '龙泉店：181 1126 5132' },
      { field: 'contactInfo', value: '17828430692', provenance: 'extracted', sourceExcerpt: '犀浦店：178 2843 0692' },
    ] }), context);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual(expect.objectContaining({
      field: 'contactInfo',
      value: ['18111265132', '17828430692'],
      provenance: 'extracted',
      sourceExcerpt: '龙泉店：181 1126 5132',
    }));
  });

  it('keeps the strongest scalar fact and downgrades merged arrays containing inferred items', () => {
    const facts = parseTestProfileFacts(JSON.stringify({ facts: [
      { field: 'industry', value: '汽车音响改装', provenance: 'extracted', sourceExcerpt: '行业' },
      { field: 'industry', value: '汽车美容', provenance: 'inferred' },
      { field: 'products', value: ['音响改装'], provenance: 'extracted', sourceExcerpt: '产品' },
      { field: 'products', value: ['隔音降噪'], provenance: 'inferred' },
    ] }), context);
    expect(facts.find((fact) => fact.field === 'industry')).toEqual(expect.objectContaining({
      value: '汽车音响改装',
      provenance: 'extracted',
    }));
    expect(facts.find((fact) => fact.field === 'products')).toEqual(expect.objectContaining({
      value: ['音响改装', '隔音降噪'],
      provenance: 'inferred',
      sourceExcerpt: '产品',
    }));
  });

  it('does not merge same-field facts across different scopes', () => {
    const facts = parseTestProfileFacts(JSON.stringify({ facts: [
      { field: 'coreAdvantages', value: ['品牌级优势'], provenance: 'extracted', sourceExcerpt: '品牌' },
      { field: 'coreAdvantages', value: ['产品线优势'], provenance: 'extracted', sourceExcerpt: '产品线', scope: { kind: 'product-line', productLine: '旗舰产品' } },
    ] }), context);
    expect(facts).toHaveLength(2);
    expect(facts.filter((fact) => fact.field === 'coreAdvantages').map((fact) => fact.scope))
      .toEqual([{ kind: 'brand' }, { kind: 'product-line', productLine: '旗舰产品' }]);
  });

  it('parses existing OOXML and XLSX capabilities from Rust-provided bytes', async () => {
    const docx = new AdmZip();
    docx.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>鲸跃科技</w:t></w:r></w:p></w:body></w:document>'));
    await expect(parseBrandMaterial(material({ fileExt: 'docx' }), docx.toBuffer()))
      .resolves.toContain('鲸跃科技');

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['产品', '智能客服']]), '产品线');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    await expect(parseBrandMaterial(material({ fileExt: 'xlsx' }), new Uint8Array(bytes)))
      .resolves.toContain('智能客服');
  });

  it('projects logs to identifiers and fixed codes only', () => {
    const projection = materialLogProjection({
      operation: 'extract',
      workspaceId: 'brand-07',
      sessionId: 'session-07',
      materialId: 'material-07',
      status: 'failed',
      error: new Error('Bearer sk-secret /Users/alice/private.txt 私密正文'),
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('/Users');
    expect(serialized).not.toContain('私密正文');
    expect(projection.errorCode).toBe('material_processing_failed');

    const invalidIdentity = materialLogProjection({
      operation: 'retry',
      workspaceId: '/Users/alice/private-brand',
      sessionId: 'session-07',
      materialId: 'C:\\private\\profile.pdf',
      status: 'started',
    });
    expect(invalidIdentity).toMatchObject({ workspaceId: 'invalid', materialId: 'invalid' });
    expect(JSON.stringify(invalidIdentity)).not.toContain('private');
  });
});

describe('MaterialImportService billing permits (ticket 07)', () => {
  function permitPort(options: { failApplyWith?: Error } = {}) {
    const calls: Array<
      | { kind: 'apply'; permitId: string; operation: string; units: number }
      | { kind: 'report'; permitId: string; unit: number; outcome: string }
      | { kind: 'close'; permitId: string }
    > = [];
    return {
      calls,
      port: {
        async apply(input: { permitId: string; operation: string; units: number }) {
          calls.push({ kind: 'apply', ...input });
          if (options.failApplyWith) throw options.failApplyWith;
          return {
            permitId: input.permitId,
            operation: input.operation,
            units: input.units,
            totalPoints: 20,
            status: 'open' as const,
            frozenPoints: 20,
            consumedPoints: 0,
            refundedPoints: 0,
          };
        },
        async reportUnit(permitId: string, unit: number, outcome: string) {
          calls.push({ kind: 'report', permitId, unit, outcome });
        },
        async close(permitId: string) {
          calls.push({ kind: 'close', permitId });
        },
      },
    };
  }

  function billedService(
    port: FakeMaterialPort,
    permits: ReturnType<typeof permitPort>['port'],
    overrides: Parameters<typeof service>[1] = {},
  ) {
    const built = service(port, overrides);
    return {
      ...built,
      value: new MaterialImportService(
        { workspaceId: 'brand-07', sessionId: 'session-07' },
        port,
        { slot: 'extraction', complete: built.complete },
        { propose: built.propose, inspect: built.inspect },
        {},
        undefined,
        10 * 60_000,
        permits,
      ),
    };
  }

  it('bills each imported document as its own material_import permit and reports success', async () => {
    const port = new FakeMaterialPort();
    const permits = permitPort();
    const subject = billedService(port, permits.port);

    const result = await subject.value.importPastedText('公司全称：鲸跃科技有限公司');

    expect(result.ok).toBe(true);
    expect(permits.calls).toEqual([
      { kind: 'apply', permitId: 'mat:attempt-text-1-1', operation: 'material_import', units: 1 },
      { kind: 'report', permitId: 'mat:attempt-text-1-1', unit: 0, outcome: 'success' },
    ]);
  });

  it('keeps the required competitor row when extraction returns no other facts', async () => {
    const port = new FakeMaterialPort();
    const permits = permitPort();
    const subject = billedService(port, permits.port, {
      complete: async () => JSON.stringify({ facts: [] }),
    });

    const result = await subject.value.importPastedText('空内容');

    expect(result.ok).toBe(true);
    expect(subject.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.objectContaining({
          predicate: 'enterprise-profile.competitors',
        }),
        value: [],
      }),
    );
    expect(permits.calls).toEqual([
      { kind: 'apply', permitId: 'mat:attempt-text-1-1', operation: 'material_import', units: 1 },
      { kind: 'report', permitId: 'mat:attempt-text-1-1', unit: 0, outcome: 'success' },
    ]);
  });

  it('fails the document without any report when the permit is rejected', async () => {
    const port = new FakeMaterialPort();
    const permits = permitPort({
      failApplyWith: new Error('insufficient_balance:点数不足：本次需 20 点，当前可用 4 点。'),
    });
    const subject = billedService(port, permits.port);

    const result = await subject.value.importPastedText('公司全称：鲸跃科技有限公司');

    expect(result.ok).toBe(false);
    expect(port.finishes[0]).toMatchObject({ status: 'failed' });
    expect(permits.calls).toEqual([
      { kind: 'apply', permitId: 'mat:attempt-text-1-1', operation: 'material_import', units: 1 },
    ]);
  });

  // 回归：GatewayBillingError 的 message 是自由中文文本，子串匹配会把
  // insufficient_balance 掩蔽成泛化 material_processing_failed；按类型归码。
  it('maps GatewayBillingError permit rejection to material_billing_failed', async () => {
    const port = new FakeMaterialPort();
    const permits = permitPort({
      failApplyWith: new GatewayBillingError(
        'insufficient_balance',
        '点数不足：本次需 20 点，当前可用 4 点。',
        402,
        { required: 20, available: 4 },
      ),
    });
    const subject = billedService(port, permits.port);

    const result = await subject.value.importPastedText('公司全称：鲸跃科技有限公司');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('material_billing_failed');
    expect(port.finishes[0]).toMatchObject({ status: 'failed', errorCode: 'material_billing_failed' });
  });

  it('logs one sanitized diagnostic for every failure code without free-form message text', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const port = new FakeMaterialPort();
      const permits = permitPort({
        failApplyWith: new GatewayBillingError('insufficient_balance', '点数不足：私密详情', 402),
      });
      const subject = billedService(port, permits.port);

      await subject.value.importPastedText('公司全称：鲸跃科技有限公司');

      const line = spy.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('diagnostic'));
      expect(line).toBeDefined();
      expect(line).toContain('material_billing_failed');
      expect(line).toContain('GatewayBillingError');
      expect(line).toContain('insufficient_balance');
      // 自由文本 message 不进日志。
      expect(line).not.toContain('私密详情');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('MaterialImportService standalone image materials (ADR-0008 T2)', () => {
  const taggingResponse = (
    category = '产品实拍',
    description = '门店前台的智能音箱展台实拍',
  ) => JSON.stringify({ description, category });

  async function storedImage(port: FakeMaterialPort, bytes: Uint8Array) {
    const item = await port.importFile('C:/pics/展拍.png');
    port.bytes.set(item.id, bytes);
    return item;
  }

  it('imports a standalone image straight into the candidate pool, skipping text and profile extraction', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, { describeImage: async () => taggingResponse() });

    const results = await current.value.importFiles(['C:/pics/展拍.png']);

    expect(results[0]).toMatchObject({ ok: true, candidateIds: [], candidates: [] });
    // 文本/画像抽取零调用：图片材料不进抽取模型与知识权威。
    expect(current.complete).not.toHaveBeenCalled();
    expect(current.propose).not.toHaveBeenCalled();
    expect(current.describeImage).toHaveBeenCalledTimes(1);
    // 打标产出 + 尺寸/来源/sha256 一并入池。
    const saved = port.savedImages[0];
    expect(saved).toMatchObject({
      sha256: 'b'.repeat(64),
      fileExt: 'png',
      mediaType: 'image/png',
      byteSize: pngFixtureBytes(800, 600).byteLength,
      width: 800,
      height: 600,
      description: '门店前台的智能音箱展台实拍',
      category: 'product-photo',
    });
    expect(saved?.sourceMaterialId).toMatch(/^file-/);
    // 终态 processed、零候选；导入成功而非 failed。
    expect(port.finishes.at(-1)).toMatchObject({ status: 'processed', candidateIds: [] });
  });

  it('filters small images before tagging while keeping the import successful', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(120, 80));
    const current = service(port, { describeImage: async () => taggingResponse() });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true, candidateIds: [] });
    expect(current.describeImage).not.toHaveBeenCalled();
    expect(port.savedImages).toHaveLength(0);
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('filters oversized images without spending a tagging call', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, new Uint8Array(MATERIAL_IMAGE_MAX_TAGGABLE_BYTES + 1));
    const current = service(port, { describeImage: async () => taggingResponse() });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(current.describeImage).not.toHaveBeenCalled();
    expect(port.savedImages).toHaveLength(0);
  });

  it('drops icon-decoration tags out of the pool', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(800, 600));
    const current = service(port, { describeImage: async () => taggingResponse('图标装饰', '品牌 logo 圆形图标') });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(port.savedImages).toHaveLength(0);
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('degrades to not-pooled on unparseable tagging output', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(800, 600));
    const current = service(port, { describeImage: async () => '这张图我识别不了。' });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(port.savedImages).toHaveLength(0);
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('degrades to not-pooled when the tagging call throws', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(800, 600));
    const current = service(port, {
      describeImage: async () => { throw new Error('keyword-search upstream failed'); },
    });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(port.savedImages).toHaveLength(0);
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('degrades to not-pooled when the capability has no describeImage (legacy injection)', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(800, 600));
    const current = service(port, { search: async () => '搜索结果' });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(port.savedImages).toHaveLength(0);
    expect(current.complete).not.toHaveBeenCalled();
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('keeps the import successful when image persistence fails', async () => {
    const port = new FakeMaterialPort();
    const item = await storedImage(port, pngFixtureBytes(800, 600));
    port.failImageSave = true;
    const current = service(port, { describeImage: async () => taggingResponse() });

    const result = await current.value.process(item.id);

    expect(result).toMatchObject({ ok: true });
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });

  it('routes duplicate content to one pool entry via the sha256 key', async () => {
    const port = new FakeMaterialPort();
    const first = await storedImage(port, pngFixtureBytes(800, 600));
    const second = await storedImage(port, pngFixtureBytes(1024, 768));
    const current = service(port, { describeImage: async () => taggingResponse() });

    await current.value.process(first.id);
    await current.value.process(second.id);

    // 两次保存都发生，但同一 sha256 在端口层幂等为一个条目。
    expect(port.savedImages).toHaveLength(2);
    expect(port.imageAssets.size).toBe(1);
    expect(port.finishes.at(-1)?.status).toBe('processed');
  });
});
