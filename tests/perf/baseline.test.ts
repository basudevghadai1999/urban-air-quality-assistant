import { describe, expect, it } from "vitest";

import { aiCacheKey, createAiCache } from "@/lib/ai/cache";
import { buildGroundingContext } from "@/lib/ai/context";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { validateExplanation } from "@/lib/ai/validator";
import { handleRecommendRequest } from "@/lib/api/recommendHandler";
import { createExplanationService } from "@/lib/ai/service";
import { MemoryCache } from "@/lib/cache";
import type { CacheAdapter, CacheEntry } from "@/lib/cache";
import { createAirService } from "@/lib/data/airService";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { NormalizedAirData } from "@/types/air";

import { allowGate, compliantExplanation, fakeTransport, memoryBudget, modelText, readyConfig, resultFor } from "../fixtures/ai";
import { MORNING_DIP } from "../fixtures/engine";
import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";

/**
 * SYNTHETIC benchmark: deterministic mocks, in-process, no network, no Redis. It measures this code's own cost
 * (CPU, promise lifecycle, duplicate work), NOT production latency, which is dominated by Open-Meteo, Upstash and the
 * model providers. Skipped unless PERF=1 so the normal suite stays fast:
 *
 *     PERF=1 npx vitest run tests/perf
 */

const RUN = process.env.PERF === "1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const fmt = (xs: number[]) => `p50 ${(pct(xs, 50) * 1000).toFixed(0)}us  p95 ${(pct(xs, 95) * 1000).toFixed(0)}us  p99 ${(pct(xs, 99) * 1000).toFixed(0)}us`;
const out: string[] = [];
const say = (s: string) => out.push(s);

async function timed(n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    xs.push(performance.now() - t);
  }
  return xs;
}

/** A cache whose reads and writes take `ms`, like a Redis round trip. */
function slowCache(ms: number): CacheAdapter<NormalizedAirData> & { reads: number } {
  const inner = new MemoryCache<NormalizedAirData>();
  const c = {
    reads: 0,
    // Redis applies a command in the middle of its round trip: the value is read (or written) half-way, then travels back.
    async get(key: string): Promise<CacheEntry<NormalizedAirData> | null> {
      c.reads++;
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
  };
  return c as never;
}

function airHarness(options: { cache?: CacheAdapter<NormalizedAirData>; upstreamMs?: number; clock?: { t: number } } = {}) {
  const clock = options.clock ?? { t: FETCHED_AT_MS };
  const stats = { fetches: 0 };
  const service = createAirService({
    config: DEFAULT_AIR_SERVICE_CONFIG,
    cache: options.cache ?? new MemoryCache<NormalizedAirData>(),
    now: () => clock.t,
    fetcher: async () => {
      stats.fetches++;
      if (options.upstreamMs) await sleep(options.upstreamMs);
      return openMeteoResponseSchema.parse(makeOpenMeteoResponse(MORNING_DIP));
    },
    logger: { warn: () => undefined },
  });
  return { service, stats, clock };
}

function aiHarness(opts: { providerMs?: number; cacheMs?: number } = {}) {
  const stats = { calls: 0 };
  const respondWith = new Map<string, ReturnType<typeof resultFor>>();
  const transport = fakeTransport(async (r) => {
    stats.calls++;
    if (opts.providerMs) await sleep(opts.providerMs);
    const key = [...respondWith.keys()].find((k) => r.userPrompt.includes(k));
    return modelText(compliantExplanation((key === undefined ? resultFor() : (respondWith.get(key) as ReturnType<typeof resultFor>)).result));
  });
  const base = createAiCache({ ttlSeconds: 1_800 });
  const cache = opts.cacheMs
    ? {
        get: async (k: string, a: Parameters<typeof base.get>[1]) => {
          await sleep((opts.cacheMs as number) / 2);
          const v = await base.get(k, a);
          await sleep((opts.cacheMs as number) / 2);
          return v;
        },
        set: async (k: string, e: Parameters<typeof base.set>[1]) => {
          await sleep((opts.cacheMs as number) / 2);
          await base.set(k, e);
          await sleep((opts.cacheMs as number) / 2);
        },
      }
    : base;
  const service = createExplanationService({ getConfig: () => readyConfig(), getTransport: () => transport, cache, budget: memoryBudget(1_000_000), clientGate: allowGate });
  const req = () => new Request("http://localhost/x", { method: "POST" });
  return { service, stats, transport, req, respondWith };
}

describe.skipIf(!RUN)("performance baseline (synthetic)", () => {
  it("runs", async () => {
    // 1. Air data: hit and miss
    {
      const h = airHarness();
      await h.service.getAirData("mumbai");
      say(`air hit            ${fmt(await timed(3_000, () => h.service.getAirData("mumbai")))}`);
      const m = airHarness();
      say(`air miss (refresh) ${fmt(await timed(1_000, async () => { m.clock.t += 3_600_000; await m.service.getAirData("mumbai"); }))}`);
    }
    // 2. AI: cache hit, miss
    {
      const i = resultFor();
      const h = aiHarness();
      await h.service.explain({ request: h.req(), ...i });
      say(`ai cache hit       ${fmt(await timed(2_000, () => h.service.explain({ request: h.req(), ...i })))}`);
      say(`ai miss (generate) ${fmt(await timed(300, () => aiHarness().service.explain({ request: h.req(), ...i })))}`);
    }
    // 3/4. Concurrency: same context and different contexts
    {
      const i = resultFor();
      const same = aiHarness({ providerMs: 20 });
      const t0 = performance.now();
      await Promise.all(Array.from({ length: 200 }, () => same.service.explain({ request: same.req(), ...i })));
      say(`ai 200 identical concurrent      provider calls ${same.stats.calls}  wall ${(performance.now() - t0).toFixed(0)}ms`);

      const diff = aiHarness({ providerMs: 20 });
      const variants = Array.from({ length: 200 }, (_, n) => resultFor("senior_respiratory", undefined, { commuteDistanceKm: 0.1 + n * 0.3 }));
      const t1 = performance.now();
      await Promise.all(variants.map((v) => diff.service.explain({ request: diff.req(), ...v })));
      say(`ai 200 distinct concurrent       provider calls ${diff.stats.calls}  wall ${(performance.now() - t1).toFixed(0)}ms (provider 20ms each)`);

      // The race: followers whose cache read returned before the leader finished.
      const slow = aiHarness({ providerMs: 5, cacheMs: 15 });
      await Promise.all(Array.from({ length: 50 }, async (_, n) => { await sleep(n * 0.6); return slow.service.explain({ request: slow.req(), ...i }); }));
      say(`ai 50 staggered identical (cache 15ms, provider 5ms)  provider calls ${slow.stats.calls}  (1 is ideal)`);

      const airSlow = slowCache(15);
      const a = airHarness({ cache: airSlow, upstreamMs: 5 });
      await Promise.all(Array.from({ length: 50 }, async (_, n) => { await sleep(n * 0.6); return a.service.getAirData("mumbai"); }));
      say(`air 50 staggered identical (cache 15ms, upstream 5ms) upstream fetches ${a.stats.fetches}  (1 is ideal)`);
    }
    // 5. The request path the dashboard uses most: handler end to end on a warm cache, and its parts
    {
      const h = airHarness();
      await h.service.getAirData("mumbai");
      const body = JSON.stringify({ cityId: "mumbai", profileId: "senior_respiratory" });
      const call = () => handleRecommendRequest(new Request("http://localhost/api/recommend", { method: "POST", headers: { "content-type": "application/json" }, body }), () => h.service, () => FETCHED_AT_MS, {});
      say(`/api/recommend warm   ${fmt(await timed(500, async () => (await call()).text()))}`);
      const air = resultFor().air;
      say(`  engine only         ${fmt(await timed(500, async () => resultFor("senior_respiratory", air)))}`);
      const r = resultFor("senior_respiratory", air);
      say(`  grounding context   ${fmt(await timed(500, async () => buildGroundingContext(r.result, air)))}`);
      const g = buildGroundingContext(r.result, air);
      say(`  cache key (sha256)  ${fmt(await timed(500, async () => aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "m", contextJson: g.json })))}`);
      const opts = { allowedIds: g.allowedIds, contextJson: g.json, secrets: [] };
      const ex = compliantExplanation(r.result);
      say(`  validate explanation${fmt(await timed(500, async () => validateExplanation(ex, opts)))}`);
      say(`  context bytes ${new TextEncoder().encode(g.json).length}`);
    }
    // 6. Chain with latency and failures
    {
      const i = resultFor();
      const g = fakeTransport(async () => { await sleep(50); throw Object.assign(new Error("x"), { status: 503 }); });
      const q = fakeTransport(async () => { await sleep(20); return modelText(compliantExplanation(i.result)); });
      const s = createExplanationService({ getConfig: () => readyConfig({}, "m", ["gemini", "groq"]), getTransport: (p) => (p.id === "groq" ? q : g), cache: createAiCache({ ttlSeconds: 60 }), budget: memoryBudget(1_000_000), clientGate: allowGate });
      const t = performance.now();
      await s.explain({ request: new Request("http://localhost/x", { method: "POST" }), ...i });
      say(`chain gemini 50ms fail + groq 20ms ok: wall ${(performance.now() - t).toFixed(0)}ms (ideal ~70ms)`);
    }
    // 7. Memory and event loop
    {
      const before = process.memoryUsage().heapUsed;
      const cache = createAiCache({ ttlSeconds: 1_800 });
      const i = resultFor();
      for (let n = 0; n < 1_000; n++) await cache.set(`ai:v1:expl:${n.toString(16).padStart(64, "0")}`, compliantExplanation(i.result));
      global.gc?.();
      say(`ai cache 1000 sets (200-entry cap): heap +${((process.memoryUsage().heapUsed - before) / 1e6).toFixed(1)} MB`);

      let maxLag = 0;
      let last = performance.now();
      const timer = setInterval(() => { const n = performance.now(); maxLag = Math.max(maxLag, n - last - 5); last = n; }, 5);
      const h = airHarness();
      const ai = aiHarness();
      await Promise.all(Array.from({ length: 300 }, async () => { await h.service.getAirData("mumbai"); await ai.service.explain({ request: ai.req(), ...i }); }));
      clearInterval(timer);
      say(`event-loop lag during 300 mixed requests: max ${maxLag.toFixed(1)}ms`);
    }
    process.stderr.write(`\nPERF-REPORT\n${out.join("\n")}\n`);
    expect(out.length).toBeGreaterThan(0);
  }, 120_000);
});
