/**
 * 网关计费 permit 通道（票 07）：Sidecar 各计费域服务的预扣/回报/结清
 * 客户端。定价权威在后端（`backend/src/domain/pricing.ts`）——申请只携带
 * 操作类型 + 单位数，服务端按其价目表预扣；逐最小成败单位回报，失败单位
 * 自动回补；permitId 是客户端生成的幂等键，网络重试/恢复重跑重放同一
 * 申请不二次预扣。缓存命中在调用方直接跳过本通道（浏览/预览/读取历史
 * 永不触碰）。
 */

/** 与 backend/src/domain/pricing.ts 的 BillingOperation 对齐（服务端校验）。 */
export type GeoBillingOperation =
  | "material_import"
  | "question_pool"
  | "baseline_probe"
  | "topic_planning"
  | "topic_planning_regen"
  | "article_generation"
  | "article_rewrite"
  | "distribution_planning"
  | "monitoring_patrol";

export interface GeoBillingPermitProjection {
  permitId: string;
  operation: string;
  units: number;
  totalPoints: number;
  status: "open" | "settled";
  frozenPoints: number;
  consumedPoints: number;
  refundedPoints: number;
}

export interface GeoBillingBalanceSnapshot {
  total: number;
  frozen: number;
  available: number;
}

/** 类型化计费错误：code 透传服务端语义码（insufficient_balance 等）。 */
export class GatewayBillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, number | string>> = {},
  ) {
    super(message);
    this.name = "GatewayBillingError";
  }
}

export interface GeoBillingPermitChannel {
  /** 申请 permit（预扣）。permitId 为幂等键；重放返回既有投影。 */
  apply(input: {
    permitId: string;
    operation: GeoBillingOperation;
    units: number;
  }): Promise<GeoBillingPermitProjection>;
  /** 逐最小成败单位回报；同单位同结果重放幂等。 */
  reportUnit(
    permitId: string,
    unit: number,
    outcome: "success" | "failure",
  ): Promise<void>;
  /** 结清（中止收尾）：未回报单位全部按失败回补；幂等。 */
  close(permitId: string): Promise<void>;
  /** 余额快照（计费操作前的余额预检用，如监测巡检）。 */
  balance(): Promise<GeoBillingBalanceSnapshot>;
}

/** 计费域服务依赖的最小 permit 面（便于测试注入与未登录开发模式缺省）。 */
export type GeoBillingPermitPort = Pick<
  GeoBillingPermitChannel,
  "apply" | "reportUnit" | "close"
>;

export interface GatewayBillingChannelDependencies {
  fetch?: typeof fetch;
  /** 瞬时网络失败的有界重试次数（缺省 2 次，指数退避）。 */
  transportRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function projectionOf(value: unknown): GeoBillingPermitProjection {
  const permit = value as Partial<GeoBillingPermitProjection>;
  if (
    typeof permit.permitId !== "string" ||
    (permit.status !== "open" && permit.status !== "settled")
  ) {
    throw new GatewayBillingError(
      "billing_permit_projection_invalid",
      "网关返回的 permit 投影无效。",
      0,
    );
  }
  return {
    permitId: permit.permitId,
    operation: typeof permit.operation === "string" ? permit.operation : "",
    units: typeof permit.units === "number" ? permit.units : 0,
    totalPoints: typeof permit.totalPoints === "number" ? permit.totalPoints : 0,
    status: permit.status,
    frozenPoints:
      typeof permit.frozenPoints === "number" ? permit.frozenPoints : 0,
    consumedPoints:
      typeof permit.consumedPoints === "number" ? permit.consumedPoints : 0,
    refundedPoints:
      typeof permit.refundedPoints === "number" ? permit.refundedPoints : 0,
  };
}

export function createGatewayBillingPermitChannel(
  input: { baseUrl: string; accessToken: string },
  deps: GatewayBillingChannelDependencies = {},
): GeoBillingPermitChannel {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const token = input.accessToken.trim();
  const fetchImpl = deps.fetch ?? fetch;
  const maxRetries = deps.transportRetries ?? 2;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: unknown }> => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let payload: unknown;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = {};
        }
        return { status: response.status, payload };
      } catch {
        if (attempt < maxRetries) await sleep(250 * 2 ** attempt);
      }
    }
    // 不透传底层异常文案（可能带地址/网络内部信息）。
    throw new GatewayBillingError(
      "billing_transport_failed",
      "计费网关暂不可达，请稍后重试。",
      0,
    );
  };

  const call = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    pick: (payload: Record<string, unknown>) => unknown = (payload) => payload,
  ): Promise<T> => {
    const { status, payload } = await request(method, path, body);
    if (!(status >= 200 && status < 300)) {
      const holder = (payload ?? {}) as Record<string, unknown>;
      throw new GatewayBillingError(
        typeof holder.error === "string" ? holder.error : "billing_failed",
        typeof holder.message === "string"
          ? holder.message
          : "计费网关请求失败。",
        status,
        typeof holder.required === "number" || typeof holder.available === "number"
          ? {
              ...(typeof holder.required === "number"
                ? { required: holder.required }
                : {}),
              ...(typeof holder.available === "number"
                ? { available: holder.available }
                : {}),
            }
          : {},
      );
    }
    return pick(payload as Record<string, unknown>) as T;
  };

  return {
    async apply({ permitId, operation, units }) {
      return call<GeoBillingPermitProjection>(
        "POST",
        "/billing/permits",
        { permitId, operation, units },
        (payload) => projectionOf(payload.permit),
      );
    },
    async reportUnit(permitId, unit, outcome) {
      try {
        await call("POST", `/billing/permits/${encodeURIComponent(permitId)}/report`, {
          unit,
          outcome,
        });
      } catch (error) {
        // 同单位已按更早结果回报（恢复重跑中结果漂移）：首个结果为准，
        // 不重复扣也不阻断业务收尾。
        if (
          error instanceof GatewayBillingError &&
          error.code === "unit_outcome_conflict"
        ) {
          return;
        }
        throw error;
      }
    },
    async close(permitId) {
      // 结清幂等（服务端对已结清 permit 重放 close 返回 200）。
      await call(
        "POST",
        `/billing/permits/${encodeURIComponent(permitId)}/close`,
        {},
      );
    },
    async balance() {
      return call<GeoBillingBalanceSnapshot>(
        "GET",
        "/billing/balance",
        undefined,
        (payload) => {
          const balance = (payload.balance ?? {}) as Record<string, unknown>;
          if (
            typeof balance.total !== "number" ||
            typeof balance.frozen !== "number" ||
            typeof balance.available !== "number"
          ) {
            throw new GatewayBillingError(
              "billing_balance_projection_invalid",
              "网关返回的余额投影无效。",
              0,
            );
          }
          return {
            total: balance.total,
            frozen: balance.frozen,
            available: balance.available,
          };
        },
      );
    },
  };
}
