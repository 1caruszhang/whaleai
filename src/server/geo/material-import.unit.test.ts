import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import type { KnowledgeCandidate, KnowledgeProposalInput } from './knowledge-authority';
import {
  MaterialImportService,
  fetchWebsiteMaterial,
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

function service(port: FakeMaterialPort, overrides: {
  complete?: () => Promise<string>;
  fetch?: typeof fetch;
  propose?: (input: KnowledgeProposalInput) => Promise<KnowledgeCandidate>;
} = {}) {
  const complete = vi.fn(overrides.complete ?? (async () => extractionResponse()));
  const propose = vi.fn(overrides.propose ?? (async (input: KnowledgeProposalInput) => (
    { id: `candidate-${input.key.predicate}` } as KnowledgeCandidate
  )));
  return {
    complete,
    propose,
    value: new MaterialImportService(
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      port,
      { slot: 'extraction', complete },
      { propose },
      overrides.fetch ? { fetch: overrides.fetch, dispatcherFor: async () => undefined } : {},
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
    expect(current.propose).toHaveBeenCalledTimes(2);
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

  it('marks only the current material failed when the extraction model fails', async () => {
    const port = new FakeMaterialPort();
    const current = service(port, { complete: async () => { throw new Error('secret body'); } });
    const result = await current.value.importPastedText('公司资料');
    expect(result).toMatchObject({ ok: false, errorCode: 'model_failed' });
    expect(port.trace.at(-1)).toMatch(/finish:text-1:failed/);
  });

  it('records candidates already proposed when a later candidate fails', async () => {
    const port = new FakeMaterialPort();
    let calls = 0;
    const current = service(port, {
      propose: async (input) => {
        calls += 1;
        if (calls === 2) throw new Error('authority unavailable');
        return { id: `candidate-${input.key.predicate}` } as KnowledgeCandidate;
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
    const facts = parseProfileFacts(JSON.stringify({ facts: [
      { field: 'industry', value: 'AI', provenance: 'extracted', scope: { kind: 'brand' } },
      { field: 'coreAdvantages', value: ['快'], provenance: 'asked', scope: { kind: 'product-line', productLine: '不存在' } },
      { field: 'unknown', value: 'drop', provenance: 'extracted', sourceExcerpt: 'drop' },
    ] }), context);
    expect(facts).toEqual([
      expect.objectContaining({ field: 'industry', provenance: 'inferred', scope: { kind: 'brand' } }),
      expect.objectContaining({ field: 'coreAdvantages', value: ['快'], provenance: 'inferred', scope: { kind: 'brand' } }),
    ]);
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
