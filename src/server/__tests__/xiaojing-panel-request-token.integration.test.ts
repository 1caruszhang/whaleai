import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 票 B 回归钉（spec：geo-service-composition Implementation Decision 7）：
// HTTP 面板/卡片路由的网关调用携带请求级新鲜账号 token
// （x-xiaojing-account-token 头，与 Rust 侧 ACCOUNT_TOKEN_HEADER 逐字节
// 一致），从请求头提取后传入组合根——sidecar 长跑后 env 单例过期，面板
// 确认/重试/重生成不再 401（6594d58 前科的隐患族闭合）。断言在能力层
// （mock provider-runtime，仓库既有模块 mock 习惯）：真实路由 → 真实
// 组合根构造出的服务，其能力与计费通道携带的 token 来自请求头而非 env
// 单例；未携带头时回退启动单例口径。三个域路由文件共用同一提取与传参
// 约定（逐文件复制），各驱动一条代表路由钉住。

const mocks = vi.hoisted(() => ({
  capabilitiesForRequest: vi.fn(),
  billingForRequest: vi.fn(),
  topicPlanCtor: vi.fn(),
  questionPoolCtor: vi.fn(),
  baselineCtor: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  getSessionId: () => 'session-panel-1',
  enqueueUserMessage: vi.fn(),
}));

vi.mock('../xiaojing-reminder-send', () => ({
  sendXiaojingMessage: vi.fn(async () => ({ success: true })),
}));

vi.mock('../geo/operation-progress', () => ({
  recordGeoOperationMilestone: vi.fn(async () => {}),
  quoteGeoNextStepForGateKind: vi.fn(async () => null),
  quoteGeoNextStepForAction: vi.fn(() => null),
}));

vi.mock('../geo/provider-runtime', () => {
  const capabilities = (token?: string) => ({
    keywordSearch: { __token: token ?? 'ENV_SINGLETON' },
    generation: { __token: token ?? 'ENV_SINGLETON' },
    embedding: { __token: token ?? 'ENV_SINGLETON' },
    distribution: { __token: token ?? 'ENV_SINGLETON' },
    extraction: { __token: token ?? 'ENV_SINGLETON' },
    reflection: { __token: token ?? 'ENV_SINGLETON' },
  });
  return {
    getXiaojingGeoProviderCapabilities: vi.fn(capabilities),
    getXiaojingGeoProviderCapabilitiesForRequest:
      mocks.capabilitiesForRequest.mockImplementation(capabilities),
    getXiaojingGeoBillingPermitChannel: vi.fn(() => ({
      __channel: 'singleton',
    })),
    getXiaojingGeoBillingPermitChannelForRequest:
      mocks.billingForRequest.mockImplementation((token?: string) =>
        token
          ? { __channel: 'request', token }
          : { __channel: 'singleton' }),
  };
});

vi.mock('../geo/topic-plan', () => {
  class TopicPlanService {
    readonly received: unknown[];
    constructor(...received: unknown[]) {
      this.received = received;
      mocks.topicPlanCtor(this);
    }
    async latest() {
      return null;
    }
  }
  return {
    TopicPlanService,
    createTopicPlanPort: vi.fn(() => ({ __port: 'topic-plan' })),
  };
});

vi.mock('../geo/question-pool', () => {
  class QuestionPoolService {
    readonly received: unknown[];
    constructor(...received: unknown[]) {
      this.received = received;
      mocks.questionPoolCtor(this);
    }
    async latest() {
      return null;
    }
  }
  return {
    QuestionPoolService,
    createQuestionPoolPort: vi.fn(() => ({ __port: 'question-pool' })),
  };
});

vi.mock('../geo/baseline', () => {
  class GeoBaselineService {
    readonly received: unknown[];
    constructor(...received: unknown[]) {
      this.received = received;
      mocks.baselineCtor(this);
    }
    async latest() {
      return null;
    }
  }
  return {
    GeoBaselineService,
    createGeoBaselinePort: vi.fn(() => ({ __port: 'baseline' })),
  };
});

let workspace: string;
let workspaceId: string;
let handleContentPipeline: (typeof import('../routes/xiaojing-content-pipeline'))['handleXiaojingContentPipelineRoute'];
let handleQuestionPools: (typeof import('../routes/xiaojing-question-pools'))['handleXiaojingQuestionPoolsRoute'];
let handleEffects: (typeof import('../routes/xiaojing-effects'))['handleXiaojingEffectsRoute'];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-panel-token-ws-'));
  workspaceId = basename(workspace);
  ({ handleXiaojingContentPipelineRoute: handleContentPipeline } =
    await import('../routes/xiaojing-content-pipeline'));
  ({ handleXiaojingQuestionPoolsRoute: handleQuestionPools } =
    await import('../routes/xiaojing-question-pools'));
  ({ handleXiaojingEffectsRoute: handleEffects } =
    await import('../routes/xiaojing-effects'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

interface CapturedService {
  received: unknown[];
}

function lastConstructed(ctor: ReturnType<typeof vi.fn>): CapturedService {
  const instance = ctor.mock.calls.at(-1)?.[0] as
    | CapturedService
    | undefined;
  expect(instance, '面板路由必须经组合根构造领域服务').toBeDefined();
  return instance!;
}

function post(
  pathname: string,
  body: Record<string, unknown>,
  accountToken?: string,
): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(accountToken
        ? { 'x-xiaojing-account-token': accountToken }
        : {}),
    },
  });
}

const identityPayload = (): Record<string, unknown> => ({
  workspaceId,
  sessionId: 'session-panel-1',
});

interface PanelRouteCase {
  label: string;
  run: (request: Request) => Promise<Response | null>;
  /** 服务构造捕获 spy：TopicPlanService / QuestionPoolService / GeoBaselineService。 */
  ctor: ReturnType<typeof vi.fn>;
  /** ctor 参数序里能力对象的位置（topic-plan 的 generation、question-pool/baseline 的 keywordSearch）。 */
  capabilityArg: number;
  /** ctor 参数序里计费通道的位置。 */
  billingArg: number;
}

const PANEL_ROUTES: PanelRouteCase[] = [
  {
    label: '内容管线（topic-plans/latest）',
    run: (request) =>
      handleContentPipeline('/api/xiaojing/topic-plans/latest', request, {
        workspacePath: workspace,
      }),
    ctor: mocks.topicPlanCtor,
    capabilityArg: 2,
    billingArg: 5,
  },
  {
    label: '问题池（question-pools/latest）',
    run: (request) =>
      handleQuestionPools('/api/xiaojing/question-pools/latest', request, {
        workspacePath: workspace,
      }),
    ctor: mocks.questionPoolCtor,
    capabilityArg: 2,
    billingArg: 5,
  },
  {
    label: '基线（geo-baselines/latest）',
    run: (request) =>
      handleEffects('/api/xiaojing/geo-baselines/latest', request, {
        workspacePath: workspace,
      }),
    ctor: mocks.baselineCtor,
    capabilityArg: 2,
    billingArg: 4,
  },
];

describe.each(PANEL_ROUTES)('面板路由 $label 的请求级 token（票 B）', (route) => {
  it('携带账号 token 头时，能力与计费通道取请求级 token 而非 env 单例', async () => {
    const response = await route.run(
      post('/ignored', identityPayload(), 'panel-request-token-1'),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ success: true });

    expect(mocks.capabilitiesForRequest).toHaveBeenCalledWith(
      'panel-request-token-1',
    );
    expect(mocks.billingForRequest).toHaveBeenCalledWith(
      'panel-request-token-1',
    );
    const service = lastConstructed(route.ctor);
    expect(
      (service.received[route.capabilityArg] as { __token: string }).__token,
    ).toBe('panel-request-token-1');
    expect(service.received[route.billingArg]).toEqual({
      __channel: 'request',
      token: 'panel-request-token-1',
    });
  });

  it('未携带账号 token 头时回退启动单例口径', async () => {
    const response = await route.run(post('/ignored', identityPayload()));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ success: true });

    expect(mocks.capabilitiesForRequest).toHaveBeenCalledWith(undefined);
    expect(mocks.billingForRequest).toHaveBeenCalledWith(undefined);
    const service = lastConstructed(route.ctor);
    expect(
      (service.received[route.capabilityArg] as { __token: string }).__token,
    ).toBe('ENV_SINGLETON');
    expect(service.received[route.billingArg]).toEqual({
      __channel: 'singleton',
    });
  });
});
