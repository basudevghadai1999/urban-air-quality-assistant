import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CACHE_KEY_PREFIX, UpstashCache } from "@/lib/cache/upstash";
import { createAirMetrics } from "@/lib/observability/metrics";
import { RedisError } from "@/lib/redis/errors";
import type { NormalizedAirData } from "@/types/air";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { FETCHED_AT_MS } from "../../fixtures/openMeteo";
import { makeSnapshot } from "../../fixtures/snapshot";

const RETENTION = 86_400; // maximum stale age: 24 hours
const KEY = (city: string) => `${DEFAULT_CACHE_KEY_PREFIX}${city}`;

function setup(startMs = FETCHED_AT_MS) {
  const clock = makeClock(startMs);
  const redis = new FakeRedis(clock.now);
  const logger = { warn: vi.fn() };
  const counts: string[] = [];
  const metrics = createAirMetrics((line) => counts.push(line));
  const cache = new UpstashCache({ client: redis, retentionSeconds: RETENTION, now: clock.now, logger, metrics });
  return { clock, redis, cache, logger, metrics, counts };
}

const entryFor = (snapshot: NormalizedAirData) => ({ value: snapshot, storedAtMs: Date.parse(snapshot.fetchedAt ?? "") });

describe("UpstashCache: write and read", () => {
  it("round-trips a snapshot exactly", async () => {
    const { cache } = setup();
    const snapshot = makeSnapshot("mumbai");
    await cache.set("mumbai", entryFor(snapshot));
    const got = await cache.get("mumbai");
    expect(got?.value).toEqual(snapshot);
    expect(got?.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("returns null for a key that was never written", async () => {
    expect(await setup().cache.get("patna")).toBeNull();
  });

  it("stores one namespaced key per city, with the retention TTL set by Redis", async () => {
    const { cache, redis } = setup();
    await cache.set("kolkata", entryFor(makeSnapshot("kolkata")));
    await cache.set("lucknow", entryFor(makeSnapshot("lucknow")));
    expect(redis.keys().sort()).toEqual([KEY("kolkata"), KEY("lucknow")]);
    expect(redis.ttlSeconds(KEY("kolkata"))).toBe(RETENTION);
    expect(redis.commands[0]?.slice(2)).toEqual([expect.any(String), "EX", RETENTION]);
  });

  it("keeps cities independent", async () => {
    const { cache } = setup();
    await cache.set("mumbai", entryFor(makeSnapshot("mumbai")));
    expect(await cache.get("patna")).toBeNull();
    expect((await cache.get("mumbai"))?.value.cityId).toBe("mumbai");
  });

  it("deletes", async () => {
    const { cache } = setup();
    await cache.set("mumbai", entryFor(makeSnapshot("mumbai")));
    await cache.delete("mumbai");
    expect(await cache.get("mumbai")).toBeNull();
  });
});

describe("UpstashCache: expiration", () => {
  it("lets Redis drop an entry once it is older than the maximum stale age", async () => {
    const { cache, clock } = setup();
    await cache.set("mumbai", entryFor(makeSnapshot("mumbai")));
    clock.advance((RETENTION - 1) * 1000);
    expect(await cache.get("mumbai")).not.toBeNull();
    clock.advance(2_000);
    expect(await cache.get("mumbai")).toBeNull();
  });

  it("still returns an entry well past the 15-minute freshness window (it is the stale fallback)", async () => {
    const { cache, clock } = setup();
    await cache.set("mumbai", entryFor(makeSnapshot("mumbai")));
    clock.advance(6 * 3_600 * 1000);
    expect(await cache.get("mumbai")).not.toBeNull();
  });
});

describe("UpstashCache: original timestamps are preserved", () => {
  it("returns the original fetchedAt and storedAtMs no matter how long ago or how often it is read", async () => {
    const { cache, clock } = setup();
    const snapshot = makeSnapshot("delhi-ncr");
    await cache.set("delhi-ncr", entryFor(snapshot));
    clock.advance(3 * 3_600 * 1000);
    for (let i = 0; i < 3; i += 1) await cache.get("delhi-ncr");
    const got = await cache.get("delhi-ncr");
    expect(got?.value.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(got?.value.dataTimestamp).toBe(snapshot.dataTimestamp);
    expect(got?.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("lets the caller compute the true age from the preserved timestamp", async () => {
    const { cache, clock } = setup();
    await cache.set("delhi-ncr", entryFor(makeSnapshot("delhi-ncr")));
    clock.advance(95 * 60 * 1000);
    const got = await cache.get("delhi-ncr");
    expect((clock.now() - (got?.storedAtMs ?? 0)) / 1000).toBe(95 * 60);
  });
});

describe("UpstashCache: corrupt and invalid entries are a safe miss", () => {
  const corrupt = async (planted: string) => {
    const ctx = setup();
    ctx.redis.plant(KEY("mumbai"), planted, RETENTION);
    const got = await ctx.cache.get("mumbai");
    return { ...ctx, got };
  };

  it("treats malformed JSON as a miss, deletes it, counts it, and logs without the content", async () => {
    const { got, redis, logger, counts } = await corrupt("{this is not json SECRET-CONTENT");
    expect(got).toBeNull();
    expect(redis.peek(KEY("mumbai"))).toBeNull(); // removed
    expect(logger.warn).toHaveBeenCalledWith("air.cache_entry_discarded", { cityId: "mumbai", kind: "corrupt-json" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET-CONTENT");
    expect(counts.join("")).toContain("cache_entry_corrupt");
  });

  it.each([
    ["an empty string", ""],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["an empty object", "{}"],
    ["the wrong version", JSON.stringify({ v: 2, storedAtMs: 1, value: {} })],
    ["a missing value", JSON.stringify({ v: 1, storedAtMs: FETCHED_AT_MS })],
    ["a value that is not a snapshot", JSON.stringify({ v: 1, storedAtMs: FETCHED_AT_MS, value: { cityId: "mumbai" } })],
  ])("rejects %s", async (_label, planted) => {
    const { got, logger } = await corrupt(planted);
    expect(got).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("air.cache_entry_discarded", expect.objectContaining({ cityId: "mumbai" }));
  });

  const stored = (mutate: (snapshot: Record<string, unknown>) => void, storedAtMs = FETCHED_AT_MS) => {
    const snapshot = JSON.parse(JSON.stringify(makeSnapshot("mumbai"))) as Record<string, unknown>;
    mutate(snapshot);
    return JSON.stringify({ v: 1, storedAtMs, value: snapshot });
  };

  it("rejects a snapshot stored under the wrong city key", async () => {
    const ctx = setup();
    ctx.redis.plant(KEY("patna"), stored(() => undefined), RETENTION); // a Mumbai snapshot filed as Patna
    expect(await ctx.cache.get("patna")).toBeNull();
  });

  it("rejects a storedAtMs that disagrees with the snapshot's own fetchedAt", async () => {
    expect((await corrupt(stored(() => undefined, FETCHED_AT_MS + 5_000))).got).toBeNull();
  });

  it("rejects a timestamp in the future, which would look fresh forever", async () => {
    const future = FETCHED_AT_MS + 3_600_000;
    const ctx = setup();
    const snapshot = makeSnapshot("mumbai", future);
    ctx.redis.plant(KEY("mumbai"), JSON.stringify({ v: 1, storedAtMs: future, value: snapshot }), RETENTION);
    expect(await ctx.cache.get("mumbai")).toBeNull();
  });

  it("tolerates a few minutes of clock skew between instances", async () => {
    const ctx = setup();
    const skewed = FETCHED_AT_MS + 2 * 60_000;
    ctx.redis.plant(KEY("mumbai"), JSON.stringify({ v: 1, storedAtMs: skewed, value: makeSnapshot("mumbai", skewed) }), RETENTION);
    expect(await ctx.cache.get("mumbai")).not.toBeNull();
  });

  it.each([
    ["a snapshot marked unavailable", (s: Record<string, unknown>) => (s.freshnessStatus = "unavailable")],
    ["a null fetchedAt", (s: Record<string, unknown>) => (s.fetchedAt = null)],
    ["a tampered disclaimer", (s: Record<string, unknown>) => (s.disclaimer = "This is an official CPCB reading.")],
    ["a missing attribution", (s: Record<string, unknown>) => delete (s.sourceInfo as Record<string, unknown>).attribution],
    ["an unknown city", (s: Record<string, unknown>) => (s.cityId = "atlantis")],
  ])("rejects %s", async (_label, mutate) => {
    expect((await corrupt(stored(mutate))).got).toBeNull();
  });

  it("rejects a 'valid' AQI that no longer matches its own sub-indices (a fabricated number)", async () => {
    const planted = stored((s) => {
      (s.calculatedAqi as Record<string, unknown>).aqi = 499;
    });
    expect((await corrupt(planted)).got).toBeNull();
  });

  it("rejects an AQI carried by a result that is not a valid estimate", async () => {
    const planted = stored((s) => {
      const aqi = s.calculatedAqi as Record<string, unknown>;
      aqi.status = "insufficient_data"; // but still carries a number
    });
    expect((await corrupt(planted)).got).toBeNull();
  });

  it("still serves the entry if deleting the discarded one fails", async () => {
    const ctx = setup();
    ctx.redis.plant(KEY("mumbai"), "garbage", RETENTION);
    ctx.redis.failNext = []; // GET succeeds, DEL will fail:
    const original = ctx.redis.command.bind(ctx.redis);
    ctx.redis.command = (args) => (String(args[0]) === "DEL" ? Promise.reject(new RedisError("timeout")) : original(args));
    await expect(ctx.cache.get("mumbai")).resolves.toBeNull();
  });
});

describe("UpstashCache: never caches something that is not a reading", () => {
  it("refuses an unavailable snapshot, a never-fetched snapshot, and a snapshot with no AQI result", async () => {
    const { cache, redis } = setup();
    const good = makeSnapshot("mumbai");
    const bad: NormalizedAirData[] = [
      { ...good, freshnessStatus: "unavailable" },
      { ...good, fetchedAt: null },
      { ...good, calculatedAqi: null },
    ];
    for (const value of bad) {
      await expect(cache.set("mumbai", { value, storedAtMs: FETCHED_AT_MS })).rejects.toBeInstanceOf(RangeError);
    }
    expect(redis.count("SET")).toBe(0);
  });

  it("accepts a stale snapshot built from real data (provider lag is still a reading)", async () => {
    const { cache } = setup();
    const stale = { ...makeSnapshot("mumbai"), freshnessStatus: "stale" as const };
    await expect(cache.set("mumbai", entryFor(stale))).resolves.toBeUndefined();
  });
});

describe("UpstashCache: Redis failures throw a typed error (they are not a miss)", () => {
  it.each(["timeout", "network", "auth", "http"] as const)("surfaces a %s failure on read and on write", async (kind) => {
    const { cache, redis } = setup();
    redis.down = kind;
    await expect(cache.get("mumbai")).rejects.toMatchObject({ name: "RedisError", kind });
    await expect(cache.set("mumbai", entryFor(makeSnapshot("mumbai")))).rejects.toMatchObject({ kind });
  });
});

describe("UpstashCache: key and option safety", () => {
  it.each(["", "Mumbai", "a b", "mumbai:extra", "../x", "x\r\nSET evil 1", "a".repeat(60), "9city"])(
    "refuses the key %j",
    async (key) => {
      const { cache, redis } = setup();
      await expect(cache.get(key)).rejects.toBeInstanceOf(RangeError);
      await expect(cache.delete(key)).rejects.toBeInstanceOf(RangeError);
      expect(redis.commands).toHaveLength(0);
    },
  );

  it.each([0, -5, 1.5, Number.NaN])("rejects retentionSeconds %s", (retentionSeconds) => {
    expect(() => new UpstashCache({ client: new FakeRedis(Date.now), retentionSeconds })).toThrow(RangeError);
  });
});
