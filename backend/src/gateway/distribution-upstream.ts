import type { BackendDeps } from '../deps';
import { AppError } from '../errors';
import { priceToCents } from '../domain/distribution-resources';
import type { PublishOrderKind } from '../domain/types';
import { signSupermediaQuery, signSupermediaQueryWithLists } from './provider-signing';

/**
 * 超级媒介上游客户端（票 08）：下单/查单/订单操作/资源查询的统一重签出口。
 * 签名规则与票 05 资源读取完全同源（展平 HMAC-SHA256 + timestamp 现取），
 * 上游密钥只经 config 进入、只出现在对上游的 query 签名里。
 *
 * 参数 wire 取舍：上游文档未指定 POST body 编码，签名的权威形态是「参数
 * 集」（$_REQUEST 语义），故业务参数一律放 query string（POST 空 body），
 * 与 GET 端点同构、可测且免去 body 编码歧义；title/content 的 urlencode
 * 由 URLSearchParams 编码保证。
 */

/** 订单操作路径（催稿/取消/申请退款/申请补发）。 */
export type DistributionOrderAction = 'urge' | 'cancel' | 'apply-refund' | 'apply-republish';

export interface UpstreamOrderPlacement {
  sn: string;
  resourceId: number;
  title: string;
  contentUrl: string;
  remark?: string;
  owner?: string;
  /** 自媒体订单必填三元组（上游文档）。 */
  publishForm?: number;
  publishType?: number;
  accountRule?: number;
}

/** 上游查单条目（screenshot 为用户来源 HTML，只透传给客户端展示栈，绝不入库）。 */
export interface UpstreamOrderSnapshot {
  sn: string;
  status: number;
  url: string | null;
  publishedAt: string | null;
  feedback: Record<string, unknown> | null;
}

export interface UpstreamResourceSnapshot {
  id: number;
  name: string;
  priceCents: number;
  status: number | null;
}

export type UpstreamCallResult<T> =
  | { ok: true; data: T; text: string }
  /**
   * 上游失败：HTTP 非 2xx 透传原状态码；2xx 但业务 code != 200（或响应
   * 形态不符）归一为 502。response 正文交路由层清洗回传（上游 message
   * 可能携带内部信息，不经本字段外发）。
   */
  | { ok: false; response: Response };

interface UpstreamEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

function kindPath(kind: PublishOrderKind): string {
  return kind === 'media' ? '/media' : '/we-media';
}

export class DistributionUpstream {
  constructor(
    private readonly deps: BackendDeps,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  private async call(path: string, query: URLSearchParams, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; envelope: UpstreamEnvelope; text: string }> {
    const config = this.deps.config;
    let response: Response;
    try {
      response = await this.fetchImpl(`${config.distributionBaseUrl}${path}?${query}`, {
        method,
        headers: { Accept: 'application/json' },
        ...(method === 'POST' ? { body: '' } : {}),
      });
    } catch {
      // 不透传底层异常文案（可能携带上游地址、密钥等内部信息）。
      throw new AppError('upstream_unavailable', '上游服务暂不可用，请稍后重试。', 502);
    }
    const text = await response.text();
    let envelope: UpstreamEnvelope = {};
    try {
      envelope = JSON.parse(text) as UpstreamEnvelope;
    } catch {
      // 非 JSON 正文（异常页面等）：按失败处理。
    }
    return { status: response.status, envelope, text };
  }

  private signedFlat(businessParams: Record<string, string | number>): URLSearchParams {
    const { distributionAppId, distributionSecret } = this.deps.config;
    return signSupermediaQuery(
      distributionAppId,
      distributionSecret,
      Math.floor(this.deps.now() / 1000),
      businessParams,
    );
  }

  private signedList(
    businessParams: Record<string, string | number | readonly string[]>,
  ): URLSearchParams {
    const { distributionAppId, distributionSecret } = this.deps.config;
    return signSupermediaQueryWithLists(
      distributionAppId,
      distributionSecret,
      Math.floor(this.deps.now() / 1000),
      businessParams,
    );
  }

  private static fail(status: number, text: string): { ok: false; response: Response } {
    const responseStatus = status >= 200 && status < 300 ? 502 : status;
    return { ok: false, response: new Response(text, { status: responseStatus }) };
  }

  /** 创建订单：成功提取 partner_sn。 */
  async placeOrder(
    kind: PublishOrderKind,
    order: UpstreamOrderPlacement,
  ): Promise<UpstreamCallResult<{ partnerSn: string }>> {
    const business: Record<string, string | number> = {
      sn: order.sn,
      resource_id: order.resourceId,
      title: order.title,
      content: order.contentUrl,
    };
    if (order.remark !== undefined) business.remark = order.remark;
    if (order.owner !== undefined) business.owner = order.owner;
    if (order.publishForm !== undefined) business.publish_form = order.publishForm;
    if (order.publishType !== undefined) business.publish_type = order.publishType;
    if (order.accountRule !== undefined) business.account_rule = order.accountRule;
    const { status, envelope, text } = await this.call(`${kindPath(kind)}/order`, this.signedFlat(business), 'POST');
    if (status < 200 || status >= 300 || envelope.code !== 200) {
      return DistributionUpstream.fail(status, text);
    }
    const partnerSn = (envelope.data as { partner_sn?: unknown } | null | undefined)?.partner_sn;
    if (typeof partnerSn !== 'string' || partnerSn.length === 0) {
      return DistributionUpstream.fail(status, text);
    }
    return { ok: true, data: { partnerSn }, text };
  }

  /** 查单（幂等）：最多 20 个 sn，未收录的 sn 上游不返回条目。 */
  async queryOrders(
    kind: PublishOrderKind,
    sns: readonly string[],
  ): Promise<UpstreamCallResult<UpstreamOrderSnapshot[]>> {
    const { status, envelope, text } = await this.call(
      `${kindPath(kind)}/order/query`,
      this.signedList({ sn: sns }),
    );
    if (status < 200 || status >= 300 || envelope.code !== 200) {
      return DistributionUpstream.fail(status, text);
    }
    const items = Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>[]) : [];
    const snapshots: UpstreamOrderSnapshot[] = [];
    for (const item of items) {
      if (typeof item.sn !== 'string' || typeof item.status !== 'number') continue;
      snapshots.push({
        sn: item.sn,
        status: item.status,
        url: typeof item.url === 'string' ? item.url : null,
        publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
        feedback:
          item.feedback && typeof item.feedback === 'object' && !Array.isArray(item.feedback)
            ? (item.feedback as Record<string, unknown>)
            : null,
      });
    }
    return { ok: true, data: snapshots, text };
  }

  /** 订单操作（催稿/取消/申请退款/申请补发）。 */
  async orderAction(
    kind: PublishOrderKind,
    action: DistributionOrderAction,
    params: { sn: string; reason?: string },
  ): Promise<UpstreamCallResult<null>> {
    const business: Record<string, string | number> = params.reason === undefined ? { sn: params.sn } : { sn: params.sn, reason: params.reason };
    const { status, envelope, text } = await this.call(
      `${kindPath(kind)}/order/${action}`,
      this.signedFlat(business),
      'POST',
    );
    if (status < 200 || status >= 300 || envelope.code !== 200) {
      return DistributionUpstream.fail(status, text);
    }
    return { ok: true, data: null, text };
  }

  /** 资源查询（定价快照回源/回调刷新）：未收录 id 上游不返回条目。 */
  async queryResource(
    kind: PublishOrderKind,
    resourceId: number,
  ): Promise<UpstreamCallResult<UpstreamResourceSnapshot | null>> {
    const { status, envelope, text } = await this.call(
      `${kindPath(kind)}/resource/query`,
      this.signedList({ id: [String(resourceId)] }),
    );
    if (status < 200 || status >= 300 || envelope.code !== 200) {
      return DistributionUpstream.fail(status, text);
    }
    const items = Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>[]) : [];
    const item = items.find(candidate => candidate.id === resourceId);
    if (!item) return { ok: true, data: null, text };
    const priceCents = priceToCents(item.price as string | number | null | undefined);
    if (priceCents === null) {
      // 价格缺失按上游失败处理（502 + 清洗正文），下单不得无价冻结。
      return DistributionUpstream.fail(status, text);
    }
    return {
      ok: true,
      data: {
        id: resourceId,
        name: typeof item.name === 'string' ? item.name : '',
        priceCents,
        status: typeof item.status === 'number' ? item.status : null,
      },
      text,
    };
  }
}
