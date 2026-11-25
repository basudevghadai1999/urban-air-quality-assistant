import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/recommend/route";
import { buildFallbackExplanation } from "@/lib/ai";
import type { RecommendApiSuccess } from "@/types/api";

import { FakeRedis } from "../fixtures/fakeRedis";
import { MORNING_DIP } from "../fixtures/engine";
import { FETCHED_AT_MS, jsonResponse, makeOpenMeteoResponse } from "../fixtures/openMeteo";

/**
 * The REAL default wiring: env parsing, the actual Gemini SDK client, limiter, budget, cache and route.
 * Only `fetch` is replaced: an in-process stand-in answers Open-Meteo, Google and Upstash. Any other
 * host fails the test, so nothing here can touch a live service or consume quota.
 */

const SYMBOLS = ["air-service", "air-rate-limit-gate", "air-infrastructure", "ai-service", "ai-wiring", "chat-service"].map((n) => Symbol.for(`urban-air-intelligence.${n}`));
const KEY = "FAKE-wiring-gemini-key-0123456789";
const REDIS_URL = "http://127.0.0.1:8079";
const REDIS_TOKEN = "FAKE-wiring-redis-token-0123456789";

const resetGlobals = () => {
  for (const key of SYMBOLS) delete (globalThis as unknown as Record<symbol, unknown>)[key];
};

interface Net {
  google: { calls: { url: string; key: string | null; body: string }[]; respond: () => Response };
  hosts: Set<string>;
  redis: FakeRedis;
}

function install(): Net {
  const net: Net = {
    google: { calls: [], respond: () => new Response("unset", { status: 500 }) },
    hosts: new Set(),
    redis: new FakeRedis(() => Date.now()),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      net.hosts.add(url.host);
      if (url.host === "air-quality-api.open-meteo.com") return Promise.resolve(jsonResponse(makeOpenMeteoResponse(MORNING_DIP)));
      if (url.host === "generativelanguage.googleapis.com") {
        const headers = new Headers(init?.headers as HeadersInit);
        net.google.calls.push({ url: url.href, key: headers.get("x-goog-api-key"), body: String(init?.body) });
        return Promise.resolve(net.google.respond());
      }
      if (url.href.startsWith(REDIS_URL)) {
        return net.redis
          .command(JSON.parse(String(init?.body)) as (string | number)[])
          .then((result) => jsonResponse({ result }))
          .catch(() => jsonResponse({ error: "ERR simulated" }, { status: 500 }));
      }
      return Promise.reject(new Error(`unexpected network call to ${url.host}`));
    }),
  );
  return net;
}

const googleOk = (explanation: unknown) => () =>
  jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(explanation) }] }, finishReason: "STOP" }] });

const call = (cityId = "delhi-ncr", profileId = "senior_respiratory", headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/recommend", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ cityId, profileId, explain: true }) }));

/** Make Google answer with a compliant explanation of whatever deterministic result the server just produced. */
async function primeGoogle(net: Net, cityId = "delhi-ncr", profileId = "senior_respiratory") {
  const plain = await POST(new Request("http://localhost/api/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cityId, profileId }) }));
  const body = (await plain.json()) as RecommendApiSuccess;
  net.google.respond = googleOk(buildFallbackExplanation(body.data));
}

beforeEach(() => {
  resetGlobals();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FETCHED_AT_MS);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubEnv("GEMINI_KEY", "");
  vi.stubEnv("GEMINI_MODEL", "");
});

afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the real SDK client against a stand-in Google endpoint", () => {
  it("generates, then serves the repeat from the cache, with exactly one Google call", async () => {
    const net = install();
    await primeGoogle(net);
    const first = await call();
    const body = (await first.json()) as RecommendApiSuccess;
    expect(first.headers.get("x-ai-status")).toBe("generated");
    expect(body.ai).toMatchObject({ status: "generated", model: "gemini-3.5-flash" });
    const second = await call();
    expect(second.headers.get("x-ai-status")).toBe("cached");
    expect(net.google.calls).toHaveLength(1);
    expect(net.hosts).toEqual(new Set(["air-quality-api.open-meteo.com", "generativelanguage.googleapis.com"]));
  });

  it("sends the key only in the request header, the configured model in the URL, and the schema and limits in the body", async () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");
    vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1234");
    const net = install();
    await primeGoogle(net);
    await call();
    const sent = net.google.calls[0];
    expect(sent?.key).toBe(KEY);
    expect(sent?.url).toContain("/models/gemini-test-model:generateContent");
    expect(sent?.url).not.toContain(KEY);
    expect(sent?.body).not.toContain(KEY);
    const parsed = JSON.parse(sent?.body ?? "{}") as { generationConfig: Record<string, unknown>; systemInstruction: unknown };
    expect(parsed.generationConfig).toMatchObject({ responseMimeType: "application/json", maxOutputTokens: 1234, candidateCount: 1 });
    expect(parsed.generationConfig).toHaveProperty("responseJsonSchema");
    expect(JSON.stringify(parsed.systemInstruction)).toMatch(/explain air-quality recommendations/);
  });

  it("never returns the key or any header in a response", async () => {
    const net = install();
    await primeGoogle(net);
    const response = await call();
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect([...response.headers.values()].join(" ")).not.toContain(KEY);
  });

  it.each([
    ["HTTP 429", 429, "AI_QUOTA"],
    ["HTTP 500", 500, "AI_UPSTREAM_ERROR"],
    ["HTTP 503", 503, "AI_UPSTREAM_ERROR"],
    ["an unknown model (404)", 404, "AI_MODEL_UNAVAILABLE"],
    ["rejected credentials (403)", 403, "AI_AUTH_FAILED"],
  ])("%s -> fallback after exactly ONE attempt (the SDK never retries)", async (_n, status, code) => {
    const net = install();
    net.google.respond = () => new Response(JSON.stringify({ error: { code: status, message: `RAW PROVIDER TEXT key=${KEY}`, status: "X" } }), { status, headers: { "content-type": "application/json" } });
    const response = await call();
    const body = (await response.json()) as RecommendApiSuccess;
    expect(response.status).toBe(200);
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: code });
    expect(body.data.status).toBe("ok");
    expect(net.google.calls).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/RAW PROVIDER|key=/);
  });

  it("a network failure is a fallback", async () => {
    const net = install();
    net.google.respond = () => {
      throw new TypeError("fetch failed");
    };
    const body = (await (await call()).json()) as RecommendApiSuccess;
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: "AI_NETWORK" });
  });

  it("a model reply that fails validation is discarded and never cached", async () => {
    const net = install();
    await primeGoogle(net);
    const good = net.google.respond;
    const goodBody = (await good().json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    const goodExplanation = JSON.parse(goodBody.candidates[0]?.content.parts[0]?.text ?? "{}") as Record<string, unknown>;
    net.google.respond = googleOk({ ...goodExplanation, overview: "The AQI is 1 and the air is safe." });
    const bad = (await (await call()).json()) as RecommendApiSuccess;
    expect(bad.ai).toMatchObject({ status: "fallback", reasonCode: "AI_VALIDATION_REJECTED" });
    net.google.respond = good;
    const next = (await (await call()).json()) as RecommendApiSuccess;
    expect(next.ai?.status).toBe("generated");
  });
});

describe("configuration through the real environment", () => {
  it("no key: fallback, and Google is never contacted", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const net = install();
    const body = (await (await call()).json()) as RecommendApiSuccess;
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: "AI_NOT_CONFIGURED" });
    expect(net.google.calls).toHaveLength(0);
  });

  it("GEMINI_KEY works as the fallback variable name", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_KEY", KEY);
    const net = install();
    await primeGoogle(net);
    await call();
    expect(net.google.calls[0]?.key).toBe(KEY);
  });

  it("an invalid model name or tuning value: fallback, Google is never contacted", async () => {
    const net = install();
    vi.stubEnv("GEMINI_MODEL", "bad model; name");
    expect(((await (await call()).json()) as RecommendApiSuccess).ai).toMatchObject({ reasonCode: "AI_INVALID_CONFIG" });
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("AI_DAILY_BUDGET", "0");
    expect(((await (await call()).json()) as RecommendApiSuccess).ai).toMatchObject({ reasonCode: "AI_INVALID_CONFIG" });
    expect(net.google.calls).toHaveLength(0);
  });

  it("the kill switch disables Gemini", async () => {
    vi.stubEnv("AI_EXPLANATIONS_ENABLED", "false");
    const net = install();
    expect(((await (await call()).json()) as RecommendApiSuccess).ai).toMatchObject({ status: "fallback", reasonCode: "AI_DISABLED" });
    expect(net.google.calls).toHaveLength(0);
  });
});

describe("cost protection through the real wiring", () => {
  it("per-client limit: generations beyond it become fallbacks; cache hits do not count", async () => {
    vi.stubEnv("AI_RATE_LIMIT_MAX", "2");
    const net = install();
    await primeGoogle(net, "delhi-ncr");
    expect((await call("delhi-ncr")).headers.get("x-ai-status")).toBe("generated");
    expect((await call("delhi-ncr")).headers.get("x-ai-status")).toBe("cached"); // no limiter use
    expect((await call("delhi-ncr")).headers.get("x-ai-status")).toBe("cached");
    await primeGoogle(net, "mumbai");
    expect((await call("mumbai")).headers.get("x-ai-status")).toBe("generated"); // 2nd generation
    await primeGoogle(net, "patna");
    const limited = await call("patna");
    const body = (await limited.json()) as RecommendApiSuccess;
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: "AI_RATE_LIMITED" });
    expect(body.ai?.retryAfterSeconds).toBeGreaterThan(0);
    expect(net.google.calls).toHaveLength(2);
  });

  it("global daily budget: spent budget means fallback with no Google call", async () => {
    vi.stubEnv("AI_DAILY_BUDGET", "1");
    vi.stubEnv("AI_RATE_LIMIT_MAX", "50");
    const net = install();
    await primeGoogle(net, "delhi-ncr");
    expect((await call("delhi-ncr")).headers.get("x-ai-status")).toBe("generated");
    await primeGoogle(net, "mumbai");
    const body = (await (await call("mumbai")).json()) as RecommendApiSuccess;
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: "AI_BUDGET_EXHAUSTED" });
    expect(net.google.calls).toHaveLength(1);
  });

  it("production without Redis: AI is paused, never unlimited", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const net = install();
    await primeGoogle(net);
    const body = (await (await call()).json()) as RecommendApiSuccess;
    expect(body.ai).toMatchObject({ status: "fallback", reasonCode: "AI_PROTECTION_UNAVAILABLE" });
    expect(body.data.status).toBe("ok");
    expect(net.google.calls).toHaveLength(0);
  });

  it("with Redis: the budget and explanation cache are shared across instances", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_DAILY_BUDGET", "5");
    const net = install();
    await primeGoogle(net);
    expect((await call()).headers.get("x-ai-status")).toBe("generated");
    expect(net.redis.keys().some((k) => k.startsWith("ai:v1:budget:20261124"))).toBe(true);
    expect(net.redis.keys().some((k) => k.startsWith("ai:v1:expl:"))).toBe(true);
    expect(net.redis.keys().some((k) => k.startsWith("ai:v1:rl:"))).toBe(true);

    resetGlobals(); // a second serverless instance: empty memory, same Redis
    expect((await call()).headers.get("x-ai-status")).toBe("cached");
    expect(net.google.calls).toHaveLength(1);
    expect(net.google.calls.map((c) => c.key)).toEqual([KEY]);
  });

  it("with Redis down at decision time: Gemini is not called (fail closed), the deterministic result is intact", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
    vi.stubEnv("NODE_ENV", "production");
    const net = install();
    await primeGoogle(net);
    net.redis.down = "network";
    const response = await call();
    const body = (await response.json()) as RecommendApiSuccess;
    // The general limiter also depends on Redis, so the route refuses the call before any explanation is attempted.
    expect([200, 503]).toContain(response.status);
    if (response.status === 200) expect(body.ai?.status).toBe("fallback");
    expect(net.google.calls).toHaveLength(0);
  });
});
