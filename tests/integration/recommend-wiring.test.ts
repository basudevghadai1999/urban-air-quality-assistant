import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/recommend/route";
import { GET } from "@/app/api/air/route";
import type { RecommendApiError, RecommendApiSuccess } from "@/types/api";

import { FETCHED_AT_MS, jsonResponse, makeOpenMeteoResponse } from "../fixtures/openMeteo";
import { EVENING_DIP } from "../fixtures/engine";

/**
 * The REAL default wiring for POST /api/recommend (env parsing, service, cache, limiter, gate, route),
 * with the network replaced by an in-process stand-in for Open-Meteo. Nothing touches a live service,
 * and any call to a host other than Open-Meteo fails the test (so Gemini is provably never contacted).
 */

const SYMBOLS = ["air-service", "air-rate-limit-gate", "air-infrastructure"].map((n) => Symbol.for(`urban-air-intelligence.${n}`));
const resetGlobals = () => {
  for (const key of SYMBOLS) delete (globalThis as unknown as Record<symbol, unknown>)[key];
};

let providerCalls = 0;
let hosts: string[] = [];

beforeEach(() => {
  resetGlobals();
  providerCalls = 0;
  hosts = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FETCHED_AT_MS);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      if (url.host === "air-quality-api.open-meteo.com") {
        providerCalls += 1;
        return Promise.resolve(jsonResponse(makeOpenMeteoResponse(EVENING_DIP)));
      }
      return Promise.reject(new Error(`unexpected network call to ${url.host}`));
    }),
  );
});

afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/recommend", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

describe("POST /api/recommend with the real default wiring", () => {
  it("serves recommendations from provider data, then from the shared air cache", async () => {
    const first = await post({ cityId: "delhi-ncr", profileId: "senior_respiratory" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as RecommendApiSuccess;
    expect(body.data.status).toBe("ok");
    expect(body.data.routine.items.some((i) => i.suggestedTime !== null)).toBe(true);

    await post({ cityId: "delhi-ncr", profileId: "student_athlete" });
    await GET(new Request("http://localhost/api/air?cityId=delhi-ncr"));
    expect(providerCalls).toBe(1);
    expect(new Set(hosts)).toEqual(new Set(["air-quality-api.open-meteo.com"]));
  });

  it("shares the rate limit with /api/air and answers 429 once the client exceeds it", async () => {
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "2");
    const headers = { "x-forwarded-for": "203.0.113.9" };
    expect((await post({ cityId: "mumbai", profileId: "family_toddlers" }, headers)).status).toBe(200);
    expect((await GET(new Request("http://localhost/api/air?cityId=mumbai", { headers }))).status).toBe(200);
    const limited = await post({ cityId: "mumbai", profileId: "family_toddlers" }, headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await limited.json()) as RecommendApiError).error.code).toBe("RATE_LIMITED");
  });

  it("does not rate-limit invalid requests, which cost nothing", async () => {
    vi.stubEnv("AIR_RATE_LIMIT_MAX", "1");
    for (let i = 0; i < 4; i += 1) expect((await post({ cityId: "nowhere", profileId: "family_toddlers" })).status).toBe(400);
    expect((await post({ cityId: "mumbai", profileId: "family_toddlers" })).status).toBe(200);
  });

  it("a provider outage with nothing cached is a 503, not an invented recommendation", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("down", { status: 503 }))));
    const response = await post({ cityId: "lucknow", profileId: "two_wheeler_commuter" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as RecommendApiError;
    expect(body.error.code).toBe("AIR_DATA_UNAVAILABLE");
    expect(body.data?.status).toBe("air-data-unavailable");
  });
});
