import { describe, expect, it } from "vitest";

import { MemoryProviderBudget, PROVIDER_BUDGET_SCRIPT, RedisProviderBudget } from "@/lib/ai/providerBudget";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { NOW } from "../../fixtures/engine";

/** Redis here is the in-memory FakeRedis, which emulates the Lua script's semantics. */

const limits = (global: number, gemini = 100, groq = 100) => ({ global, providers: { gemini, groq } });

describe.each([
  ["memory", () => ({ budget: new MemoryProviderBudget(limits(4, 3, 2), () => NOW) })],
  [
    "redis (emulated script)",
    () => {
      const clock = makeClock(NOW);
      const redis = new FakeRedis(clock.now);
      return { budget: new RedisProviderBudget({ client: redis, limits: limits(4, 3, 2), now: clock.now }) };
    },
  ],
] as const)("provider budget: %s", (_name, make) => {
  it("charges the global counter and the provider's counter together", async () => {
    const { budget } = make();
    expect(await budget.reserve("gemini")).toMatchObject({ allowed: true, deniedBy: null, usedGlobal: 1, usedProvider: 1 });
    expect(await budget.reserve("groq")).toMatchObject({ allowed: true, usedGlobal: 2, usedProvider: 1 });
    expect(await budget.reserve("gemini")).toMatchObject({ allowed: true, usedGlobal: 3, usedProvider: 2 });
  });

  it("a full provider cap refuses that provider only and charges nothing", async () => {
    const { budget } = make();
    await budget.reserve("groq");
    await budget.reserve("groq");
    const refused = await budget.reserve("groq");
    expect(refused).toMatchObject({ allowed: false, deniedBy: "provider", usedGlobal: 2, usedProvider: 2 });
    // Gemini is unaffected, and the global counter did not move for the refused call.
    expect(await budget.reserve("gemini")).toMatchObject({ allowed: true, usedGlobal: 3, usedProvider: 1 });
  });

  it("the global cap is shared: switching provider cannot get past it", async () => {
    const { budget } = make();
    for (const p of ["gemini", "gemini", "gemini", "groq"] as const) expect((await budget.reserve(p)).allowed).toBe(true);
    for (const p of ["gemini", "groq"] as const) {
      expect(await budget.reserve(p)).toMatchObject({ allowed: false, deniedBy: "global", usedGlobal: 4 });
    }
  });

  it("reports seconds until the next UTC midnight", async () => {
    const { budget } = make();
    const r = await budget.reserve("gemini");
    expect(r.resetsInSeconds).toBeGreaterThan(0);
    expect(r.resetsInSeconds).toBeLessThanOrEqual(86_400);
  });
});

describe("daily reset (UTC)", () => {
  it("a new UTC day starts every counter again", async () => {
    let now = Date.UTC(2026, 10, 24, 23, 59, 0);
    const budget = new MemoryProviderBudget(limits(1), () => now);
    expect((await budget.reserve("gemini")).allowed).toBe(true);
    expect((await budget.reserve("groq")).allowed).toBe(false);
    now = Date.UTC(2026, 10, 25, 0, 0, 1);
    expect((await budget.reserve("groq")).allowed).toBe(true);
  });

  it("redis keys carry the UTC date, so midnight is a new key", async () => {
    const day1 = Date.UTC(2026, 10, 24, 23, 59, 0);
    const clock = makeClock(day1);
    const redis = new FakeRedis(clock.now);
    const budget = new RedisProviderBudget({ client: redis, limits: limits(1), now: clock.now });
    expect((await budget.reserve("gemini")).allowed).toBe(true);
    expect((await budget.reserve("gemini")).allowed).toBe(false);
    clock.advance(2 * 60_000);
    expect((await budget.reserve("gemini")).allowed).toBe(true);
    const keys = redis.commands.filter((c) => c[0] === "EVAL").map((c) => String(c[3]));
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toMatch(/^ai:v1:budget:20261124$/);
    expect(keys[keys.length - 1]).toMatch(/^ai:v1:budget:20261125$/);
  });
});

describe("atomicity under concurrency", () => {
  it("many concurrent reservations never exceed the global or any provider cap", async () => {
    const clock = makeClock(NOW);
    const redis = new FakeRedis(clock.now);
    // Three "instances" sharing one Redis.
    const instances = [0, 1, 2].map(() => new RedisProviderBudget({ client: redis, limits: limits(7, 4, 5), now: clock.now }));
    const providers = Array.from({ length: 60 }, (_, n) => (n % 2 === 0 ? ("gemini" as const) : ("groq" as const)));
    const results = await Promise.all(providers.map((p, n) => instances[n % 3]!.reserve(p)));
    const allowedBy = (p: "gemini" | "groq") => results.filter((r, n) => r.allowed && providers[n] === p).length;
    expect(allowedBy("gemini") + allowedBy("groq")).toBe(7);
    expect(allowedBy("gemini")).toBeLessThanOrEqual(4);
    expect(allowedBy("groq")).toBeLessThanOrEqual(5);
    expect(Math.max(...results.map((r) => r.usedGlobal))).toBeLessThanOrEqual(7);
  });

  it("sends one EVAL per reservation, with both keys in one script", async () => {
    const clock = makeClock(NOW);
    const redis = new FakeRedis(clock.now);
    await new RedisProviderBudget({ client: redis, limits: limits(5), now: clock.now }).reserve("groq");
    const evals = redis.commands.filter((c) => c[0] === "EVAL");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.[1]).toBe(PROVIDER_BUDGET_SCRIPT);
    expect(evals[0]?.[2]).toBe(2);
    expect(String(evals[0]?.[4])).toMatch(/^ai:v1:budget:groq:\d{8}$/);
  });
});

describe("failure is a refusal, never permission", () => {
  it("a Redis outage makes reserve throw", async () => {
    const clock = makeClock(NOW);
    const redis = new FakeRedis(clock.now);
    redis.down = "network";
    await expect(new RedisProviderBudget({ client: redis, limits: limits(5), now: clock.now }).reserve("gemini")).rejects.toBeDefined();
  });

  it("a malformed reply makes reserve throw", async () => {
    const bad = { command: () => Promise.resolve([1, 0, "x", 2]) };
    await expect(new RedisProviderBudget({ client: bad, limits: limits(5) }).reserve("gemini")).rejects.toBeDefined();
    const short = { command: () => Promise.resolve([1]) };
    await expect(new RedisProviderBudget({ client: short, limits: limits(5) }).reserve("gemini")).rejects.toBeDefined();
  });
});
