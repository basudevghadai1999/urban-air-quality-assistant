import { describe, expect, it, vi } from "vitest";

import { createAiCache } from "@/lib/ai/cache";
import { buildGroundingContext } from "@/lib/ai/context";
import { createExplanationService } from "@/lib/ai/service";
import { groundedQuantities, validateAnswerText, validateExplanation } from "@/lib/ai/validator";
import { MemoryCache, type CacheAdapter, type CacheEntry } from "@/lib/cache";
import { createAirService } from "@/lib/data/airService";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { NormalizedAirData } from "@/types/air";

import { allowGate, compliantExplanation, fakeTransport, memoryBudget, modelText, readyConfig, resultFor } from "../../fixtures/ai";
import { MORNING_DIP, NOW } from "../../fixtures/engine";
import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../../fixtures/openMeteo";
import { MemoryProviderBudget } from "@/lib/ai/providerBudget";

/** Concurrency and resource behaviour with mocks only: no network, no Redis. Timing here is ordering, not speed. */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const post = () => new Request("http://localhost/x", { method: "POST" });

describe("validation: the numeric context is built once per context, and only a few are kept", () => {
  const ctxOf = (km: number) => {
    const r = resultFor("senior_respiratory", undefined, { commuteDistanceKm: km });
    return { r, g: buildGroundingContext(r.result, r.air) };
  };
  const contextParses = (spy: { mock: { calls: unknown[][] } }, json: string) => spy.mock.calls.filter((c) => c[0] === json).length;

  it("validating the same context again does not parse or walk it again, and gives the same verdicts", () => {
    const { r, g } = ctxOf(4.5);
    const opts = { allowedIds: g.allowedIds, contextJson: g.json };
    const spy = vi.spyOn(JSON, "parse");
    try {
      const first = [validateExplanation(compliantExplanation(r.result), opts).ok, validateAnswerText("The AQI is 487.", opts), validateAnswerText("Relatively lower air later.", opts)];
      const second = [validateExplanation(compliantExplanation(r.result), opts).ok, validateAnswerText("The AQI is 487.", opts), validateAnswerText("Relatively lower air later.", opts)];
      expect(second).toEqual(first);
      expect(first).toEqual([true, "unsupported-number", null]);
      expect(contextParses(spy, g.json)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("interleaved contexts never borrow each other's grounded figures", () => {
    const a = ctxOf(4.5);
    const b = ctxOf(7.5);
    const aq = [...(groundedQuantities(a.g.json).get("km") ?? [])];
    const bq = [...(groundedQuantities(b.g.json).get("km") ?? [])];
    expect(aq).toContain(4.5);
    expect(bq).toContain(7.5);
    // 7.5 km is grounded in B only: A must reject it however many times B was validated first.
    for (let n = 0; n < 3; n++) {
      expect(validateAnswerText("The trip is 7.5 km each way.", { allowedIds: b.g.allowedIds, contextJson: b.g.json })).toBeNull();
      expect(validateAnswerText("The trip is 7.5 km each way.", { allowedIds: a.g.allowedIds, contextJson: a.g.json })).not.toBeNull();
    }
  });

  it("is bounded: after many other contexts the oldest is built again", () => {
    const first = ctxOf(1.1);
    const opts = { allowedIds: first.g.allowedIds, contextJson: first.g.json };
    validateAnswerText("Fine.", opts);
    let latest = first;
    for (let n = 0; n < 20; n++) {
      latest = ctxOf(10 + n);
      validateAnswerText("Fine.", { allowedIds: latest.g.allowedIds, contextJson: latest.g.json });
    }
    const spy = vi.spyOn(JSON, "parse");
    try {
      validateAnswerText("Fine.", { allowedIds: latest.g.allowedIds, contextJson: latest.g.json });
      expect(contextParses(spy, latest.g.json)).toBe(0); // the most recent is still held
      validateAnswerText("Fine.", opts);
      expect(contextParses(spy, first.g.json)).toBe(1); // the oldest was evicted, so it is rebuilt: memory stays bounded
    } finally {
      spy.mockRestore();
    }
  });
});

describe("air data under concurrent load and a slow cache", () => {
  /** A cache that behaves like a Redis round trip: the value is read half-way, then travels back. */
  function slowCache(ms: number): CacheAdapter<NormalizedAirData> {
    const inner = new MemoryCache<NormalizedAirData>();
    return {
      async get(key: string): Promise<CacheEntry<NormalizedAirData> | null> {
        await sleep(ms / 2);
        const v = await inner.get(key);
        await sleep(ms / 2);
        return v;
      },
      async set(key: string, entry: CacheEntry<NormalizedAirData>) {
        await sleep(ms / 2);
        await inner.set(key, entry);
        await sleep(ms / 2);
      },
      delete: (key: string) => inner.delete(key),
    } as CacheAdapter<NormalizedAirData>;
  }

  it("callers arriving throughout a refresh cause one provider call, not one per arrival", async () => {
    let fetches = 0;
    const service = createAirService({
      config: DEFAULT_AIR_SERVICE_CONFIG,
      cache: slowCache(20),
      now: () => FETCHED_AT_MS,
      fetcher: async () => {
        fetches++;
        await sleep(5);
        return openMeteoResponseSchema.parse(makeOpenMeteoResponse(MORNING_DIP));
      },
      logger: { warn: vi.fn() },
    });
    const all = await Promise.all(Array.from({ length: 40 }, async (_, n) => (await sleep(n), service.getAirData("mumbai"))));
    expect(fetches).toBe(1);
    expect(new Set(all.map((a) => a.fetchedAt)).size).toBe(1);
  });

  it("a failing leader fails its followers over to the same fallback with no extra calls, and the next window recovers", async () => {
    let fetches = 0;
    let healthy = false;
    let now = FETCHED_AT_MS;
    const service = createAirService({
      config: DEFAULT_AIR_SERVICE_CONFIG,
      cache: new MemoryCache<NormalizedAirData>(),
      now: () => now,
      fetcher: async () => {
        fetches++;
        await sleep(5);
        if (!healthy) throw new Error("upstream down");
        return openMeteoResponseSchema.parse(makeOpenMeteoResponse(MORNING_DIP));
      },
      logger: { warn: vi.fn() },
    });
    const during = await Promise.all(Array.from({ length: 30 }, () => service.getAirData("mumbai")));
    expect(fetches).toBe(1);
    expect(new Set(during.map((d) => d.freshnessStatus)).size).toBe(1);
    expect(during[0]?.freshnessStatus).toBe("unavailable");

    // Inside the back-off window nobody calls the provider.
    now += 10_000;
    await Promise.all(Array.from({ length: 30 }, () => service.getAirData("mumbai")));
    expect(fetches).toBe(1);

    // After it, the provider has recovered: one call, and everyone then gets fresh data.
    now += 120_000;
    healthy = true;
    const after = await Promise.all(Array.from({ length: 30 }, () => service.getAirData("mumbai")));
    expect(fetches).toBe(2);
    expect(after.every((a) => a.freshnessStatus === "fresh")).toBe(true);
  });
});

describe("AI explanations under concurrent load", () => {
  function service(respond: (prompt: string) => Promise<ReturnType<typeof modelText>>, budget = memoryBudget(1_000, () => NOW)) {
    const transport = fakeTransport((r) => respond(r.userPrompt));
    const svc = createExplanationService({
      getConfig: () => readyConfig(),
      getTransport: () => transport,
      cache: createAiCache({ ttlSeconds: 1_800, now: () => NOW }),
      budget,
      clientGate: allowGate,
    });
    return { svc, transport };
  }

  it("many distinct contexts are all generated, and each caller gets exactly its own answer", async () => {
    const inputs = Array.from({ length: 25 }, (_, n) => resultFor("senior_respiratory", undefined, { commuteDistanceKm: 0.5 + n }));
    const distinct = new Set(inputs.map((i) => buildGroundingContext(i.result, i.air).json));
    const { svc, transport } = service(async (prompt) => {
      await sleep(2);
      const mine = inputs.find((i) => prompt.includes(buildGroundingContext(i.result, i.air).json));
      return modelText(compliantExplanation((mine ?? inputs[0]!).result));
    });
    expect(distinct.size).toBe(25); // really 25 different contexts
    const out = await Promise.all(inputs.map((i) => svc.explain({ request: post(), ...i })));
    expect(transport.requests).toHaveLength(25);
    out.forEach((env, n) => expect(env.explanation).toEqual(compliantExplanation(inputs[n]!.result)));
  });

  it("a failing leader gives its followers the same fallback; the next request is a fresh attempt that succeeds and is then cached", async () => {
    const i = resultFor();
    let healthy = false;
    const budget = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
    const { svc, transport } = service(async () => {
      await sleep(5);
      if (!healthy) throw Object.assign(new Error("RAW"), { status: 503 });
      return modelText(compliantExplanation(i.result));
    }, budget);

    const failed = await Promise.all(Array.from({ length: 30 }, () => svc.explain({ request: post(), ...i })));
    expect(transport.requests).toHaveLength(1); // one shared attempt, one budget unit
    expect(failed.every((f) => f.status === "fallback" && f.reasonCode === "AI_UPSTREAM_ERROR")).toBe(true);

    healthy = true; // the failed flight was cleaned up: nothing is stuck waiting on it
    const recovered = await svc.explain({ request: post(), ...i });
    expect(recovered).toMatchObject({ status: "generated" });
    expect(transport.requests).toHaveLength(2);
    expect(await svc.explain({ request: post(), ...i })).toMatchObject({ status: "cached" });
    expect(transport.requests).toHaveLength(2);
    expect((await budget.reserve("gemini")).usedGlobal).toBe(3); // 1 failed + 1 recovered + this probe: followers were never charged
  });

  it("the explanation cache holds at most its cap and never an oversized entry", async () => {
    const cache = createAiCache({ ttlSeconds: 1_800, now: () => NOW });
    const e = compliantExplanation(resultFor().result);
    const key = (n: number) => `ai:v1:expl:${n.toString(16).padStart(64, "0")}`;
    for (let n = 0; n < 500; n++) await cache.set(key(n), e);
    const accept = (c: unknown) => c as typeof e;
    expect(await cache.get(key(0), accept)).toBeNull(); // evicted
    expect(await cache.get(key(499), accept)).not.toBeNull();
    let held = 0;
    for (let n = 0; n < 500; n++) if ((await cache.get(key(n), accept)) !== null) held++;
    expect(held).toBe(200);

    const big = { ...e, overview: "x".repeat(30_000) };
    const bigKey = key(9_999);
    const sets: unknown[][] = [];
    const redis = createAiCache({ ttlSeconds: 60, now: () => NOW, client: { command: (a: readonly (string | number)[]) => (sets.push([...a]), Promise.resolve("OK")) } });
    await redis.set(bigKey, big);
    expect(sets).toHaveLength(0); // too large for Redis: not written
  });
});
