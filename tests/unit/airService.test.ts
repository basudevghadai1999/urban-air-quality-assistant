import { describe, expect, it, vi } from "vitest";

import { MemoryCache, type CacheAdapter, type CacheEntry } from "@/lib/cache";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { createAirService, remainingFreshSeconds, type AirFetcher, type AirLogger } from "@/lib/data/airService";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { NormalizedAirData } from "@/types/air";

import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";

const MINUTE = 60_000;
const config = { ...DEFAULT_AIR_SERVICE_CONFIG }; // ttl 15 min, max stale 24 h, backoff 60 s

const goodResponse = () => openMeteoResponseSchema.parse(makeOpenMeteoResponse());

/** A controllable clock. */
const makeClock = (start = FETCHED_AT_MS) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms), set: (ms: number) => void (now = ms) };
};

const silentLogger = () => ({ warn: vi.fn<AirLogger["warn"]>() });

function build(overrides: { fetcher?: AirFetcher; cache?: CacheAdapter<NormalizedAirData>; clock?: ReturnType<typeof makeClock> } = {}) {
  const clock = overrides.clock ?? makeClock();
  const cache = overrides.cache ?? new MemoryCache<NormalizedAirData>();
  const fetcher = vi.fn<AirFetcher>(overrides.fetcher ?? (() => Promise.resolve(goodResponse())));
  const logger = silentLogger();
  const service = createAirService({ config, cache, now: clock.now, fetcher, logger });
  return { service, clock, cache, fetcher, logger };
}

const down = (code: ConstructorParameters<typeof OpenMeteoError>[0] = "UPSTREAM_NETWORK"): AirFetcher =>
  () => Promise.reject(new OpenMeteoError(code, { detail: "simulated" }));

describe("cache miss", () => {
  it("fetches, caches and returns fresh data", async () => {
    const { service, fetcher, cache } = build();
    const data = await service.getAirData("mumbai");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("mumbai", { timeoutMs: config.upstreamTimeoutMs });
    expect(data.freshnessStatus).toBe("fresh");
    expect(data.cache.status).toBe("miss");
    expect(data.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(data.cityId).toBe("mumbai");
    expect((await cache.get("mumbai"))?.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("stamps fetchedAt with the moment the provider answered", async () => {
    const clock = makeClock();
    const slow: AirFetcher = () => {
      clock.advance(3_000); // the provider takes 3 s to answer
      return Promise.resolve(goodResponse());
    };
    const { service } = build({ fetcher: slow, clock });
    expect((await service.getAirData("kolkata")).fetchedAt).toBe(new Date(FETCHED_AT_MS + 3_000).toISOString());
  });
});

describe("cache hit", () => {
  it("serves from cache without calling the provider while within the TTL", async () => {
    const { service, fetcher, clock } = build();
    await service.getAirData("patna");
    clock.advance(10 * MINUTE);
    const hit = await service.getAirData("patna");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hit.cache.status).toBe("hit");
    expect(hit.freshnessStatus).toBe("fresh");
    expect(hit.ageSeconds).toBe(600);
  });

  it("keeps the original fetchedAt on a hit", async () => {
    const { service, clock } = build();
    const first = await service.getAirData("patna");
    clock.advance(14 * MINUTE);
    const second = await service.getAirData("patna");
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.calculatedAqi).toEqual(first.calculatedAqi);
  });

  it("treats exactly the TTL as still fresh", async () => {
    const { service, fetcher, clock } = build();
    await service.getAirData("patna");
    clock.advance(config.ttlSeconds * 1000);
    expect((await service.getAirData("patna")).cache.status).toBe("hit");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("expiration", () => {
  it("refreshes from the provider once the TTL has passed", async () => {
    const { service, fetcher, clock } = build();
    const first = await service.getAirData("lucknow");
    clock.advance(config.ttlSeconds * 1000 + 1_000);
    const refreshed = await service.getAirData("lucknow");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.cache.status).toBe("miss");
    expect(refreshed.fetchedAt).not.toBe(first.fetchedAt);
    expect(refreshed.fetchedAt).toBe(new Date(FETCHED_AT_MS + config.ttlSeconds * 1000 + 1_000).toISOString());
  });
});

describe("independent caching per city", () => {
  it("caches each city separately", async () => {
    const { service, fetcher } = build();
    await service.getAirData("mumbai");
    await service.getAirData("kolkata");
    await service.getAirData("mumbai");
    await service.getAirData("kolkata");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(["mumbai", "kolkata"]);
  });

  it("one city's outage does not affect another city's data", async () => {
    const fetcher: AirFetcher = (id) =>
      id === "patna" ? Promise.reject(new OpenMeteoError("UPSTREAM_TIMEOUT")) : Promise.resolve(goodResponse());
    const { service } = build({ fetcher });
    expect((await service.getAirData("mumbai")).freshnessStatus).toBe("fresh");
    expect((await service.getAirData("patna")).freshnessStatus).toBe("unavailable");
  });
});

describe("stale fallback (last-known-good)", () => {
  async function staleScenario(failure: OpenMeteoError = new OpenMeteoError("UPSTREAM_SERVER_ERROR", { status: 503 })) {
    let healthy = true;
    const fetcher: AirFetcher = () => (healthy ? Promise.resolve(goodResponse()) : Promise.reject(failure));
    const ctx = build({ fetcher });
    const original = await ctx.service.getAirData("bengaluru");
    healthy = false;
    ctx.clock.advance(config.ttlSeconds * 1000 + 5 * MINUTE);
    const stale = await ctx.service.getAirData("bengaluru");
    return { ...ctx, original, stale };
  }

  it("serves the cached reading, marked stale, when the provider fails", async () => {
    const { stale } = await staleScenario();
    expect(stale.freshnessStatus).toBe("stale");
    expect(stale.cache.status).toBe("stale-fallback");
    expect(stale.calculatedAqi?.status).toBe("valid");
    expect(stale.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["STALE_DATA", "UPSTREAM_UNAVAILABLE"]));
  });

  it("preserves the original fetchedAt and never makes the data look fresh", async () => {
    const { original, stale, clock } = await staleScenario();
    expect(stale.fetchedAt).toBe(original.fetchedAt);
    expect(stale.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(stale.dataTimestamp).toBe(original.dataTimestamp);
    expect(stale.calculatedAqi?.calculatedAt).toBe(original.calculatedAqi?.calculatedAt);
    expect(Date.parse(stale.fetchedAt ?? "")).toBeLessThan(clock.now());
  });

  it("calculates the age from the original fetch time", async () => {
    const { stale } = await staleScenario();
    expect(stale.ageSeconds).toBe(config.ttlSeconds + 300);
    expect(stale.warnings.find((w) => w.code === "STALE_DATA")?.message).toContain("20 minutes");
  });

  it("keeps serving the same stale snapshot, with a growing age, across repeated failures", async () => {
    const { service, clock, stale } = await staleScenario();
    clock.advance(10 * MINUTE);
    const again = await service.getAirData("bengaluru");
    expect(again.fetchedAt).toBe(stale.fetchedAt);
    expect(again.ageSeconds).toBe((stale.ageSeconds ?? 0) + 600);
    expect(again.freshnessStatus).toBe("stale");
  });

  it("works for every failure type: rate limit, timeout, network, bad payload", async () => {
    for (const code of ["UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK", "UPSTREAM_INVALID_RESPONSE", "UPSTREAM_REJECTED"] as const) {
      const { stale } = await staleScenario(new OpenMeteoError(code));
      expect(stale.freshnessStatus).toBe("stale");
    }
  });

  it("recovers to fresh data when the provider comes back", async () => {
    let healthy = true;
    const { service, clock } = build({ fetcher: () => (healthy ? Promise.resolve(goodResponse()) : Promise.reject(new OpenMeteoError("UPSTREAM_NETWORK"))) });
    await service.getAirData("kolkata");
    healthy = false;
    clock.advance((config.ttlSeconds + 60) * 1000);
    expect((await service.getAirData("kolkata")).freshnessStatus).toBe("stale");
    healthy = true;
    clock.advance(config.failureBackoffSeconds * 1000 + 1_000);
    const recovered = await service.getAirData("kolkata");
    expect(recovered.freshnessStatus).toBe("fresh");
    expect(recovered.cache.status).toBe("miss");
    expect(recovered.fetchedAt).toBe(new Date(clock.now()).toISOString());
  });

  it("refuses to serve a snapshot older than the maximum stale age", async () => {
    let healthy = true;
    const { service, clock } = build({ fetcher: () => (healthy ? Promise.resolve(goodResponse()) : Promise.reject(new OpenMeteoError("UPSTREAM_NETWORK"))) });
    await service.getAirData("kolkata");
    healthy = false;
    clock.advance(config.maxStaleSeconds * 1000 + 1_000);
    const result = await service.getAirData("kolkata");
    expect(result.freshnessStatus).toBe("unavailable");
    expect(result.calculatedAqi).toBeNull();
  });
});

describe("no cached response", () => {
  it("returns the explicit unavailable state, never invented numbers, and does not throw", async () => {
    const { service } = build({ fetcher: down("UPSTREAM_TIMEOUT") });
    const data = await service.getAirData("mumbai");
    expect(data.freshnessStatus).toBe("unavailable");
    expect(data.cache.status).toBe("none");
    expect(data.fetchedAt).toBeNull();
    expect(data.calculatedAqi).toBeNull();
    expect(data.historicalHourlyData.hours).toEqual([]);
    expect(data.missingPollutants).toHaveLength(8);
    expect(data.warnings.map((w) => w.code)).toContain("NO_CACHED_DATA");
  });

  it("does not cache a failure", async () => {
    const { service, cache } = build({ fetcher: down() });
    await service.getAirData("mumbai");
    expect(await cache.get("mumbai")).toBeNull();
  });

  it("treats a response that fails mapping (wrong timezone) as an upstream failure, not a crash", async () => {
    const bad = openMeteoResponseSchema.parse(makeOpenMeteoResponse({ timezone: "Europe/Berlin", utcOffsetSeconds: 3_600 }));
    const { service } = build({ fetcher: () => Promise.resolve(bad) });
    expect((await service.getAirData("mumbai")).freshnessStatus).toBe("unavailable");
  });

  it("survives an unexpected non-provider exception", async () => {
    const { service, logger } = build({ fetcher: () => Promise.reject(new Error("bug: x is undefined")) });
    const data = await service.getAirData("mumbai");
    expect(data.freshnessStatus).toBe("unavailable");
    expect(logger.warn).toHaveBeenCalledWith("air.refresh_failed", expect.objectContaining({ code: "UNEXPECTED" }));
  });
});

describe("reliability: single-flight and back-off", () => {
  it("shares one provider call between concurrent requests for the same city", async () => {
    let resolve!: (value: ReturnType<typeof goodResponse>) => void;
    const gate = new Promise<ReturnType<typeof goodResponse>>((r) => (resolve = r));
    const { service, fetcher } = build({ fetcher: () => gate });
    const all = Promise.all([service.getAirData("patna"), service.getAirData("patna"), service.getAirData("patna")]);
    resolve(goodResponse());
    const results = await all;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.fetchedAt === results[0]?.fetchedAt)).toBe(true);
  });

  it("does not share a call across different cities", async () => {
    const { service, fetcher } = build();
    await Promise.all([service.getAirData("patna"), service.getAirData("mumbai")]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops calling a failing provider for the back-off period, then tries again", async () => {
    const { service, fetcher, clock } = build({ fetcher: down("UPSTREAM_RATE_LIMITED") });
    await service.getAirData("mumbai");
    await service.getAirData("mumbai");
    clock.advance(30_000);
    await service.getAirData("mumbai");
    expect(fetcher).toHaveBeenCalledTimes(1); // protected from hammering

    clock.advance(config.failureBackoffSeconds * 1000);
    await service.getAirData("mumbai");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight marker so a later request can refresh", async () => {
    const { service, fetcher, clock } = build();
    await service.getAirData("patna");
    clock.advance((config.ttlSeconds + 1) * 1000);
    await service.getAirData("patna");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("cache faults", () => {
  const brokenCache: CacheAdapter<NormalizedAirData> = {
    get: () => Promise.reject(new Error("redis down")),
    set: () => Promise.reject(new Error("redis down")),
    delete: () => Promise.resolve(),
  };

  it("degrades to uncached operation when the cache cannot be read or written", async () => {
    const { service, logger } = build({ cache: brokenCache });
    const data = await service.getAirData("mumbai");
    expect(data.freshnessStatus).toBe("fresh");
    expect(logger.warn).toHaveBeenCalledWith("air.cache_read_failed", { cityId: "mumbai" });
    expect(logger.warn).toHaveBeenCalledWith("air.cache_write_failed", { cityId: "mumbai" });
  });

  it("uses an injected adapter, so a persistent store can replace the default", async () => {
    const store = new Map<string, CacheEntry<NormalizedAirData>>();
    const adapter: CacheAdapter<NormalizedAirData> = {
      get: (k) => Promise.resolve(store.get(k) ?? null),
      set: (k, e) => (store.set(k, e), Promise.resolve()),
      delete: (k) => (store.delete(k), Promise.resolve()),
    };
    const { service } = build({ cache: adapter });
    await service.getAirData("kolkata");
    expect(store.get("kolkata")?.storedAtMs).toBe(FETCHED_AT_MS);
  });
});

describe("safe logging", () => {
  it("logs the failure class, never provider text, URLs or response bodies", async () => {
    const leaky = new OpenMeteoError("UPSTREAM_REJECTED", { status: 400, detail: "HTTP 400" });
    const { service, logger } = build({ fetcher: () => Promise.reject(leaky) });
    await service.getAirData("mumbai");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [event, fields] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("air.refresh_failed");
    expect(fields).toMatchObject({ cityId: "mumbai", code: "UPSTREAM_REJECTED", status: 400, servedStale: 0 });
    expect(JSON.stringify(fields)).not.toMatch(/https?:|open-meteo|latitude|reason/i);
  });
});

describe("input safety", () => {
  it("rejects an unknown city id before touching the cache or provider", async () => {
    const { service, fetcher } = build();
    await expect(service.getAirData("atlantis" as never)).rejects.toBeInstanceOf(RangeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("remainingFreshSeconds", () => {
  it("is the time left in the freshness window, and zero for non-fresh data", async () => {
    const { service, clock } = build();
    const fresh = await service.getAirData("mumbai");
    expect(remainingFreshSeconds(fresh, clock.now())).toBe(900);
    expect(remainingFreshSeconds(fresh, clock.now() + 300_000)).toBe(600);
    expect(remainingFreshSeconds(fresh, clock.now() + 5_000_000)).toBe(0);
    expect(remainingFreshSeconds({ ...fresh, freshnessStatus: "stale" }, clock.now())).toBe(0);
    expect(remainingFreshSeconds({ ...fresh, fetchedAt: null, freshnessStatus: "unavailable" }, clock.now())).toBe(0);
  });
});
