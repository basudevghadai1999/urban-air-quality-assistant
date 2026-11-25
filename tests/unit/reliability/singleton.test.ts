import { afterEach, describe, expect, it, vi } from "vitest";

import { getAiExplanationService, getChatService } from "@/lib/ai/defaultAiService";
import { getAirRateLimitGate, getAirService, getSharedInfrastructure } from "@/lib/data/defaultAirService";
import { InvalidEnvError, getAiSettings } from "@/lib/env";
import { processSingleton, resetProcessSingletons } from "@/lib/singleton";

/**
 * Process-wide singletons. They are per PROCESS only: nothing here (or in the code) claims one instance across
 * serverless or Render instances; shared state lives in Redis.
 */

afterEach(() => {
  resetProcessSingletons();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("processSingleton", () => {
  it("builds once, however many callers ask, including concurrent first requests", async () => {
    const create = vi.fn(() => ({ id: Math.random() }));
    const callers = Array.from({ length: 50 }, async () => {
      await Promise.resolve(); // each request arrives on its own tick
      return processSingleton("test-concurrent", create);
    });
    const instances = await Promise.all(callers);
    expect(create).toHaveBeenCalledTimes(1);
    expect(new Set(instances).size).toBe(1);
  });

  it("is shared by separate copies of the module (route bundles, hot reload)", async () => {
    const first = processSingleton("test-copies", () => ({ n: 1 }));
    vi.resetModules();
    const copy = await import("@/lib/singleton");
    expect(copy.processSingleton).not.toBe(processSingleton);
    expect(copy.processSingleton("test-copies", () => ({ n: 2 }))).toBe(first);
  });

  it("stores nothing when creation throws, so the next call recovers", () => {
    let broken = true;
    const create = vi.fn(() => {
      if (broken) throw new Error("bad configuration");
      return { ok: true };
    });
    expect(() => processSingleton("test-recover", create)).toThrow("bad configuration");
    expect(() => processSingleton("test-recover", create)).toThrow("bad configuration"); // retried, not remembered
    broken = false;
    const recovered = processSingleton("test-recover", create);
    expect(recovered).toEqual({ ok: true });
    expect(processSingleton("test-recover", create)).toBe(recovered);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("keeps the first instance when creation re-enters the same singleton", () => {
    const outer = processSingleton("test-reentrant", () => {
      const inner = processSingleton("test-reentrant", () => ({ who: "inner" }));
      return { who: "outer", inner };
    });
    expect(outer).toMatchObject({ who: "inner" });
    expect(processSingleton("test-reentrant", () => ({ who: "never" }))).toBe(outer);
  });

  it("separates names", () => {
    expect(processSingleton("test-a", () => "a")).toBe("a");
    expect(processSingleton("test-b", () => "b")).toBe("b");
  });

  it("reset forgets ours and only ours", () => {
    const foreign = Symbol.for("some-other-library.cache");
    Reflect.set(globalThis, foreign, "keep");
    const before = processSingleton("test-reset", () => ({}));
    resetProcessSingletons();
    expect(processSingleton("test-reset", () => ({}))).not.toBe(before);
    expect(Reflect.get(globalThis, foreign)).toBe("keep");
    Reflect.deleteProperty(globalThis, foreign);
  });
});

describe("the default wiring", () => {
  const redisEnv = () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake-host-9999.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "FAKE-TOKEN-0123456789");
  };

  it("concurrent first requests share one infrastructure, one Redis client and one of each service", async () => {
    redisEnv();
    const [a, b, c] = await Promise.all([
      (async () => ({ infra: getSharedInfrastructure(), air: getAirService(), gate: getAirRateLimitGate(), ai: getAiExplanationService(), chat: getChatService() }))(),
      (async () => ({ infra: getSharedInfrastructure(), air: getAirService(), gate: getAirRateLimitGate(), ai: getAiExplanationService(), chat: getChatService() }))(),
      (async () => ({ infra: getSharedInfrastructure(), air: getAirService(), gate: getAirRateLimitGate(), ai: getAiExplanationService(), chat: getChatService() }))(),
    ]);
    expect(a.infra.client).not.toBeNull();
    for (const other of [b, c]) {
      expect(other.infra).toBe(a.infra);
      expect(other.infra.client).toBe(a.infra.client);
      expect(other.air).toBe(a.air);
      expect(other.gate).toBe(a.gate);
      expect(other.ai).toBe(a.ai);
      expect(other.chat).toBe(a.chat);
    }
  });

  it("the air and AI layers use the same Redis client and hashing secret", () => {
    const infra = getSharedInfrastructure();
    getAirService();
    getAiExplanationService();
    expect(getSharedInfrastructure()).toBe(infra);
    expect(typeof infra.ephemeralSecret).toBe("string");
  });

  it("an invalid air setting fails by name, stores nothing, and recovers once fixed", () => {
    vi.stubEnv("AIR_CACHE_TTL_SECONDS", "banana");
    expect(() => getAirService()).toThrow(InvalidEnvError);
    expect(() => getAirService()).toThrow(InvalidEnvError);
    vi.stubEnv("AIR_CACHE_TTL_SECONDS", "600");
    const service = getAirService();
    expect(getAirService()).toBe(service);
  });

  it("an invalid rate-limit setting fails the gate without caching a broken one", () => {
    vi.stubEnv("AIR_RATE_LIMIT_WINDOW_SECONDS", "-1");
    expect(() => getAirRateLimitGate()).toThrow(InvalidEnvError);
    vi.stubEnv("AIR_RATE_LIMIT_WINDOW_SECONDS", "60");
    expect(getAirRateLimitGate()).toBe(getAirRateLimitGate());
  });

  it("an invalid AI setting does not take the API down: the services still build, from the documented defaults", () => {
    vi.stubEnv("AI_REQUEST_TIMEOUT_MS", "banana");
    expect(() => getAiSettings()).toThrow(InvalidEnvError); // the setting really is invalid
    expect(() => getAiExplanationService()).not.toThrow();
    expect(() => getChatService()).not.toThrow();
  });

  it("reset gives each test a fresh instance (isolation)", () => {
    const first = getAirService();
    resetProcessSingletons();
    expect(getAirService()).not.toBe(first);
  });
});
