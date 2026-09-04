import { describe, expect, it, vi } from "vitest";

import {
  createGatewayBillingPermitChannel,
  GatewayBillingError,
  type GeoBillingPermitProjection,
} from "./billing-permit";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const permit: GeoBillingPermitProjection = {
  permitId: "pm-1",
  operation: "question_pool",
  units: 1,
  totalPoints: 15,
  status: "open",
  frozenPoints: 15,
  consumedPoints: 0,
  refundedPoints: 0,
};

describe("gateway billing permit channel", () => {
  it("applies permits with operation + units only (server-side pricing) and the account token", async () => {
    const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(input),
          auth: new Headers(init?.headers).get("authorization") ?? undefined,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        if (String(input).endsWith("/billing/permits"))
          return jsonResponse({ permit }, 201);
        if (String(input).endsWith("/billing/balance"))
          return jsonResponse({ balance: { total: 500, frozen: 15, available: 485 } });
        return jsonResponse({ permit: { ...permit, status: "settled" } });
      },
    );
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test/", accessToken: "account-token-1" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0 },
    );

    const applied = await channel.apply({
      permitId: "pm-1",
      operation: "question_pool",
      units: 1,
    });
    expect(applied).toEqual(permit);
    await channel.reportUnit("pm-1", 0, "success");
    await channel.close("pm-1");
    const balance = await channel.balance();

    expect(calls).toEqual([
      {
        method: "POST",
        url: "https://gw.example.test/billing/permits",
        auth: "Bearer account-token-1",
        body: { permitId: "pm-1", operation: "question_pool", units: 1 },
      },
      {
        method: "POST",
        url: "https://gw.example.test/billing/permits/pm-1/report",
        auth: "Bearer account-token-1",
        body: { unit: 0, outcome: "success" },
      },
      {
        method: "POST",
        url: "https://gw.example.test/billing/permits/pm-1/close",
        auth: "Bearer account-token-1",
        body: {},
      },
      {
        method: "GET",
        url: "https://gw.example.test/billing/balance",
        auth: "Bearer account-token-1",
        body: undefined,
      },
    ]);
    expect(balance).toEqual({ total: 500, frozen: 15, available: 485 });
  });

  it("surfaces typed server errors with code, status and point details", async () => {
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse(
          {
            error: "insufficient_balance",
            message: "点数不足：本次需 15 点，当前可用 4 点，请充值后再试。",
            required: 15,
            available: 4,
          },
          402,
        ),
    );
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0 },
    );

    const thrown = await channel
      .apply({ permitId: "pm-need", operation: "question_pool", units: 1 })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(thrown).toBeInstanceOf(GatewayBillingError);
    const error = thrown as GatewayBillingError;
    expect(error).toMatchObject({
      code: "insufficient_balance",
      status: 402,
      details: { required: 15, available: 4 },
    });
    expect(error.message).toContain("需 15 点");
  });

  it("retries transient transport failures then reports a typed error without leaking internals", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      throw new TypeError("connect ECONNREFUSED 10.0.0.9:443 secret-internal");
    });
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        transportRetries: 2,
        sleep,
      },
    );

    const thrown = await channel
      .apply({ permitId: "pm-net", operation: "baseline_probe", units: 3 })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(thrown).toBeInstanceOf(GatewayBillingError);
    const error = thrown as GatewayBillingError;
    expect(error).toMatchObject({ code: "billing_transport_failed", status: 0 });
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats a conflicting unit replay as already accounted instead of blocking recovery", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "unit_outcome_conflict",
          message: "单位 0 已回报为 failure，不能改报 success。",
        },
        409,
      ),
    );
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0 },
    );

    await expect(
      channel.reportUnit("pm-replay", 0, "success"),
    ).resolves.toBeUndefined();
  });

  // 回归（2026-09-04 实测）：并发名额被占（429 concurrency_limit）时 apply
  // 有界退避重试，等别的操作结清释放槽位，而不是立刻以失败终态落库。
  it("retries apply on concurrency_limit and succeeds once a slot frees up", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) {
        return jsonResponse({ error: "concurrency_limit", message: "并发计费操作已达上限（2）。", limit: 2, active: 2 }, 429);
      }
      return jsonResponse({ permit }, 201);
    });
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0, concurrencyRetries: 2, sleep },
    );

    const applied = await channel.apply({ permitId: "pm-race", operation: "question_pool", units: 1 });
    expect(applied).toEqual(permit);
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("surfaces the typed concurrency rejection after bounded apply retries", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "concurrency_limit", message: "并发计费操作已达上限（2）。", limit: 2, active: 2 }, 429),
    );
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0, concurrencyRetries: 1, sleep },
    );

    const thrown = await channel
      .apply({ permitId: "pm-stuck", operation: "question_pool", units: 1 })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(thrown).toBeInstanceOf(GatewayBillingError);
    expect(thrown).toMatchObject({ code: "concurrency_limit", status: 429 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry apply rejections that are not transient (balance)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "insufficient_balance", message: "点数不足。", required: 20, available: 4 }, 402),
    );
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0, concurrencyRetries: 2, sleep },
    );

    await expect(
      channel.apply({ permitId: "pm-need2", operation: "question_pool", units: 1 }),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries settle calls on gateway 5xx and resolves once the gateway recovers", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts <= 2
        ? jsonResponse({ error: "internal_error", message: "网关内部错误。" }, 502)
        : jsonResponse({ permit: { ...permit, status: "settled" } });
    });
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0, settleRetries: 2, sleep },
    );

    await expect(channel.reportUnit("pm-flaky", 0, "success")).resolves.toBeUndefined();
    await expect(channel.close("pm-flaky")).resolves.toBeUndefined();
    expect(attempts).toBe(4);
  });

  // 悬挂 permit 不能静默泄漏：结算重试耗尽后必须留下脱敏日志（类名 +
  // code/status，自由文本 message 不进日志），给排查与对账留线索。
  it("logs a sanitized settle-failure line when close keeps failing on 5xx", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "internal_error", message: "网关内部错误，含内部细节。" }, 503),
    );
    const sleep = vi.fn(async () => undefined);
    const channel = createGatewayBillingPermitChannel(
      { baseUrl: "https://gw.example.test", accessToken: "t" },
      { fetch: fetchImpl as unknown as typeof fetch, transportRetries: 0, settleRetries: 1, sleep },
    );

    try {
      await expect(channel.close("pm-leak")).rejects.toMatchObject({ code: "internal_error" });
      const line = spy.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes("[billing] settle failed"));
      expect(line).toBeDefined();
      expect(line).toContain('"op":"close"');
      expect(line).toContain("pm-leak");
      expect(line).toContain("internal_error");
      // 自由文本 message 不进日志。
      expect(line).not.toContain("内部细节");
    } finally {
      spy.mockRestore();
    }
  });
});
