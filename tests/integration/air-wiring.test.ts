import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/air/route";
import type { AirApiError, AirApiSuccess } from "@/types/air";

import { FakeRedis } from "../fixtures/fakeRedis";
import { FETCHED_AT_MS, jsonResponse, makeOpenMeteoResponse } from "../fixtures/openMeteo";

/**
 * The REAL default wiring (env parsing, Redis client, tiered cache, limiter, gate, route) with the
 * network replaced by an in-process stand-in for BOTH Open-Meteo and Upstash. Nothing here touches
 * a live service.
 */

const SYMBOLS = ["air-service", "air-rate-limit-gate", "air-infrastructure"].map((n) => Symbol.for(`urban-air-intelligence.${n}`));
const REDIS_URL = "http://127.0.0.1:8079"; // http is allowed for localhost only
const REDIS_TOKEN = "FAKE-wiring-token-0123456789";

function resetGlobals() {
  for (const key of SYMBOLS) delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

interface Net {
  provider: { calls: number; healthy: boolean };
  redis: FakeRedis;
  redisRequests: { auth: string | null; body: string }[];
}

function installNetwork(): Net {
  const net: Net = {
    provider: { calls: 0, healthy: true },
    redis: new FakeRedis(() => Date.now()),
    redisRequests: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://air-quality-api.open-meteo.com/")) {
        net.provider.calls += 1;
        return Promise.resolve(net.provider.healthy ? jsonResponse(makeOpenMeteoResponse()) : new Response("down", { status: 503 }));
      }
      if (url.startsWith(REDIS_URL)) {
        const headers = init?.headers as Record<string, string> | undefined;
        net.redisRequests.push({ auth: headers?.Authorization ?? null, body: String(init?.body) });
        return net.redis
          .command(JSON.parse(String(init?.body)) as (string | number)[])
          .then((result) => jsonResponse({ result }))
          .catch(() => jsonResponse({ error: "ERR simulated" }, { status: 500 }));
      }
      return Promise.reject(new Error(`unexpected network call: ${url}`));
    }),
  );
  return net;
}

const call = (cityId = "mumbai", headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/air?cityId=${cityId}`, { headers }));

beforeEach(() => {
  resetGlobals();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FETCHED_AT_MS);
});

afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("default wiring without Redis (local development)", () => {
  it("serves from the provider, then from memory, and reports memory-only (not degraded outside production)", async () => {
    const net = installNetwork();
    vi.stubEnv("NODE_ENV", "development");
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-air-cache-capability")).toBe("memory-only");

    const second = await call();
    expect(second.headers.get("x-air-cache")).toBe("hit");
    expect(net.provider.calls).toBe(1);
    expect(net.redisRequests).toHaveLength(0);

    const data = ((await first.json()) as AirApiSuccess).data;
    expect(data.cache).toMatchObject({ capability: "memory-only", degraded: false });
  });

  it("in PRODUCTION it never claims durability: responses say degraded, and a warning is logged once", async () => {
    installNetwork();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");

    const data = ((await (await call()).json()) as AirApiSuccess).data;
    expect(data.cache).toMatchObject({ capability: "memory-only", degraded: true });
    await call("patna");

    const notices = warn.mock.calls.filter((c) => String(c[0]).includes("air.durable_cache_not_configured"));
    expect(notices).toHaveLength(1);
  });
});

describe("default wiring with Redis configured", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
    vi.stubEnv("NODE_ENV", "production");
  });

  it("stores the snapshot in Redis, reports persistent, and authenticates with a bearer token", async () => {
    const net = installNetwork();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-air-cache-capability")).toBe("persistent");

    const data = ((await response.json()) as AirApiSuccess).data;
    expect(data.cache).toMatchObject({ capability: "persistent", degraded: false });
    expect(net.redis.keys()).toContain("air:v1:snapshot:mumbai");
    expect(net.redisRequests.length).toBeGreaterThan(0);
    for (const request of net.redisRequests) expect(request.auth).toBe(`Bearer ${REDIS_TOKEN}`);
  });

  it("survives a cold start: with Redis intact and the provider down, it serves the stored reading as stale", async () => {
    const net = installNetwork();
    const original = ((await (await call()).json()) as AirApiSuccess).data;

    // A new serverless instance: empty memory (service rebuilt), same Redis; the provider is now down.
    delete (globalThis as unknown as Record<symbol, unknown>)[SYMBOLS[0]!];
    net.provider.healthy = false;
    vi.setSystemTime(FETCHED_AT_MS + 30 * 60_000);

    const response = await call();
    expect(response.status).toBe(200);
    const stale = ((await response.json()) as AirApiSuccess).data;
    expect(stale.freshnessStatus).toBe("stale");
    expect(stale.fetchedAt).toBe(original.fetchedAt);
    expect(stale.ageSeconds).toBe(30 * 60);
  });

  it("never exposes the token or URL in a response, a header or a log line", async () => {
    const net = installNetwork();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const responses = [await call(), await call("atlantis")];
    net.redis.down = "timeout";
    responses.push(await call("patna", { "x-forwarded-for": "198.51.100.5" }));

    const bodies = await Promise.all(responses.map((r) => r.clone().text()));
    const headers = responses.map((r) => JSON.stringify([...r.headers.entries()]));
    const logs = warn.mock.calls.map((c) => String(c[0]));
    const everything = [...bodies, ...headers, ...logs].join("\n");
    expect(everything).not.toContain(REDIS_TOKEN);
    expect(everything).not.toContain("127.0.0.1:8079");
    expect(everything).not.toContain("198.51.100.5");
  });

  it("limits requests through Redis, with the client key hashed", async () => {
    const net = installNetwork();
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "2");
    vi.stubEnv("TRUST_RENDER_CF_CONNECTING_IP", "true");
    const headers = { "cf-connecting-ip": "198.51.100.77" };
    const statuses = [(await call("mumbai", headers)).status, (await call("mumbai", headers)).status, (await call("mumbai", headers)).status];
    expect(statuses).toEqual([200, 200, 429]);
    const limiterKey = net.redis.keys().find((k) => k.startsWith("air:v1:rl:"));
    expect(limiterKey).toMatch(/^air:v1:rl:c:[0-9a-f]{32}$/);
  });

  it("with Redis down, refuses to call the provider and answers a controlled 503", async () => {
    const net = installNetwork();
    net.redis.down = "network";
    const response = await call();
    expect(response.status).toBe(503);
    expect(((await response.json()) as AirApiError).error.code).toBe("RATE_LIMITING_UNAVAILABLE");
    expect(net.provider.calls).toBe(0);
  });
});

describe("default wiring with an unusable Redis setting", () => {
  it("degrades to memory-only and names the offending variable, never its value", async () => {
    installNetwork();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake-only-url.upstash.io"); // token missing

    const response = await call();
    expect(response.status).toBe(200);
    expect(((await response.json()) as AirApiSuccess).data.cache).toMatchObject({ capability: "memory-only", degraded: true });

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("air.redis_config_invalid");
    expect(logged).toContain("UPSTASH_REDIS_REST_TOKEN");
    expect(logged).not.toContain("fake-only-url");
  });

  it("refuses an http (non-local) Redis URL instead of sending the token in clear text", async () => {
    const net = installNetwork();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://redis.example.com");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
    const response = await call();
    expect(response.status).toBe(200);
    expect(net.redisRequests).toHaveLength(0);
  });
});

describe("default wiring: rate-limit policy", () => {
  it("enforces AIR_RATE_LIMIT_MAX with the in-memory limiter when Redis is absent", async () => {
    installNetwork();
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "2");
    const statuses = [(await call()).status, (await call()).status, (await call()).status];
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("without Render trust, clients cannot be told apart, so a spoofed X-Forwarded-For does not help", async () => {
    installNetwork();
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "2");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call("mumbai", { "x-forwarded-for": `203.0.113.${i + 1}` })).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("without the Render trust flag, a spoofed CF-Connecting-IP does not give a client its own allowance", async () => {
    installNetwork();
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "2");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call("mumbai", { "cf-connecting-ip": `203.0.113.${i + 1}` })).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("on Render, distinct CF-Connecting-IP clients get separate allowances", async () => {
    installNetwork();
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "1");
    vi.stubEnv("TRUST_RENDER_CF_CONNECTING_IP", "true");
    expect((await call("mumbai", { "cf-connecting-ip": "198.51.100.1" })).status).toBe(200);
    expect((await call("mumbai", { "cf-connecting-ip": "198.51.100.1" })).status).toBe(429);
    expect((await call("mumbai", { "cf-connecting-ip": "198.51.100.2" })).status).toBe(200);
  });

  it("defaults to 30 requests per minute", async () => {
    installNetwork();
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = (await call()).status;
    expect(last).toBe(429);
  });

  it("fails closed (500, no detail) on an invalid rate-limit setting rather than running unprotected", async () => {
    const net = installNetwork();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "not-a-number");
    const response = await call();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toMatch(/AIR_RATE_LIMIT|not-a-number/);
    expect(net.provider.calls).toBe(0);
  });
});
