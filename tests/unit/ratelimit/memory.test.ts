import { describe, expect, it } from "vitest";

import { MemoryRateLimiter } from "@/lib/ratelimit";

import { makeClock } from "../../fixtures/fakeRedis";

const POLICY = { limit: 3, windowSeconds: 60 };

describe("MemoryRateLimiter", () => {
  it("allows requests below the limit, counting down", async () => {
    const limiter = new MemoryRateLimiter(POLICY, makeClock(0).now);
    const first = await limiter.check("a");
    expect(first).toEqual({ allowed: true, limit: 3, remaining: 2, resetSeconds: 60 });
    expect((await limiter.check("a")).remaining).toBe(1);
  });

  it("allows exactly `limit` requests, and rejects the next", async () => {
    const limiter = new MemoryRateLimiter(POLICY, makeClock(0).now);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.check("a"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[2]?.remaining).toBe(0);
    expect(results[3]?.remaining).toBe(0); // never negative
  });

  it("reports the time left in the window", async () => {
    const clock = makeClock(0);
    const limiter = new MemoryRateLimiter(POLICY, clock.now);
    await limiter.check("a");
    clock.advance(20_000);
    expect((await limiter.check("a")).resetSeconds).toBe(40);
    clock.advance(39_100);
    expect((await limiter.check("a")).resetSeconds).toBe(1); // never 0
  });

  it("resets after the window ends", async () => {
    const clock = makeClock(0);
    const limiter = new MemoryRateLimiter(POLICY, clock.now);
    for (let i = 0; i < 4; i += 1) await limiter.check("a");
    expect((await limiter.check("a")).allowed).toBe(false);
    clock.advance(59_999);
    expect((await limiter.check("a")).allowed).toBe(false);
    clock.advance(1);
    expect(await limiter.check("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("does not extend the window when a client keeps retrying while blocked", async () => {
    const clock = makeClock(0);
    const limiter = new MemoryRateLimiter(POLICY, clock.now);
    for (let i = 0; i < 3; i += 1) await limiter.check("a");
    for (let t = 0; t < 59; t += 1) {
      clock.advance(1_000);
      expect((await limiter.check("a")).allowed).toBe(false);
    }
    clock.advance(1_000); // exactly 60 s after the first request
    expect((await limiter.check("a")).allowed).toBe(true);
  });

  it("counts clients independently", async () => {
    const limiter = new MemoryRateLimiter(POLICY, makeClock(0).now);
    for (let i = 0; i < 4; i += 1) await limiter.check("a");
    expect((await limiter.check("a")).allowed).toBe(false);
    expect((await limiter.check("b")).allowed).toBe(true);
  });

  it("bounds its memory by dropping expired windows, then the oldest", async () => {
    const clock = makeClock(0);
    const limiter = new MemoryRateLimiter(POLICY, clock.now, 5);
    for (let i = 0; i < 20; i += 1) await limiter.check(`client${i}`);
    expect(limiter.size).toBeLessThanOrEqual(5);
    clock.advance(61_000);
    for (let i = 0; i < 3; i += 1) await limiter.check(`late${i}`);
    expect(limiter.size).toBeLessThanOrEqual(5);
  });
});
