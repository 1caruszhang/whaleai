import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import type { KnowledgeCandidate, KnowledgeCurrentFact, KnowledgeProposalInput } from './knowledge-authority';
import { GatewayBillingError } from './billing-permit';
import {
  MaterialImportService,
  fetchWebsiteMaterial,
  isSimilarSelfName,
  materialLogProjection,
  parseBrandMaterial,
  parseProfileFacts,
  type BrandMaterial,
  type BrandMaterialContext,
  type BrandMaterialPort,
} from './material-import';

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

class FakeMaterialPort implements BrandMaterialPort {
  readonly trace: string[] = [];
  readonly finishes: Array<{
    attemptId: string;
    materialId: string;
    status: 'awaiting-confirmation' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }> = [];
  readonly materials = new Map<string, BrandMaterial>();
  readonly bytes = new Map<string, Uint8Array>();
  next = 0;

  async context() { return context; }
  async importFile(sourcePath: string) {
    this.trace.push(`store:file:${sourcePath}`);
    if (sourcePath.includes('broken')) throw new Error('material_import_failed');
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
  async finish(input: { attemptId: string; materialId: string; status: 'awaiting-confirmation' | 'failed'; candidateIds: string[]; errorCode?: string }) {
    this.trace.push(`finish:${input.materialId}:${input.status}`);
    this.finishes.push(input);
    const item = this.materials.get(input.materialId) ?? material({ id: input.materialId });
    item.status = input.status;
    item.lastErrorCode = input.errorCode;
    this.materials.set(item.id, item);
    return item;
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
  // 结构化召回可用性测试需要断言「生成语料未被调用」，兜底 spy 同时暴露到返回对象。
  const search = overrides.search
    ? vi.fn(overrides.search)
    : searchSources
      ? vi.fn(async () => { throw new Error('generated search unavailable'); })
      : undefined;
  const capability = search || searchSources
    ? { search: search!, ...(searchSources ? { searchSources } : {}) }
    : undefined;
  return {
    complete,
    propose,
    inspect,
    search,
    searchSources,
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

describe("competitor enrichment (js_ai enrich real competitors)", () => {
  const searchText =
    "鲸跃科技的主要竞争对手包括云帆信息，并与星河智能直接竞争；供应商华创精密为其提供芯片。";
  const enrichmentResponse = JSON.stringify({
    competitors: [
      { name: '云帆信息', sourceExcerpt: '主要竞争对手包括云帆信息' },
      { name: '星河智能', sourceExcerpt: '与星河智能直接竞争' },
      // 名字确实在语料中，但模型把供应关系改写成竞争关系；摘录非原文必须拒绝。
      { name: '华创精密', sourceExcerpt: '主要竞争对手包括华创精密' },
      { name: '幻影科技', sourceExcerpt: '检索结果中不存在的公司' },
      { name: '鲸跃科技', sourceExcerpt: '鲸跃科技的主要竞争对手' },
    ],
  });

  function competitorsFactResponse(names: string[], provenance: 'extracted' | 'inferred'): string {
    return JSON.stringify({
      facts: [
        {
          field: 'competitors',
          value: names,
          provenance,
          ...(provenance === "extracted"
            ? { sourceExcerpt: `材料明确的主要竞品包括：${names.join("、")}` }
            : {}),
          confidence: 0.9,
          scope: { kind: 'brand' },
        },
        {
          field: 'fullName',
          value: '鲸跃科技有限公司',
          provenance: 'extracted',
          sourceExcerpt: '公司全称：鲸跃科技有限公司',
          confidence: 0.96,
          scope: { kind: 'brand' },
        },
      ],
    });
  }

  it('searches and appends only literally-present competitors as one inferred candidate', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [extractionResponse(), enrichmentResponse],
      search: async () => searchText,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    expect(current.search).toHaveBeenCalledWith(
      expect.stringContaining('鲸跃科技'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(current.search).toHaveBeenCalledWith(
      expect.stringContaining('竞争对手'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const competitorsCall = current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCall).toBeTruthy();
    expect(competitorsCall?.[0]).toMatchObject({
      value: ["云帆信息", "星河智能"],
      source: { profileProvenance: "inferred" },
    });
    // 依据合并保留逐名检索摘录，供卡片低置信组展示。
    expect(competitorsCall?.[0].source.excerpt).toContain('云帆信息：主要竞争对手包括云帆信息');
  });

  it('drops lookalike short-name typo variants of the brand from enriched suggestions', async () => {
    const port = new FakeMaterialPort();
    // 检索语料里字面出现品牌形近变体「鲸悦科技」（品牌「鲸跃科技」的错别字），
    // 反虚构字面匹配会放行，排除名单的相似度护栏必须拦下。
    const current = service(port, {
      completeResponses: [extractionResponse(), JSON.stringify({
        competitors: [
          { name: '鲸悦科技', sourceExcerpt: '竞争对手包括鲸悦科技' },
          { name: '云帆信息', sourceExcerpt: '与云帆信息直接竞争' },
        ],
      })],
      search: async () => '鲸跃科技的主要竞争对手包括鲸悦科技；与云帆信息直接竞争。',
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    const competitorsCall = current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCall?.[0].value).toEqual(['云帆信息']);
  });

  it('merges enriched names into extracted competitors as a single candidate', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [competitorsFactResponse(['甲品牌'], 'extracted'), enrichmentResponse],
      search: async () => searchText,
    });
    const result = await current.value.importPastedText(
      '材料明确的主要竞品包括：甲品牌',
    );

    expect(result.ok).toBe(true);
    const competitorsCalls = current.propose.mock.calls.filter(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCalls).toHaveLength(1);
    expect(competitorsCalls[0][0].value).toEqual([
      "甲品牌",
      "云帆信息",
      "星河智能",
    ]);
  });

  it("keeps an empty competitor row visible when the search provider fails", async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
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

  it('does not search when eight confirmed competitors already exist', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      inspect: async (key) => {
        if (key.predicate !== 'enterprise-profile.competitors') return null;
        return {
          key: { subject: '鲸跃科技', predicate: key.predicate, scopeJson: '{}', identity: 'brand|competitors|{}||' },
          normalizedValueJson: JSON.stringify(['甲品牌', '乙品牌', '丙品牌', '丁品牌', '戊品牌', '己品牌', '庚品牌', '辛品牌']),
          unit: null,
          version: 3,
          confirmedBy: 'desktop-user',
          confirmedAt: '2026-08-15T00:00:00Z',
          sources: [],
        };
      },
      search: async () => searchText,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result).toMatchObject({ ok: true });
    expect(current.search).not.toHaveBeenCalled();
    expect(current.complete).toHaveBeenCalledTimes(1);
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

  it('uses complementary area+industry queries and tolerates per-query failure', async () => {
    const port = new FakeMaterialPort();
    const withArea = JSON.stringify({ facts: [
      { field: 'industry', value: '医美', provenance: 'extracted', sourceExcerpt: '行业：医美' },
      { field: 'serviceArea', value: '成都新都', provenance: 'extracted', sourceExcerpt: '服务成都新都' },
    ] });
    let call = 0;
    const current = service(port, {
      completeResponses: [withArea, enrichmentResponse],
      search: async () => {
        call += 1;
        if (call === 2) throw new Error('search hiccup');
        return call === 1 ? '主要竞争对手包括云帆信息' : '与星河智能直接竞争';
      },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // js_ai 三互补 query：排行榜形、口碑形、品牌点名形；榜单语料的国际大牌
    // 由富化提示词的画像锚定与榜单警示过滤。
    expect(current.search!.mock.calls.map(([query]) => query)).toEqual([
      '成都新都 医美 排行榜 十大品牌 对比',
      '成都新都 医美 哪家好 推荐 口碑',
      '鲸跃科技 主要竞争对手 同行',
    ]);
    const competitorsCall = current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCall?.[0].value).toEqual(['云帆信息', '星河智能']);
  });

  it('prefers structured doubao-search sources and dedupes across queries by url', async () => {
    const port = new FakeMaterialPort();
    const withArea = JSON.stringify({ facts: [
      { field: 'industry', value: '医美', provenance: 'extracted', sourceExcerpt: '行业：医美' },
      { field: 'serviceArea', value: '成都新都', provenance: 'extracted', sourceExcerpt: '服务成都新都' },
    ] });
    const current = service(port, {
      completeResponses: [withArea, enrichmentResponse],
      searchSources: async (query) => {
        if (query.includes('排行榜')) {
          return [
            { title: '医美十大品牌榜', url: 'https://rank.example/1', summary: '国际设备品牌与连锁榜单' },
            { title: '新都医美哪家好', url: 'https://local.example/1', summary: '主要竞争对手包括云帆信息' },
          ];
        }
        return [
          // 跨 query 的同一 URL 只进语料一次。
          { title: '新都医美哪家好', url: 'https://local.example/1', summary: '主要竞争对手包括云帆信息' },
          { title: '本地口碑讨论', url: 'https://local.example/2', summary: '与星河智能直接竞争' },
        ];
      },
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 结构化召回可用时不走 enable_search 生成语料。
    expect(current.search).not.toHaveBeenCalled();
    expect(current.searchSources).toHaveBeenCalledTimes(3);
    const promptOf = (index: number) =>
      (current.complete.mock.calls[index] as unknown as [
        readonly { role: string; content: string }[],
      ])[0][1].content;
    const enrichmentPrompt = promptOf(current.complete.mock.calls.length - 1);
    // 语料 = 标题 + 摘要逐条拼接（无 LLM 改写），URL 去重后 3 条。
    expect(enrichmentPrompt).toContain('医美十大品牌榜');
    expect(enrichmentPrompt).toContain('主要竞争对手包括云帆信息');
    expect(enrichmentPrompt).toContain('与星河智能直接竞争');
    const corpus = enrichmentPrompt.split('## 检索结果')[1] ?? '';
    expect(corpus.match(/医美十大品牌榜/g)).toHaveLength(1);
    expect(corpus.match(/新都医美哪家好/g)).toHaveLength(1);
    const competitorsCall = current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCall?.[0].value).toEqual(['云帆信息', '星河智能']);
  });

  it('falls back to the generated corpus when structured search fails entirely', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [extractionResponse(), enrichmentResponse],
      searchSources: async () => { throw new Error('doubao-search unavailable'); },
      search: async () => searchText,
    });
    const result = await current.value.importPastedText('公司资料');

    expect(result.ok).toBe(true);
    // 结构化全军覆没 → 回落 enable_search 生成语料，反虚构过滤照常生效。
    expect(current.searchSources).toHaveBeenCalledTimes(1);
    expect(current.search).toHaveBeenCalledTimes(1);
    const competitorsCall = current.propose.mock.calls.find(
      ([input]) => input.key.predicate === 'enterprise-profile.competitors',
    );
    expect(competitorsCall?.[0].value).toEqual(["云帆信息", "星河智能"]);
  });

  it('hydrates the enrichment profile from confirmed authority facts when the material lacks them', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, {
      completeResponses: [extractionResponse(), enrichmentResponse],
      search: async () => searchText,
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
    const promptOf = (index: number) =>
      (current.complete.mock.calls[index] as unknown as [
        readonly { role: string; content: string }[],
      ])[0][1].content;
    const enrichmentPrompt = promptOf(current.complete.mock.calls.length - 1);
    // 四条件判别的画像输入由已确认权威值补齐：产品进画像块、区域驱动 query 形态。
    expect(enrichmentPrompt).toContain('核心产品/服务：汽车音响改装、隔音升级');
    expect(enrichmentPrompt).toContain('服务区域：成都新都');
    expect(current.search!.mock.calls[0][0]).toContain('成都新都');
  });

  it('embeds per-field definitions and competitor tier discipline in the extraction prompt', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, { search: async () => searchText });
    await current.value.importPastedText('公司资料');

    // vi.fn 的 fallback 无参签名让 mock.calls 元组退化为 []，这里按消息形状取回。
    const promptOf = (index: number) =>
      (current.complete.mock.calls[index] as unknown as [
        readonly { role: string; content: string }[],
      ])[0][1].content;
    const prompt = promptOf(0);
    // 逐字段显式定义（事实类/判断类），不再是单行字段名列表。
    expect(prompt).toContain('fullName（标量）：品牌完整的注册全称');
    expect(prompt).toContain('relatedBrands（数组）');
    expect(prompt).toContain('不是直接竞品】的其他品牌');
    expect(prompt).toContain('其全称/简称/别名不得进入 relatedBrands');
    // serviceArea 是实际已落地范围，不是愿景/招商话术；未明写时可从
    // 客户案例/落地门店/合作档口的地域分布推断（判断类，标 inferred）。
    expect(prompt).toContain('serviceArea（标量）：品牌【实际已落地/可提供服务的地理范围】');
    expect(prompt).toContain('愿景性、招商性表述禁止作为取值');
    expect(prompt).toContain('客户案例/落地门店/合作档口的地域分布推断');
    // 竞品纪律：层级原则（含行业例子）、二选一信号、前东家最高优先级排除、
    // 来源只有材料与后续检索（禁止凭模型记忆推断）。
    expect(prompt).toContain('同体量层级');
    expect(prompt).toContain('二选一');
    expect(prompt).toContain('前东家');
    expect(prompt).toContain('音响设备');
    expect(prompt).toContain('禁止凭模型记忆推断或编造');
    const enrichmentPrompt = promptOf(current.complete.mock.calls.length - 1);
    // 富化提示词：画像锚定 + 四条件同时满足 + 榜单语料警示。
    expect(enrichmentPrompt).toContain('同体量层级');
    expect(enrichmentPrompt).toContain('四个条件必须同时满足');
    expect(enrichmentPrompt).toContain('榜单语料警示');
    expect(enrichmentPrompt).toContain('看具体产品/服务，不看行业大类');
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
