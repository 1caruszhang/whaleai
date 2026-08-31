import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeCandidate, KnowledgeProposalInput } from './knowledge-authority';
import {
  MaterialImportService,
  type BrandMaterial,
  type BrandMaterialContext,
  type BrandMaterialPort,
  type SaveMaterialImageInput,
} from './material-import';
import { createGeoProviderCapabilities } from './provider-capabilities';
import { configureGeoProviderAdmission, wrapGeoProviderCapabilities } from './provider-admission';

// 票 #20 组合级回归（工厂→包装→服务）：T2/T3 单测直接给服务注入裸
// `{ describeImage }` 能力对象，绕过了 provider-admission 的能力包装层，
// 漏测「包装层把 describeImage 剥掉」这一真实运行时缺陷（配图候选池全链路
// 静默空池）。本测试走生产同构链路：createGeoProviderCapabilities 构造
// （注入 fake fetch，零真实网络）→ wrapGeoProviderCapabilities（admission
// 包装，management hop 打 mock）→ MaterialImportService.process()，对含
// 23 张内嵌 JPEG 场景同构的构造 docx 断言 describeImage 被真实调用且入池
// 发生。旧代码（包装层不透传 describeImage）上本测试必须红。
const moduleMocks = vi.hoisted(() => ({
  managementApi: vi.fn(),
}));

vi.mock('../utils/management-api-client', () => ({
  managementApi: moduleMocks.managementApi,
  managementApiBytes: vi.fn(async () => new Uint8Array()),
}));

const context: BrandMaterialContext = {
  workspaceId: 'brand-20',
  brandName: '鲸跃科技',
  productLines: ['旗舰产品'],
};

function material(overrides: Partial<BrandMaterial> = {}): BrandMaterial {
  return {
    id: 'material-20',
    workspaceId: 'brand-20',
    importedBySessionId: 'session-20',
    inputKind: 'file',
    displayName: '品牌介绍.docx',
    fileExt: 'docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    relativePath: 'materials/material-20.docx',
    byteSize: 12,
    sha256: 'a'.repeat(64),
    source: { type: 'file' },
    status: 'stored',
    attemptCount: 0,
    createdAt: '2026-08-31T00:00:00Z',
    updatedAt: '2026-08-31T00:00:00Z',
    ...overrides,
  };
}

/** 最小 PNG 头（签名 + IHDR 宽高）：宽高逐张不同保证 sha256 互异不触发文档内去重。 */
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

/** 与 material-import.unit.test.ts 同构的构造 docx（正文 xml + 媒体目录）。 */
function ooxmlDocx(media: Record<string, Uint8Array>): Uint8Array {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from('<w:document><w:body><w:p><w:r><w:t>鲸跃科技</w:t></w:r></w:p></w:body></w:document>'),
  );
  for (const [name, bytes] of Object.entries(media)) zip.addFile(`word/media/${name}`, Buffer.from(bytes));
  return new Uint8Array(zip.toBuffer());
}

class CombinationMaterialPort implements BrandMaterialPort {
  readonly savedImages: SaveMaterialImageInput[] = [];
  readonly pooledSha = new Map<string, string>();
  private readonly materials = new Map<string, BrandMaterial>();
  private readonly bytes = new Map<string, Uint8Array>();

  constructor(documentBytes: Uint8Array) {
    const item = material();
    this.materials.set(item.id, item);
    this.bytes.set(item.id, documentBytes);
  }

  async context() { return context; }
  async importFile(): Promise<BrandMaterial> { throw new Error('not used in this test'); }
  async importText(): Promise<BrandMaterial> { throw new Error('not used in this test'); }
  async get(id: string) {
    const item = this.materials.get(id);
    if (!item) throw new Error('material_not_found');
    return item;
  }
  async content(id: string) {
    const content = this.bytes.get(id);
    if (!content) throw new Error('material_content_unavailable');
    return content;
  }
  async delete(): Promise<void> { throw new Error('not used in this test'); }
  async begin(id: string) {
    const item = this.materials.get(id);
    if (item) item.attemptCount += 1;
    return { id: `attempt-${id}-${item?.attemptCount ?? 1}`, materialId: id, attemptNumber: item?.attemptCount ?? 1 };
  }
  async finish(input: {
    attemptId: string;
    materialId: string;
    status: 'awaiting-confirmation' | 'processed' | 'failed';
    candidateIds: string[];
    errorCode?: string;
  }) {
    const item = this.materials.get(input.materialId) ?? material({ id: input.materialId });
    item.status = input.status;
    item.lastErrorCode = input.errorCode;
    this.materials.set(item.id, item);
    return item;
  }
  async list() { return []; }
  async listDocumentMaterials() { return []; }
  async saveImageAsset(input: SaveMaterialImageInput) {
    this.savedImages.push(input);
    const existing = this.pooledSha.get(input.sha256);
    if (existing) return { id: existing, deduplicated: true };
    const id = `image-${this.pooledSha.size + 1}`;
    this.pooledSha.set(input.sha256, id);
    return { id, deduplicated: false };
  }
  async listImageAssets() { return []; }
  async imageAssetContent(): Promise<{ bytes: Uint8Array; mediaType: string }> {
    throw new Error('not used in this test');
  }
}

function knowledgeCandidate(input: KnowledgeProposalInput): KnowledgeCandidate {
  return {
    id: `candidate-${input.key.predicate}`,
    workspaceId: 'brand-20',
    sessionId: 'session-20',
    key: {
      subject: input.key.subject,
      predicate: input.key.predicate,
      scopeJson: '{}',
      effectiveFrom: null,
      effectiveTo: null,
      identity: `brand|${input.key.predicate}|{}||`,
    },
    valueJson: '"鲸跃科技"',
    normalizedValueJson: '"鲸跃科技"',
    unit: null,
    source: { materialId: 'material-20', excerpt: '组合测试候选', confidence: 0.9 },
    origin: 'model-inferred',
    intent: 'knowledge-update',
    status: 'awaiting-confirmation',
    baseVersion: 0,
    proposedAt: '2026-08-31T00:00:00Z',
    current: null,
  };
}

const jsonOk = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const extractionResponse = () => JSON.stringify({
  facts: [
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

const taggingResponse = () => JSON.stringify({
  description: '文档内嵌的门店前台展台实拍',
  category: '产品实拍',
});

describe('material image pipeline through the admission-wrapped factory (票 #20)', () => {
  it('pools embedded docx images when the service consumes wrapGeoProviderCapabilities output', async () => {
    // 23 张内嵌图对齐真实事故场景（炊班主知识库.docx，23 张内嵌 JPEG）。
    const media: Record<string, Uint8Array> = {};
    for (let index = 0; index < 23; index += 1) {
      media[`image${index + 1}.png`] = pngFixtureBytes(800 + index, 600 + index);
    }
    const port = new CombinationMaterialPort(ooxmlDocx(media));

    // 打标调用走 ark 端点（image_url 多模态消息体）；文本抽取走 deepseek
    // 端点。全部由 fake fetch 应答，零真实网络。
    const describeImageRequests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (target.startsWith('https://api.deepseek.com/')) {
        return jsonOk({ choices: [{ message: { content: extractionResponse() } }] });
      }
      if (target.startsWith('https://ark.cn-beijing.volces.com/')) {
        if (body.includes('image_url')) {
          describeImageRequests.push(body);
          return jsonOk({ choices: [{ message: { content: taggingResponse() } }] });
        }
        return jsonOk({ choices: [{ message: { content: '（搜索兜底：无竞品候选）' } }] });
      }
      throw new Error(`unexpected upstream fetch in test: ${target}`);
    });

    // admission 包装层要求的 management hop：permit 直接获取并记录 acquire
    // 载荷（断言 describeImage 的计量单元走 keyword-search 槽）。
    const acquirePayloads: Array<Record<string, unknown>> = [];
    let released = 0;
    moduleMocks.managementApi.mockReset();
    moduleMocks.managementApi.mockImplementation(
      async (path: string, _method: string, body: Record<string, unknown>) => {
        const payload = body.payload as Record<string, unknown>;
        if (path.endsWith('/acquire')) {
          acquirePayloads.push(payload);
          return {
            ok: true,
            permit: {
              state: 'acquired',
              requestId: payload.requestId,
              permitToken: `permit-${acquirePayloads.length}`,
              queueReason: null,
              queuePosition: null,
              concurrencyLimit: 5,
              activeCount: 0,
            },
          };
        }
        if (path.endsWith('/release')) {
          released += 1;
          return { ok: true, released: true };
        }
        throw new Error(`unexpected management call in test: ${path}`);
      },
    );

    vi.stubEnv('XIAOJING_SIDECAR_ID', 'sidecar-20');
    configureGeoProviderAdmission({ workspacePath: '/brands/brand-20', sessionId: 'session-20' });
    try {
      const capabilities = createGeoProviderCapabilities(
        { deepseekApiKey: 'test-deepseek-key', arkApiKey: 'test-ark-key' },
        { fetch: fetchImpl as unknown as typeof fetch },
      );
      const wrapped = wrapGeoProviderCapabilities(capabilities);
      // 票 #20 的直接红信号：包装层必须透传工厂的 describeImage。
      expect(wrapped.keywordSearch.describeImage).toBeTypeOf('function');

      const service = new MaterialImportService(
        { workspaceId: 'brand-20', sessionId: 'session-20' },
        port,
        wrapped.extraction,
        {
          propose: async (input: KnowledgeProposalInput) => knowledgeCandidate(input),
          inspect: async () => null,
        },
        {
          // 正文抓取在组合测试中保持关闭（无真实网络）。
          fetch: async () => { throw new Error('page-fetch disabled in combination test'); },
          dispatcherFor: async () => undefined,
        },
        wrapped.keywordSearch,
      );

      const result = await service.process('material-20');

      expect(result.ok).toBe(true);
      // 全链路入池：23 张互异图片各自完成一次真实 describeImage 调用并落库。
      expect(describeImageRequests).toHaveLength(23);
      expect(port.savedImages).toHaveLength(23);
      // 每次打标都是一次独立的 keyword-search/image-tag 计量单元。
      const imageTagAcquires = acquirePayloads.filter((payload) => payload.unitKind === 'image-tag');
      expect(imageTagAcquires).toHaveLength(23);
      for (const payload of imageTagAcquires) {
        expect(payload.slot).toBe('keyword-search');
      }
      // permit 卫生：取到的许可全部释放（23 打标 + 1 文本抽取）。
      expect(released).toBe(acquirePayloads.length);
      expect(acquirePayloads.length).toBe(24);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
