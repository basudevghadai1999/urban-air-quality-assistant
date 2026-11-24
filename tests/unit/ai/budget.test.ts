import { describe, expect, it } from "vitest";

import {
  BUDGET_SCRIPT,
  MemoryDailyBudget,
  RedisDailyBudget,
  msUntilNextUtcMidnight,
  utcDayKey,
} from "@/lib/ai/budget";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";

const T0 = Date.UTC(2026, 10, 24, 10, 30, 0); // 2026-11-24 10:30 UTC

function redisBudget(limit: number, clock = makeClock(T0), redis = new FakeRedis(() => clock.now())) {
  return { clock, redis, budget: new RedisDailyBudget({ client: redis, limit, now: clock.now }) };
}

describe("UTC day boundaries", () => {
  it("keys by the UTC date, not the local one", () => {
    expect(utcDayKey(T0)).toBe("20261124");
    expect(utcDayKey(Date.UTC(2026, 10, 24, 23, 59, 59, 999))).toBe("20261124");
    expect(utcDayKey(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe("20261125");
    expect(utcDayKey(Date.UTC(2026, 11, 31, 23, 0, 0))).toBe("20261231");
    expect(utcDayKey(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe("20270101");
  });

  it("computes the time to the next 00:00 UTC", () => {
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe(86_400_000);
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 10, 24, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextUtcMidnight(T0)).toBe(13.5 * 3_600_000);
  });
});

describe("Redis daily budget", () => {
  it("allows exactly the limit, then refuses, and never lets the counter exceed the limit", async () => {
    const { budget, redis } = redisBudget(3);
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await budget.reserve());
    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false, false, false]);
    expect(outcomes.map((o) => o.used)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(redis.peek("ai:v1:budget:20261124")).toBe("3");
  });

  it("is atomic across concurrent reservations (many instances, one Redis)", async () => {
    const clock = makeClock(T0);
    const redis = new FakeRedis(() => clock.now());
    const instances = Array.from({ length: 5 }, () => new RedisDailyBudget({ client: redis, limit: 10, now: clock.now }));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => instances[i % 5]?.reserve()));
    expect(results.filter((r) => r?.allowed).length).toBe(10);
    expect(redis.peek("ai:v1:budget:20261124")).toBe("10");
  });

  it("sends a single EVAL of the documented script, with the limit and a TTL that outlives the day", async () => {
    const { budget, redis } = redisBudget(5);
    await budget.reserve();
    expect(redis.commands).toHaveLength(1);
    const [name, script, keys, key, limit, ttl] = redis.commands[0] ?? [];
    expect(name).toBe("EVAL");
    expect(script).toBe(BUDGET_SCRIPT);
    expect(keys).toBe(1);
    expect(key).toBe("ai:v1:budget:20261124");
    expect(limit).toBe(5);
    expect(ttl).toBe(13.5 * 3_600_000 + 3_600_000);
    expect(BUDGET_SCRIPT).toMatch(/INCR/);
    expect(BUDGET_SCRIPT).toMatch(/DECR/);
    expect(BUDGET_SCRIPT).toMatch(/PEXPIRE/);
  });

  it("resets at 00:00 UTC: a new day is a new counter", async () => {
    const { budget, clock, redis } = redisBudget(2);
    await budget.reserve();
    await budget.reserve();
    expect((await budget.reserve()).allowed).toBe(false);
    clock.set(Date.UTC(2026, 10, 24, 23, 59, 59));
    expect((await budget.reserve()).allowed).toBe(false);
    clock.set(Date.UTC(2026, 10, 25, 0, 0, 1));
    const next = await budget.reserve();
    expect(next).toMatchObject({ allowed: true, used: 1 });
    expect(redis.peek("ai:v1:budget:20261125")).toBe("1");
  });

  it("the key expires after its day plus the grace period, so Redis does not accumulate counters", async () => {
    const { budget, redis, clock } = redisBudget(2);
    await budget.reserve();
    expect(redis.peek("ai:v1:budget:20261124")).toBe("1");
    clock.set(T0 + 14.6 * 3_600_000 + 1_000);
    expect(redis.peek("ai:v1:budget:20261124")).toBeNull();
  });

  it("reports seconds until reset, at least one", async () => {
    const { budget, clock } = redisBudget(1);
    expect((await budget.reserve()).resetsInSeconds).toBe(48_600);
    clock.set(Date.UTC(2026, 10, 24, 23, 59, 59, 900));
    expect((await budget.reserve()).resetsInSeconds).toBe(1);
  });

  it("throws on a Redis failure, so the caller can fail closed", async () => {
    const { budget, redis } = redisBudget(5);
    redis.down = "network";
    await expect(budget.reserve()).rejects.toMatchObject({ kind: "network" });
    redis.down = null;
    redis.failing.set("EVAL", "timeout");
    await expect(budget.reserve()).rejects.toMatchObject({ kind: "timeout" });
  });

  it.each([null, "x", [1], [2, 1], ["1", 1], [1, "1"], [1, -1], [1, 1.5], []])("rejects a malformed Redis reply %j", async (reply) => {
    const bad = { command: () => Promise.resolve(reply) };
    await expect(new RedisDailyBudget({ client: bad, limit: 5 }).reserve()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("a failed reservation consumes nothing", async () => {
    const { budget, redis } = redisBudget(2);
    redis.failNext = ["network"];
    await expect(budget.reserve()).rejects.toBeDefined();
    expect(redis.peek("ai:v1:budget:20261124")).toBeNull();
    expect((await budget.reserve()).used).toBe(1);
  });
});

describe("memory daily budget (local development only)", () => {
  it("allows the limit, refuses the rest, and resets on a new UTC day", async () => {
    const clock = makeClock(T0);
    const budget = new MemoryDailyBudget(2, clock.now);
    expect((await budget.reserve()).allowed).toBe(true);
    expect((await budget.reserve()).allowed).toBe(true);
    const refused = await budget.reserve();
    expect(refused).toMatchObject({ allowed: false, used: 2, limit: 2 });
    clock.set(Date.UTC(2026, 10, 25, 0, 0, 0));
    expect(await budget.reserve()).toMatchObject({ allowed: true, used: 1 });
  });
});
