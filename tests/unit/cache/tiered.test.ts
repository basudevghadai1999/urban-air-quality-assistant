import { describe, expect, it, vi } from "vitest";

import { MemoryCache, TieredCache } from "@/lib/cache";
import { UpstashCache } from "@/lib/cache/upstash";
import { createAirMetrics } from "@/lib/observability/metrics";
import type { NormalizedAirData } from "@/types/air";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { FETCHED_AT_MS } from "../../fixtures/openMeteo";
import { makeSnapshot } from "../../fixtures/snapshot";

const FRESH_MS = 900_000;
const entryAt = (cityId: "mumbai" | "patna", fetchedAtMs: number) => {
  const value = makeSnapshot(cityId, fetchedAtMs);
  return { value, storedAtMs: fetchedAtMs };
};

/** One call builds "an instance": its own memory, sharing the given Redis. */
function instance(redis: FakeRedis | null, clock: ReturnType<typeof makeClock>) {
  const logger = { warn: vi.fn() };
  const lines: string[] = [];
  const metrics = createAirMetrics((line) => lines.push(line));
  const memory = new MemoryCache<NormalizedAirData>();
  const durable = redis === null ? null : new UpstashCache({ client: redis, retentionSeconds: 86_400, now: clock.now });
  const cache = new TieredCache({ memory, durable, freshWithinMs: FRESH_MS, now: clock.now, logger, metrics });
  return { cache, memory, logger, lines, metrics };
}

describe("TieredCache: reads", () => {
  it("serves a fresh memory entry without touching Redis", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const { cache, memory } = instance(redis, clock);
    await memory.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    clock.advance(60_000);
    expect(await cache.get("mumbai")).not.toBeNull();
    expect(redis.commands).toHaveLength(0);
  });

  it("falls through to Redis when memory is empty (a cold start), and remembers the result in memory", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const writer = instance(redis, clock);
    await writer.cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));

    const coldInstance = instance(redis, clock); // a new serverless instance: empty memory, same Redis
    const got = await coldInstance.cache.get("mumbai");
    expect(got?.storedAtMs).toBe(FETCHED_AT_MS);
    expect(await coldInstance.memory.get("mumbai")).not.toBeNull(); // now warm
    const before = redis.count("GET");
    await coldInstance.cache.get("mumbai");
    expect(redis.count("GET")).toBe(before); // second read served from memory
  });

  it("consults Redis when the memory entry is no longer fresh, and prefers the newer snapshot", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const other = instance(redis, clock);
    const mine = instance(redis, clock);
    await mine.cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    clock.advance(20 * 60_000);
    await other.cache.set("mumbai", entryAt("mumbai", clock.now())); // another instance refreshed it

    const got = await mine.cache.get("mumbai");
    expect(got?.storedAtMs).toBe(clock.now());
  });

  it("keeps its own memory entry when it is newer than Redis's", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const { cache, memory } = instance(redis, clock);
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    clock.advance(20 * 60_000);
    await memory.set("mumbai", entryAt("mumbai", clock.now() - 1_000)); // newer than what Redis holds
    expect((await cache.get("mumbai"))?.storedAtMs).toBe(clock.now() - 1_000);
  });

  it("returns null when neither tier has the city", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    expect(await instance(new FakeRedis(clock.now), clock).cache.get("patna")).toBeNull();
  });
});

describe("TieredCache: Redis failure degrades to memory, never throws", () => {
  it("serves the memory snapshot when a read from Redis fails (Scenario E's cache half)", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const { cache } = instance(redis, clock);
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    clock.advance(30 * 60_000); // memory entry no longer fresh -> Redis is consulted
    redis.down = "timeout";
    const got = await cache.get("mumbai");
    expect(got?.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("returns null (not an error) when Redis fails and memory is empty", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    redis.down = "network";
    await expect(instance(redis, clock).cache.get("mumbai")).resolves.toBeNull();
  });

  it("still stores in memory when the Redis write fails (Scenario D's cache half)", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    redis.down = "http";
    const { cache, memory } = instance(redis, clock);
    await expect(cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS))).resolves.toBeUndefined();
    expect(await memory.get("mumbai")).not.toBeNull();
  });

  it("counts every failure but logs at most once per minute, without payloads", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    redis.down = "timeout";
    const { cache, logger, metrics } = instance(redis, clock);
    for (let i = 0; i < 5; i += 1) await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    expect(metrics.snapshot().redis_failure).toBe(5);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("air.durable_cache_failed", { operation: "set", kind: "timeout" });

    clock.advance(61_000);
    await cache.set("mumbai", entryAt("mumbai", clock.now()));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/mumbai|snapshot|http|token/i);
  });

  it("deletes from both tiers, tolerating a Redis failure", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const { cache, memory } = instance(redis, clock);
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    redis.down = "network";
    await expect(cache.delete("mumbai")).resolves.toBeUndefined();
    expect(await memory.get("mumbai")).toBeNull();
  });
});

describe("TieredCache: honest capability reporting", () => {
  it("is memory-only with no durable store", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const { cache } = instance(null, clock);
    expect(cache.capability()).toBe("memory-only");
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    expect(await cache.get("mumbai")).not.toBeNull();
    expect(cache.capability()).toBe("memory-only");
  });

  it("is persistent while Redis works, persistent-unavailable when it fails, and recovers", async () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const { cache } = instance(redis, clock);
    expect(cache.capability()).toBe("persistent");

    redis.down = "timeout";
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    expect(cache.capability()).toBe("persistent-unavailable");

    redis.down = null;
    await cache.set("mumbai", entryAt("mumbai", FETCHED_AT_MS));
    expect(cache.capability()).toBe("persistent");
  });
});
