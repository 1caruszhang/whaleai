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
});
