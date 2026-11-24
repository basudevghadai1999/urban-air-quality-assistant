import { describe, expect, it, vi } from "vitest";

import { handleAirRequest } from "@/lib/api/airHandler";
import { MemoryCache, TieredCache } from "@/lib/cache";
import { UpstashCache } from "@/lib/cache/upstash";
import { createAirService, type AirFetcher } from "@/lib/data/airService";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import { createAirMetrics } from "@/lib/observability/metrics";
import { createRateLimitGate } from "@/lib/ratelimit/gate";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";
import type { AirApiError, AirApiSuccess, NormalizedAirData } from "@/types/air";

import { FakeRedis, makeClock } from "../fixtures/fakeRedis";
import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";

const config = { ...DEFAULT_AIR_SERVICE_CONFIG }; // fresh 15 min, max stale 24 h
const POLICY = { limit: 3, windowSeconds: 60 };
const SNAPSHOT_KEY = (city: string) => `air:v1:snapshot:${city}`;
const good = () => openMeteoResponseSchema.parse(makeOpenMeteoResponse());

/**
 * A small world: one shared Redis, one provider, one clock, and any number of
 * server "instances" (each with its own memory), as on serverless.
 */
function world() {
  const clock = makeClock(FETCHED_AT_MS);
  const redis = new FakeRedis(clock.now);
  const provider = { healthy: true, calls: 0 };
  const logs: string[] = [];
  const logger = { warn: vi.fn((event: string, fields: Record<string, unknown>) => void logs.push(JSON.stringify({ event, ...fields }))) };
  const metrics = createAirMetrics((line) => logs.push(line));

  const fetcher: AirFetcher = () => {
    provider.calls += 1;
    return provider.healthy ? Promise.resolve(good()) : Promise.reject(new OpenMeteoError("UPSTREAM_SERVER_ERROR", { status: 503 }));
  };

  function instance() {
    const cache = new TieredCache({
      memory: new MemoryCache<NormalizedAirData>(),
      durable: new UpstashCache({ client: redis, retentionSeconds: config.maxStaleSeconds, now: clock.now, logger, metrics }),
      freshWithinMs: config.ttlSeconds * 1000,
      now: clock.now,
      logger,
      metrics,
    });
    const service = createAirService({ config, cache, now: clock.now, fetcher, logger, metrics, capability: () => cache.capability(), production: true });
    const gate = createRateLimitGate({
      limiter: new RedisRateLimiter({ client: redis, policy: POLICY }),
      ipTrust: "render",
      hashSecret: "fake-secret-for-tests",
      logger,
      metrics,
    });
    const call = (cityId: string, ip = "198.51.100.1", extraQuery = "") =>
      handleAirRequest(
        new Request(`http://localhost/api/air?cityId=${cityId}${extraQuery}`, { headers: { "cf-connecting-ip": ip } }),
        () => service,
        clock.now,
        { getGate: () => gate },
      );
    return { call, cache, service };
  }

  return { clock, redis, provider, logs, logger, metrics, instance };
}

const success = async (response: Response) => ((await response.json()) as AirApiSuccess).data;
const failure = async (response: Response) => (await response.json()) as AirApiError;

describe("Scenario A: provider succeeds -> reading stored durably and returned fresh", () => {
  it("returns a fresh reading and writes a validated snapshot to Redis with the original timestamp", async () => {
    const w = world();
    const response = await w.instance().call("mumbai");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-air-freshness")).toBe("fresh");
    expect(response.headers.get("x-air-cache")).toBe("miss");
    expect(response.headers.get("x-air-cache-capability")).toBe("persistent");

    const data = await success(response);
    expect(data.cache).toMatchObject({ status: "miss", capability: "persistent", degraded: false });

    const stored = JSON.parse(w.redis.peek(SNAPSHOT_KEY("mumbai")) ?? "null") as { v: number; storedAtMs: number; value: NormalizedAirData };
    expect(stored.v).toBe(1);
    expect(stored.storedAtMs).toBe(FETCHED_AT_MS);
    expect(stored.value.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(w.redis.ttlSeconds(SNAPSHOT_KEY("mumbai"))).toBe(config.maxStaleSeconds);
  });

  it("lets a brand-new instance (cold start) serve the stored reading without calling the provider", async () => {
    const w = world();
    const first = await success(await w.instance().call("mumbai"));
    w.clock.advance(5 * 60_000);

    const cold = await w.instance().call("mumbai", "198.51.100.2"); // empty memory, same Redis
    const data = await success(cold);
    expect(w.provider.calls).toBe(1);
    expect(cold.headers.get("x-air-cache")).toBe("hit");
    expect(data.fetchedAt).toBe(first.fetchedAt);
    expect(data.ageSeconds).toBe(300);
  });
});

describe("Scenario B: provider fails, Redis holds a valid recent reading -> original reading as stale", () => {
  it("serves the stored reading from a cold instance, unchanged, marked stale, with its true age", async () => {
    const w = world();
    const original = await success(await w.instance().call("mumbai"));

    w.provider.healthy = false;
    w.clock.advance(25 * 60_000); // past the 15-minute freshness window

    const response = await w.instance().call("mumbai", "198.51.100.2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-air-freshness")).toBe("stale");

    const data = await success(response);
    expect(data.freshnessStatus).toBe("stale");
    expect(data.cache.status).toBe("stale-fallback");
    expect(data.fetchedAt).toBe(original.fetchedAt);
    expect(data.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(data.dataTimestamp).toBe(original.dataTimestamp);
    expect(data.calculatedAqi).toEqual(original.calculatedAqi);
    expect(data.ageSeconds).toBe(25 * 60);
    expect(data.warnings.map((w2) => w2.code)).toEqual(expect.arrayContaining(["STALE_DATA", "UPSTREAM_UNAVAILABLE"]));
    expect(data.warnings.find((x) => x.code === "STALE_DATA")?.message).toContain("25 minutes");
  });

  it("never refreshes the stored timestamp, however often the stale reading is served", async () => {
    const w = world();
    await w.instance().call("mumbai");
    w.provider.healthy = false;
    w.clock.advance(30 * 60_000);
    const a = w.instance();
    await a.call("mumbai", "198.51.100.2");
    w.clock.advance(10 * 60_000);
    const later = await success(await a.call("mumbai", "198.51.100.2"));

    expect(later.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(later.ageSeconds).toBe(40 * 60);
    const stored = JSON.parse(w.redis.peek(SNAPSHOT_KEY("mumbai")) ?? "{}") as { storedAtMs: number };
    expect(stored.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("stops serving the reading once Redis has expired it (24 h), and says so", async () => {
    const w = world();
    await w.instance().call("mumbai");
    w.provider.healthy = false;
    w.clock.advance((config.maxStaleSeconds + 60) * 1000);
    const response = await w.instance().call("mumbai", "198.51.100.2");
    expect(response.status).toBe(503);
    expect((await failure(response)).error.code).toBe("AIR_DATA_UNAVAILABLE");
  });
});

describe("Scenario C: provider fails and Redis has no valid snapshot -> unavailable, nothing invented", () => {
  it("returns the explicit unavailable state", async () => {
    const w = world();
    w.provider.healthy = false;
    const response = await w.instance().call("kolkata");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-air-freshness")).toBe("unavailable");

    const body = await failure(response);
    expect(body.error.code).toBe("AIR_DATA_UNAVAILABLE");
    expect(body.data?.freshnessStatus).toBe("unavailable");
    expect(body.data?.calculatedAqi).toBeNull();
    expect(body.data?.fetchedAt).toBeNull();
    expect(body.data?.historicalHourlyData.hours).toEqual([]);
    expect(body.data?.missingPollutants).toHaveLength(8);
  });

  it("caches nothing: an unavailable result is never written to Redis", async () => {
    const w = world();
    w.provider.healthy = false;
    await w.instance().call("kolkata");
    expect(w.redis.keys().filter((k) => k.startsWith("air:v1:snapshot:"))).toEqual([]);
    expect(w.redis.count("SET")).toBe(0);
  });

  it("treats a corrupt Redis entry as no snapshot", async () => {
    const w = world();
    w.provider.healthy = false;
    w.redis.plant(SNAPSHOT_KEY("kolkata"), "{broken", config.maxStaleSeconds);
    const response = await w.instance().call("kolkata");
    expect(response.status).toBe(503);
    expect(w.redis.peek(SNAPSHOT_KEY("kolkata"))).toBeNull(); // discarded
    expect(w.metrics.snapshot().cache_entry_corrupt).toBe(1);
  });

  it("returns no fabricated number anywhere in the body", async () => {
    const w = world();
    w.provider.healthy = false;
    const text = await (await w.instance().call("kolkata")).text();
    expect(text).not.toMatch(/"aqi":\s*\d/);
    expect(text).not.toMatch(/"(value|index|exact)":\s*\d/);
  });
});

describe("Scenario D: Redis fails, provider succeeds -> fresh reading, sanitized log", () => {
  /** Only the CACHE commands fail; the rate limiter's EVAL still works (Redis flakiness). */
  const breakCache = (w: ReturnType<typeof world>) => {
    w.redis.failing.set("GET", "timeout");
    w.redis.failing.set("SET", "timeout");
  };

  it("returns the fresh reading and logs a sanitized cache failure", async () => {
    const w = world();
    breakCache(w);
    const response = await w.instance().call("mumbai");
    expect(response.status).toBe(200);
    const data = await success(response);
    expect(data.freshnessStatus).toBe("fresh");
    expect(data.cache).toMatchObject({ status: "miss", capability: "persistent-unavailable", degraded: true });

    expect(w.metrics.snapshot().redis_failure).toBeGreaterThan(0);
    const log = w.logs.join("\n");
    expect(log).toContain("air.durable_cache_failed");
    expect(log).not.toMatch(/token|bearer|upstash|https?:|198\.51/i);
  });

  it("still keeps the reading in memory, so the next request is a hit", async () => {
    const w = world();
    breakCache(w);
    const inst = w.instance();
    await inst.call("mumbai");
    w.clock.advance(60_000);
    const second = await inst.call("mumbai");
    expect(second.headers.get("x-air-cache")).toBe("hit");
    expect(w.provider.calls).toBe(1);
  });

  it("never crashes the application", async () => {
    const w = world();
    breakCache(w);
    for (const kind of ["timeout", "network", "auth", "http"] as const) {
      w.redis.failing.set("GET", kind);
      w.redis.failing.set("SET", kind);
      const response = await w.instance().call("patna", `198.51.100.${kind.length}`);
      expect([200, 503]).toContain(response.status);
    }
  });
});

describe("Scenario E: Redis fails and the provider fails -> memory snapshot if there is one, else unavailable", () => {
  it("serves a valid in-memory snapshot as stale when only the cache layer is down", async () => {
    const w = world();
    const warm = w.instance();
    const original = await success(await warm.call("mumbai")); // memory + Redis both hold it

    w.redis.failing.set("GET", "network");
    w.redis.failing.set("SET", "network");
    w.provider.healthy = false;
    w.clock.advance(20 * 60_000);

    const data = await success(await warm.call("mumbai"));
    expect(data.freshnessStatus).toBe("stale");
    expect(data.fetchedAt).toBe(original.fetchedAt);
    expect(data.ageSeconds).toBe(20 * 60);
    expect(data.cache.capability).toBe("persistent-unavailable");
  });

  it("serves the in-memory snapshot, without any provider call, during a TOTAL Redis outage", async () => {
    const w = world();
    const warm = w.instance();
    const original = await success(await warm.call("mumbai"));
    const callsBefore = w.provider.calls;

    w.redis.down = "timeout"; // cache AND rate limiter are both unreachable
    w.provider.healthy = false;
    w.clock.advance(20 * 60_000);

    const response = await warm.call("mumbai");
    const data = await success(response);
    expect(response.status).toBe(200);
    expect(data.freshnessStatus).toBe("stale");
    expect(data.fetchedAt).toBe(original.fetchedAt);
    expect(data.warnings.map((x) => x.code)).toContain("REFRESH_PAUSED");
    expect(w.provider.calls).toBe(callsBefore); // refresh was paused: the provider was not called
  });

  it("returns unavailable when neither Redis nor memory holds a snapshot", async () => {
    const w = world();
    w.redis.failing.set("GET", "timeout");
    w.redis.failing.set("SET", "timeout");
    w.provider.healthy = false;
    const response = await w.instance().call("mumbai");
    expect(response.status).toBe(503);
    const body = await failure(response);
    expect(body.error.code).toBe("AIR_DATA_UNAVAILABLE");
    expect(body.data?.calculatedAqi).toBeNull();
  });
});

describe("Redis completely down: rate limiting cannot be enforced -> never unlimited upstream calls", () => {
  it("serves nothing from the provider, and answers a controlled 503 for uncached requests", async () => {
    const w = world();
    w.redis.down = "network";
    const response = await w.instance().call("mumbai");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await failure(response);
    expect(body.error.code).toBe("RATE_LIMITING_UNAVAILABLE");
    expect(body.error.retryAfterSeconds).toBe(30);
    expect(body.data?.freshnessStatus).toBe("unavailable");
    expect(w.provider.calls).toBe(0);
  });

  it("makes ZERO provider calls across 100 requests from 100 different clients", async () => {
    const w = world();
    w.redis.down = "timeout";
    const inst = w.instance();
    const statuses = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      statuses.add((await inst.call("mumbai", `198.51.100.${i + 1}`)).status);
    }
    expect([...statuses]).toEqual([503]);
    expect(w.provider.calls).toBe(0);
  });

  it("does not leak that Redis is involved in the response", async () => {
    const w = world();
    w.redis.down = "auth";
    const text = await (await w.instance().call("mumbai")).text();
    expect(text).not.toMatch(/redis|upstash|token|credential|auth/i);
  });

  it("resumes normal operation as soon as Redis returns", async () => {
    const w = world();
    const inst = w.instance();
    w.redis.down = "timeout";
    expect((await inst.call("mumbai")).status).toBe(503);
    w.redis.down = null;
    const recovered = await inst.call("mumbai");
    expect(recovered.status).toBe(200);
    expect(w.provider.calls).toBe(1);
  });
});

describe("per-client rate limiting through the real handler", () => {
  const readHeaders = (r: Response) => ({
    retryAfter: r.headers.get("retry-after"),
    limit: r.headers.get("ratelimit-limit"),
    remaining: r.headers.get("ratelimit-remaining"),
    reset: r.headers.get("ratelimit-reset"),
  });

  it("answers 429 with Retry-After once a client exceeds the limit, and does no other work", async () => {
    const w = world();
    const inst = w.instance();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await inst.call("mumbai")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const limited = await inst.call("mumbai");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(readHeaders(limited)).toEqual({ retryAfter: "60", limit: "3", remaining: "0", reset: "60" });
    const body = await failure(limited);
    expect(body.error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 60 });
    expect(JSON.stringify(body)).not.toMatch(/198\.51|redis|upstash|header|ip address/i);
  });

  it("counts cache hits, and never calls the provider for a limited request", async () => {
    const w = world();
    const inst = w.instance();
    for (let i = 0; i < 6; i += 1) await inst.call("mumbai"); // 1 miss + 2 hits + 3 limited
    expect(w.provider.calls).toBe(1);
  });

  it("recovers after the window", async () => {
    const w = world();
    const inst = w.instance();
    for (let i = 0; i < 4; i += 1) await inst.call("mumbai");
    expect((await inst.call("mumbai")).status).toBe(429);
    w.clock.advance(61_000);
    expect((await inst.call("mumbai")).status).toBe(200);
  });

  it("gives each client its own allowance", async () => {
    const w = world();
    const inst = w.instance();
    for (let i = 0; i < 4; i += 1) await inst.call("mumbai", "198.51.100.1");
    expect((await inst.call("mumbai", "198.51.100.1")).status).toBe(429);
    expect((await inst.call("mumbai", "198.51.100.2")).status).toBe(200);
  });

  it("is distributed: separate instances share one client's count through Redis", async () => {
    const w = world();
    const instances = [w.instance(), w.instance(), w.instance()];
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await instances[i % 3]!.call("mumbai")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("cannot be bypassed with different cities or extra query parameters", async () => {
    const w = world();
    const inst = w.instance();
    const statuses: number[] = [];
    for (const [city, extra] of [["mumbai", ""], ["patna", ""], ["kolkata", ""], ["mumbai", "&cb=1"], ["mumbai", "&cb=2"], ["lucknow", ""]] as const) {
      statuses.push((await inst.call(city, "198.51.100.1", extra)).status);
    }
    // Three different valid cities share ONE allowance (the 4th valid request is limited);
    // requests with extra parameters are rejected (400) before they could create a new bucket.
    expect(statuses).toEqual([200, 200, 200, 400, 400, 429]);
  });

  it("does not count invalid requests, which do no work", async () => {
    const w = world();
    const inst = w.instance();
    for (let i = 0; i < 10; i += 1) expect((await inst.call("atlantis")).status).toBe(400);
    expect(w.redis.count("EVAL")).toBe(0);
    expect((await inst.call("mumbai")).status).toBe(200);
  });

  it("is not defeated by rotating a spoofed X-Forwarded-For while the platform header is fixed", async () => {
    const w = world();
    const inst = w.instance();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const request = new Request("http://localhost/api/air?cityId=mumbai", {
        headers: { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": `203.0.113.${i + 1}` },
      });
      const service = createAirService({ config, cache: inst.cache, now: w.clock.now, fetcher: () => Promise.resolve(good()), logger: w.logger });
      const gate = createRateLimitGate({ limiter: new RedisRateLimiter({ client: w.redis, policy: POLICY }), ipTrust: "render", hashSecret: "fake-secret-for-tests" });
      statuses.push((await handleAirRequest(request, () => service, w.clock.now, { getGate: () => gate })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("puts no per-client rate-limit headers on a 200, which a CDN may share between clients", async () => {
    const w = world();
    const ok = await w.instance().call("mumbai");
    expect(ok.status).toBe(200);
    expect(readHeaders(ok)).toEqual({ retryAfter: null, limit: null, remaining: null, reset: null });
    expect(ok.headers.get("cache-control")).toMatch(/s-maxage/);
  });

  it("stores only hashed client keys in Redis", async () => {
    const w = world();
    await w.instance().call("mumbai", "198.51.100.99");
    const limiterKeys = w.redis.keys().filter((k) => k.startsWith("air:v1:rl:"));
    expect(limiterKeys).toHaveLength(1);
    expect(limiterKeys[0]).toMatch(/^air:v1:rl:c:[0-9a-f]{32}$/);
    expect(w.redis.keys().join()).not.toContain("198.51.100.99");
  });
});

describe("observability in practice", () => {
  it("records the cache, provider and limiter events of a mixed run, without sensitive data", async () => {
    const w = world();
    const inst = w.instance();
    await inst.call("mumbai"); // miss
    await inst.call("mumbai"); // hit
    w.provider.healthy = false;
    w.clock.advance(20 * 60_000);
    await inst.call("mumbai", "198.51.100.2"); // provider failure -> stale
    for (let i = 0; i < 4; i += 1) await inst.call("mumbai", "198.51.100.3"); // limited once
    w.redis.down = "timeout";
    await inst.call("patna", "198.51.100.4"); // degraded

    expect(w.metrics.snapshot()).toMatchObject({
      cache_miss: 1,
      provider_failure: 1,
      // Every stale response served counts: the failed refresh for .2, then the 3 permitted requests from .3.
      stale_fallback: 4,
      rate_limit_rejection: 1,
      rate_limit_degraded: 1,
    });
    expect(w.metrics.snapshot().cache_hit).toBeGreaterThanOrEqual(1);
    expect(w.metrics.snapshot().redis_failure).toBeGreaterThanOrEqual(1);
    expect(w.logs.join("\n")).not.toMatch(/198\.51|token|bearer|authorization/i);
  });
});
