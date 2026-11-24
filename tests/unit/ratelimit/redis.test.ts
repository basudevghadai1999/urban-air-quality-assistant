import { describe, expect, it } from "vitest";

import { RedisRateLimiter, RATE_LIMIT_SCRIPT, DEFAULT_RATE_LIMIT_KEY_PREFIX } from "@/lib/ratelimit/redis";
import type { RedisCommandClient } from "@/lib/redis";
import { RedisError } from "@/lib/redis/errors";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";

const POLICY = { limit: 30, windowSeconds: 60 };
const limiterOn = (client: RedisCommandClient, policy = POLICY) => new RedisRateLimiter({ client, policy });

describe("RedisRateLimiter: the 30-requests-per-minute policy", () => {
  it("allows requests below the limit", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const result = await limiterOn(redis).check("c:abc");
    expect(result).toEqual({ allowed: true, limit: 30, remaining: 29, resetSeconds: 60 });
  });

  it("allows the 30th request and rejects the 31st", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const limiter = limiterOn(redis);
    let last = await limiter.check("c:abc");
    for (let i = 2; i <= 30; i += 1) last = await limiter.check("c:abc");
    expect(last).toMatchObject({ allowed: true, remaining: 0 });
    expect(await limiter.check("c:abc")).toMatchObject({ allowed: false, remaining: 0, limit: 30 });
  });

  it("keeps rejecting above the limit", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const limiter = limiterOn(redis, { limit: 2, windowSeconds: 60 });
    const allowed = [];
    for (let i = 0; i < 6; i += 1) allowed.push((await limiter.check("c:abc")).allowed);
    expect(allowed).toEqual([true, true, false, false, false, false]);
  });

  it("resets when the window ends (Redis expires the counter)", async () => {
    const clock = makeClock(0);
    const redis = new FakeRedis(clock.now);
    const limiter = limiterOn(redis, { limit: 2, windowSeconds: 60 });
    for (let i = 0; i < 3; i += 1) await limiter.check("c:abc");
    expect((await limiter.check("c:abc")).allowed).toBe(false);
    clock.advance(60_001);
    expect(await limiter.check("c:abc")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("reports the real time left in the window", async () => {
    const clock = makeClock(0);
    const limiter = limiterOn(new FakeRedis(clock.now));
    await limiter.check("c:abc");
    clock.advance(25_000);
    expect((await limiter.check("c:abc")).resetSeconds).toBe(35);
  });

  it("does not extend the window while a client keeps retrying", async () => {
    const clock = makeClock(0);
    const redis = new FakeRedis(clock.now);
    const limiter = limiterOn(redis, { limit: 1, windowSeconds: 60 });
    await limiter.check("c:abc");
    for (let i = 0; i < 10; i += 1) {
      clock.advance(1_000);
      await limiter.check("c:abc");
    }
    expect(redis.ttlSeconds(`${DEFAULT_RATE_LIMIT_KEY_PREFIX}c:abc`)).toBe(50);
  });

  it("counts clients independently", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const limiter = limiterOn(redis, { limit: 1, windowSeconds: 60 });
    await limiter.check("c:one");
    expect((await limiter.check("c:one")).allowed).toBe(false);
    expect((await limiter.check("c:two")).allowed).toBe(true);
  });
});

describe("RedisRateLimiter: distributed across instances", () => {
  it("shares one count between many instances (serverless) using the same Redis", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const instances = [limiterOn(redis, { limit: 6, windowSeconds: 60 }), limiterOn(redis, { limit: 6, windowSeconds: 60 }), limiterOn(redis, { limit: 6, windowSeconds: 60 })];
    const decisions: boolean[] = [];
    for (let i = 0; i < 9; i += 1) decisions.push((await instances[i % 3]!.check("c:same")).allowed);
    expect(decisions).toEqual([true, true, true, true, true, true, false, false, false]);
  });

  it("is safe under concurrent requests: exactly `limit` are allowed", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    const limiter = limiterOn(redis, { limit: 10, windowSeconds: 60 });
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.check("c:burst")));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});

describe("RedisRateLimiter: the Redis conversation", () => {
  it("sends one atomic EVAL per check, with the key and the window in milliseconds", async () => {
    const redis = new FakeRedis(makeClock(0).now);
    await limiterOn(redis).check("c:abc");
    expect(redis.commands).toHaveLength(1);
    expect(redis.commands[0]).toEqual(["EVAL", RATE_LIMIT_SCRIPT, 1, "air:v1:rl:c:abc", 60_000]);
  });

  it("uses a single atomic script (INCR, set expiry on first hit, heal a missing expiry), not a pipeline", () => {
    expect(RATE_LIMIT_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
    expect(RATE_LIMIT_SCRIPT).toMatch(/if count == 1 then\s+redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[1\]\)/);
    expect(RATE_LIMIT_SCRIPT).toContain("redis.call('PTTL', KEYS[1])");
    expect(RATE_LIMIT_SCRIPT).toMatch(/if ttl < 0 then\s+redis\.call\('PEXPIRE'/);
    expect(RATE_LIMIT_SCRIPT).toContain("return {count, ttl}");
  });

  it.each(["", "C:ABC", "a b", "x\r\nDEL *", "../k", "a".repeat(81)])("refuses the key %j", async (key) => {
    const redis = new FakeRedis(makeClock(0).now);
    await expect(limiterOn(redis).check(key)).rejects.toBeInstanceOf(RangeError);
    expect(redis.commands).toHaveLength(0);
  });
});

describe("RedisRateLimiter: failures throw, they never allow", () => {
  it.each(["timeout", "network", "auth", "http"] as const)("propagates a %s failure", async (kind) => {
    const redis = new FakeRedis(makeClock(0).now);
    redis.down = kind;
    await expect(limiterOn(redis).check("c:abc")).rejects.toMatchObject({ name: "RedisError", kind });
  });

  it.each([
    ["null", null],
    ["a string", "OK"],
    ["a number", 5],
    ["an empty array", []],
    ["the wrong arity", [1]],
    ["a non-numeric count", ["x", 1000]],
    ["a fractional count", [1.5, 1000]],
    ["a zero count", [0, 1000]],
    ["a non-numeric ttl", [1, "soon"]],
    ["a non-finite ttl", [1, Number.POSITIVE_INFINITY]],
  ])("rejects %s from Redis as a protocol error", async (_label, reply) => {
    const client: RedisCommandClient = { command: () => Promise.resolve(reply) };
    await expect(limiterOn(client).check("c:abc")).rejects.toMatchObject({ kind: "protocol" });
  });

  it("clamps an implausible TTL into the window", async () => {
    const client: RedisCommandClient = { command: () => Promise.resolve([1, 9_999_999]) };
    expect((await limiterOn(client).check("c:abc")).resetSeconds).toBe(60);
    const negative: RedisCommandClient = { command: () => Promise.resolve([1, -2]) };
    expect((await limiterOn(negative).check("c:abc")).resetSeconds).toBe(1);
  });

  it("surfaces a typed RedisError, not a generic one", async () => {
    const client: RedisCommandClient = { command: () => Promise.reject(new RedisError("timeout")) };
    await expect(limiterOn(client).check("c:abc")).rejects.toBeInstanceOf(RedisError);
  });
});
