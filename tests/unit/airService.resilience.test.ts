import { describe, expect, it, vi } from "vitest";

import { MemoryCache, TieredCache } from "@/lib/cache";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { createAirService, type AirFetcher } from "@/lib/data/airService";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import { createAirMetrics } from "@/lib/observability/metrics";
import type { CacheCapability, NormalizedAirData } from "@/types/air";

import { makeClock } from "../fixtures/fakeRedis";
import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";

const config = { ...DEFAULT_AIR_SERVICE_CONFIG };
const good = () => openMeteoResponseSchema.parse(makeOpenMeteoResponse());

function build(options: { capability?: () => CacheCapability; production?: boolean; fetcher?: AirFetcher } = {}) {
  const clock = makeClock(FETCHED_AT_MS);
  const cache = new MemoryCache<NormalizedAirData>();
  const fetcher = vi.fn<AirFetcher>(options.fetcher ?? (() => Promise.resolve(good())));
  const metrics = createAirMetrics(() => undefined);
  const service = createAirService({
    config,
    cache,
    now: clock.now,
    fetcher,
    logger: { warn: vi.fn() },
    metrics,
    ...(options.capability === undefined ? {} : { capability: options.capability }),
    ...(options.production === undefined ? {} : { production: options.production }),
  });
  return { service, clock, cache, fetcher, metrics };
}

describe("allowUpstream: false (request limiting unavailable)", () => {
  it("still serves a fresh cached reading, with no provider call", async () => {
    const { service, fetcher, clock } = build();
    await service.getAirData("mumbai");
    clock.advance(5 * 60_000);
    const data = await service.getAirData("mumbai", { allowUpstream: false });
    expect(data.cache.status).toBe("hit");
    expect(data.freshnessStatus).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves an expired reading as stale ('refresh paused'), keeping its original timestamps, with no provider call", async () => {
    const { service, fetcher, clock } = build();
    const original = await service.getAirData("mumbai");
    clock.advance(config.ttlSeconds * 1000 + 10 * 60_000);
    const data = await service.getAirData("mumbai", { allowUpstream: false });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(data.freshnessStatus).toBe("stale");
    expect(data.cache.status).toBe("stale-fallback");
    expect(data.fetchedAt).toBe(original.fetchedAt);
    expect(data.dataTimestamp).toBe(original.dataTimestamp);
    expect(data.ageSeconds).toBe(config.ttlSeconds + 600);
    const codes = data.warnings.map((w) => w.code);
    expect(codes).toContain("REFRESH_PAUSED");
    expect(codes).toContain("STALE_DATA");
    expect(codes).not.toContain("UPSTREAM_UNAVAILABLE"); // the provider was not even tried
  });

  it("returns the explicit unavailable state, and still never calls the provider, when nothing is cached", async () => {
    const { service, fetcher } = build();
    const data = await service.getAirData("mumbai", { allowUpstream: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(data.freshnessStatus).toBe("unavailable");
    expect(data.calculatedAqi).toBeNull();
    expect(data.fetchedAt).toBeNull();
    expect(data.warnings.find((w) => w.code === "UPSTREAM_UNAVAILABLE")?.message).toMatch(/request limiting/);
  });

  it("does not serve a reading older than the maximum stale age", async () => {
    const { service, fetcher, clock } = build();
    await service.getAirData("mumbai");
    clock.advance(config.maxStaleSeconds * 1000 + 1_000);
    const data = await service.getAirData("mumbai", { allowUpstream: false });
    expect(data.freshnessStatus).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("makes no provider call however many requests arrive", async () => {
    const { service, fetcher } = build();
    for (let i = 0; i < 100; i += 1) await service.getAirData("patna", { allowUpstream: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("may join a refresh that a permitted request already started (no extra provider call)", async () => {
    let release!: (value: ReturnType<typeof good>) => void;
    const gate = new Promise<ReturnType<typeof good>>((resolve) => (release = resolve));
    const { service, fetcher } = build({ fetcher: () => gate });
    const permitted = service.getAirData("kolkata");
    await Promise.resolve();
    const paused = service.getAirData("kolkata", { allowUpstream: false });
    release(good());
    const [a, b] = await Promise.all([permitted, paused]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(b.fetchedAt).toBe(a.fetchedAt);
  });

  it("defaults to allowing the provider call", async () => {
    const { service, fetcher } = build();
    await service.getAirData("mumbai", {});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("metrics", () => {
  it("counts hits, misses and stale fallbacks", async () => {
    let healthy = true;
    const { service, clock, metrics } = build({
      fetcher: () => (healthy ? Promise.resolve(good()) : Promise.reject(new OpenMeteoError("UPSTREAM_SERVER_ERROR"))),
    });
    await service.getAirData("mumbai"); // miss
    await service.getAirData("mumbai"); // hit
    healthy = false;
    clock.advance((config.ttlSeconds + 1) * 1000);
    await service.getAirData("mumbai"); // provider failure -> stale
    expect(metrics.snapshot()).toMatchObject({ cache_miss: 1, cache_hit: 1, provider_failure: 1, stale_fallback: 1, provider_timeout: 0 });
  });

  it("separates provider timeouts from other provider failures", async () => {
    const { service, clock, metrics } = build({ fetcher: () => Promise.reject(new OpenMeteoError("UPSTREAM_TIMEOUT")) });
    await service.getAirData("mumbai");
    clock.advance(61_000);
    await service.getAirData("mumbai");
    expect(metrics.snapshot()).toMatchObject({ provider_timeout: 2, provider_failure: 0 });
  });

  it("counts a paused refresh", async () => {
    const { service, metrics } = build();
    await service.getAirData("mumbai", { allowUpstream: false });
    expect(metrics.snapshot().refresh_paused).toBe(1);
  });
});

describe("cache capability reporting", () => {
  it("states a persistent cache as persistent, and not degraded, in production", async () => {
    const { service } = build({ capability: () => "persistent", production: true });
    expect((await service.getAirData("mumbai")).cache).toMatchObject({ capability: "persistent", degraded: false });
  });

  it("flags memory-only operation in production as degraded: it never claims durability it lacks", async () => {
    const { service } = build({ capability: () => "memory-only", production: true });
    const data = await service.getAirData("mumbai");
    expect(data.cache).toMatchObject({ capability: "memory-only", degraded: true });
  });

  it("flags a configured-but-failing Redis in production as degraded", async () => {
    const { service } = build({ capability: () => "persistent-unavailable", production: true });
    expect((await service.getAirData("mumbai")).cache).toMatchObject({ capability: "persistent-unavailable", degraded: true });
  });

  it("does not call memory-only 'degraded' outside production (local development)", async () => {
    const { service } = build({ capability: () => "memory-only", production: false });
    expect((await service.getAirData("mumbai")).cache).toMatchObject({ capability: "memory-only", degraded: false });
  });

  it("reports the capability on stale and unavailable results too", async () => {
    const { service } = build({ capability: () => "memory-only", production: true });
    const unavailable = await service.getAirData("mumbai", { allowUpstream: false });
    expect(unavailable.cache).toMatchObject({ status: "none", capability: "memory-only", degraded: true });
  });

  it("makes no capability claim when the service is not told its backend (existing behaviour)", async () => {
    const { service } = build();
    const data = await service.getAirData("mumbai");
    expect(data.cache.capability).toBeUndefined();
    expect(data.cache.degraded).toBeUndefined();
  });

  it("reflects a capability that changes at runtime", async () => {
    let capability: CacheCapability = "persistent";
    const { service, clock } = build({ capability: () => capability, production: true });
    expect((await service.getAirData("mumbai")).cache.capability).toBe("persistent");
    capability = "persistent-unavailable";
    clock.advance(1_000);
    expect((await service.getAirData("mumbai")).cache.capability).toBe("persistent-unavailable");
  });

  it("works with a real TieredCache as the source of truth", () => {
    const tiered = new TieredCache({ memory: new MemoryCache<NormalizedAirData>(), durable: null, freshWithinMs: 1 });
    expect(tiered.capability()).toBe("memory-only");
  });
});
