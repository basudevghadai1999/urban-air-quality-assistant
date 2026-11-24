import { describe, expect, it } from "vitest";

import { AI_CACHE_KEY_PREFIX, aiCacheKey, createAiCache } from "@/lib/ai/cache";
import { PROMPT_VERSION, buildGroundingContext, type AiExplanation } from "@/lib/ai";
import { validateExplanation } from "@/lib/ai/validator";
import { createAirMetrics } from "@/lib/observability/metrics";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { FAKE_API_KEY, compliantExplanation, resultFor } from "../../fixtures/ai";
import { CLEAN_FLAT, snapshot } from "../../fixtures/engine";

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const { result, air } = resultFor("senior_respiratory");
const g = buildGroundingContext(result, air);
const explanation = compliantExplanation(result);
const options = { allowedIds: g.allowedIds, contextJson: g.json };
const accept = (candidate: unknown): AiExplanation | null => {
  const o = validateExplanation(candidate, options);
  return o.ok ? o.value : null;
};
const key = aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "m1", contextJson: g.json });

describe("cache key", () => {
  it("is a prefixed SHA-256 hex digest", () => {
    expect(key).toMatch(/^ai:v1:expl:[0-9a-f]{64}$/);
    expect(key.startsWith(AI_CACHE_KEY_PREFIX)).toBe(true);
  });

  it("is stable for identical inputs", () => {
    expect(aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "m1", contextJson: g.json })).toBe(key);
  });

  it("changes with the model, the prompt version and any change in the deterministic context", () => {
    const other = (patch: Partial<{ promptVersion: string; provider: string; model: string; contextJson: string }>) =>
      aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "m1", contextJson: g.json, ...patch });
    expect(other({ model: "m2" })).not.toBe(key);
    expect(other({ provider: "groq" })).not.toBe(key);
    expect(other({ promptVersion: "9999-01-01.1" })).not.toBe(key);
    expect(other({ contextJson: `${g.json} ` })).not.toBe(key);
    const changed = resultFor("senior_respiratory", snapshot(CLEAN_FLAT));
    expect(other({ contextJson: buildGroundingContext(changed.result, changed.air).json })).not.toBe(key);
  });

  it("does not let a boundary shift collide (model/context are separated, not concatenated)", () => {
    const a = aiCacheKey({ promptVersion: "v", provider: "gemini", model: "ab", contextJson: "c" });
    const b = aiCacheKey({ promptVersion: "v", provider: "gemini", model: "a", contextJson: "bc" });
    expect(a).not.toBe(b);
  });

  it("contains no API key or readable context", () => {
    expect(key).not.toContain(FAKE_API_KEY);
    expect(key).not.toMatch(/delhi|aqi|senior/i);
  });
});

describe("memory cache", () => {
  it("stores and returns a validated explanation, and expires it after the TTL", async () => {
    const clock = makeClock(T0);
    const cache = createAiCache({ ttlSeconds: 60, now: clock.now });
    expect(await cache.get(key, accept)).toBeNull();
    await cache.set(key, explanation);
    expect(await cache.get(key, accept)).toEqual(explanation);
    clock.advance(59_000);
    expect(await cache.get(key, accept)).toEqual(explanation);
    clock.advance(2_000);
    expect(await cache.get(key, accept)).toBeNull();
  });

  it("re-validates on every read: an entry that is no longer acceptable is dropped, not served", async () => {
    const cache = createAiCache({ ttlSeconds: 60, now: () => T0 });
    await cache.set(key, explanation);
    expect(await cache.get(key, () => null)).toBeNull();
    expect(await cache.get(key, accept)).toBeNull();
  });

  it("ignores malformed keys entirely", async () => {
    const cache = createAiCache({ ttlSeconds: 60, now: () => T0 });
    await cache.set("not-a-key", explanation);
    expect(await cache.get("not-a-key", accept)).toBeNull();
    expect(await cache.get("ai:v1:expl:ZZ", accept)).toBeNull();
    expect(await cache.get("../../etc/passwd", accept)).toBeNull();
  });

  it("is bounded: the oldest entries are evicted", async () => {
    const cache = createAiCache({ ttlSeconds: 3600, now: () => T0 });
    const keys = Array.from({ length: 205 }, (_, i) => `${AI_CACHE_KEY_PREFIX}${i.toString(16).padStart(64, "0")}`);
    for (const k of keys) await cache.set(k, explanation);
    expect(await cache.get(keys[0] ?? "", accept)).toBeNull();
    expect(await cache.get(keys[204] ?? "", accept)).toEqual(explanation);
  });
});

describe("Redis cache", () => {
  const make = (redis: FakeRedis, clock = makeClock(T0), extra = {}) => createAiCache({ ttlSeconds: 120, client: redis, now: clock.now, ...extra });

  it("shares entries between instances through Redis, with the configured TTL", async () => {
    const clock = makeClock(T0);
    const redis = new FakeRedis(clock.now);
    await make(redis, clock).set(key, explanation);
    expect(redis.ttlSeconds(key)).toBe(120);
    const other = make(redis, clock); // a different serverless instance: empty memory
    expect(await other.get(key, accept)).toEqual(explanation);
    clock.advance(121_000);
    expect(await make(redis, clock).get(key, accept)).toBeNull();
  });

  it("uses only GET, SET and DEL, and stores a versioned, bounded envelope", async () => {
    const redis = new FakeRedis(() => T0);
    const cache = make(redis);
    await cache.set(key, explanation);
    await make(redis).get(key, accept);
    expect(new Set(redis.commands.map((c) => String(c[0])))).toEqual(new Set(["SET", "GET"]));
    const stored = JSON.parse(redis.peek(key) ?? "{}") as { v: number; storedAtMs: number; explanation: unknown };
    expect(stored.v).toBe(1);
    expect(stored.explanation).toEqual(explanation);
  });

  it("discards and deletes a corrupt entry, treating it as a miss", async () => {
    const redis = new FakeRedis(() => T0);
    redis.plant(key, "{not json");
    expect(await make(redis).get(key, accept)).toBeNull();
    expect(redis.peek(key)).toBeNull();
  });

  it.each([
    ["wrong version", JSON.stringify({ v: 2, explanation })],
    ["missing explanation", JSON.stringify({ v: 1 })],
    ["an array", "[]"],
    ["a poisoned explanation with a changed number", JSON.stringify({ v: 1, explanation: { ...explanation, overview: "The estimated AQI is 4242." } })],
    ["a poisoned explanation with a link", JSON.stringify({ v: 1, explanation: { ...explanation, overview: "See https://evil.example" } })],
    ["a poisoned explanation with an unknown recommendation", JSON.stringify({ v: 1, explanation: { ...explanation, topActions: [{ recommendationId: "NOPE", explanation: "x", practicalGuidance: "y" }] } })],
    ["an unknown field", JSON.stringify({ v: 1, explanation: { ...explanation, extra: 1 } })],
    ["an oversized payload", JSON.stringify({ v: 1, explanation, pad: "x".repeat(30_000) })],
  ])("never serves %s: re-validated, rejected and deleted", async (_name, payload) => {
    const redis = new FakeRedis(() => T0);
    redis.plant(key, payload);
    expect(await make(redis).get(key, accept)).toBeNull();
  });

  it("deletes a poisoned entry so it cannot be served later", async () => {
    const redis = new FakeRedis(() => T0);
    redis.plant(key, JSON.stringify({ v: 1, explanation: { ...explanation, overview: "AQI 4242 today." } }));
    await make(redis).get(key, accept);
    expect(redis.peek(key)).toBeNull();
  });

  it("a Redis outage costs only a miss: reads return null, writes still reach memory, and a metric is counted", async () => {
    const lines: string[] = [];
    const metrics = createAirMetrics((l) => lines.push(l), () => T0);
    const redis = new FakeRedis(() => T0);
    redis.down = "network";
    const cache = make(redis, makeClock(T0), { metrics });
    expect(await cache.get(key, accept)).toBeNull();
    await expect(cache.set(key, explanation)).resolves.toBeUndefined();
    expect(await cache.get(key, accept)).toEqual(explanation); // memory still serves it
    expect(metrics.snapshot().redis_failure).toBeGreaterThanOrEqual(2);
    expect(lines.join("")).not.toMatch(/ai:v1|token|http/i);
  });

  it("does not write an oversized explanation to Redis", async () => {
    const redis = new FakeRedis(() => T0);
    const huge = { ...explanation, overview: "x".repeat(30_000) } as AiExplanation;
    await make(redis).set(key, huge);
    expect(redis.peek(key)).toBeNull();
  });
});
