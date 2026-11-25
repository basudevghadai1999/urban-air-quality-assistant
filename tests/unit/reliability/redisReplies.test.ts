import { describe, expect, it, vi } from "vitest";

import { createAiCache, aiCacheKey } from "@/lib/ai/cache";
import { PROMPT_VERSION, buildGroundingContext, type AiExplanation } from "@/lib/ai";
import { RedisProviderBudget } from "@/lib/ai/providerBudget";
import { validateExplanation } from "@/lib/ai/validator";
import { DEFAULT_CACHE_KEY_PREFIX, UpstashCache } from "@/lib/cache/upstash";
import { MemoryCache, TieredCache } from "@/lib/cache";
import { createAirMetrics } from "@/lib/observability/metrics";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";
import { createUpstashRestClient, expectDeleted, expectOk, expectTuple, isCounter, isRecord, type RedisCommandClient, type RedisFetch } from "@/lib/redis";
import { RedisError } from "@/lib/redis/errors";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { compliantExplanation, resultFor } from "../../fixtures/ai";
import { FETCHED_AT_MS } from "../../fixtures/openMeteo";
import { makeSnapshot } from "../../fixtures/snapshot";

/**
 * A malformed Redis answer is refused, never repaired: it must not become a counter, a cache hit or a
 * successful reservation. Replies below have the shapes a real Upstash REST database sends (`{"result": ...}`),
 * with one thing wrong each.
 */

const stub = (reply: unknown): RedisCommandClient => ({ command: () => Promise.resolve(reply) });
const protocolError = { kind: "protocol" };

describe("reply helpers", () => {
  it.each([[0, true], [1, true], [Number.MAX_SAFE_INTEGER, true], [-1, false], [1.5, false], [2 ** 53, false], [1e21, false], [Number.NaN, false], [Infinity, false], ["1", false], [null, false], [true, false], [undefined, false]])(
    "isCounter(%j) is %s",
    (value, expected) => expect(isCounter(value)).toBe(expected),
  );

  it.each([[{}, true], [{ a: 1 }, true], [[], false], [null, false], ["x", false], [1, false]])("isRecord(%j) is %s", (value, expected) => expect(isRecord(value)).toBe(expected));

  it("expectTuple requires an array of exactly the length", () => {
    expect(expectTuple([1, 2], 2)).toEqual([1, 2]);
    for (const bad of [[1], [1, 2, 3], "ab", null, { 0: 1, 1: 2, length: 2 }, undefined]) expect(() => expectTuple(bad, 2)).toThrow(RedisError);
  });

  it("expectOk accepts only the string OK", () => {
    expect(() => expectOk("OK")).not.toThrow();
    for (const bad of [null, "ok", "QUEUED", 1, true, ["OK"], undefined]) expect(() => expectOk(bad)).toThrow(RedisError);
  });

  it("expectDeleted accepts only 0 or 1", () => {
    for (const good of [0, 1]) expect(() => expectDeleted(good)).not.toThrow();
    for (const bad of [2, -1, "1", null, true, [1], undefined]) expect(() => expectDeleted(bad)).toThrow(RedisError);
  });
});

describe("rate-limit script reply", () => {
  const limiter = (client: RedisCommandClient) => new RedisRateLimiter({ client, policy: { limit: 30, windowSeconds: 60 } });

  it.each([
    ["an exact integer count too large to trust", [2 ** 53, 1000]],
    ["a count past the safe range", [1e21, 1000]],
    ["a negative count", [-1, 1000]],
    ["a boolean count", [true, 1000]],
    ["a numeric string count", ["1", 1000]],
    ["a null count", [null, 1000]],
    ["a null ttl", [1, null]],
    ["a boolean ttl", [1, true]],
    ["three elements", [1, 1000, 5]],
    ["an object", { count: 1, ttl: 1000 }],
    ["a nested array", [[1], [1000]]],
    ["undefined", undefined],
  ])("rejects %s, and never answers allowed", async (_label, reply) => {
    await expect(limiter(stub(reply)).check("c:abc")).rejects.toMatchObject(protocolError);
  });

  it("a huge but unsafe count is refused rather than treated as 'over the limit' or 'under it'", async () => {
    await expect(limiter(stub([Number.MAX_VALUE, 1000])).check("c:abc")).rejects.toBeInstanceOf(RedisError);
  });

  it("accepts the reply a real Upstash database sends for the script", async () => {
    const reply = await createUpstashRestClient({ url: "https://fake-host-9999.upstash.io", token: "FAKE-TOKEN" }, { fetchImpl: () => Promise.resolve(Response.json({ result: [3, 58_421] })) }).command(["EVAL"]);
    expect(await limiter(stub(reply)).check("c:abc")).toEqual({ allowed: true, limit: 30, remaining: 27, resetSeconds: 59 });
  });
});

describe("provider budget script reply", () => {
  const budget = (reply: unknown) => new RedisProviderBudget({ client: stub(reply), limits: { global: 10, providers: { gemini: 6, groq: 4 } } });

  it.each([
    ["a refusal with no reason {0, 0, g, p}", [0, 0, 3, 1]],
    ["a grant that names a denial {1, 1, g, p}", [1, 1, 3, 1]],
    ["a grant that names a provider denial {1, 2, g, p}", [1, 2, 3, 1]],
    ["a denial code outside 0-2", [0, 3, 3, 1]],
    ["a grant over the global cap", [1, 0, 11, 1]],
    ["a grant over the provider cap", [1, 0, 8, 7]],
    ["a grant that counted nothing", [1, 0, 0, 0]],
    ["a grant counting no provider call", [1, 0, 1, 0]],
    ["a negative counter", [0, 1, -1, 0]],
    ["an unsafe counter", [0, 1, 2 ** 53, 0]],
    ["a fractional counter", [0, 1, 10, 2.5]],
    ["a string counter", [0, 1, "10", 2]],
    ["a null counter", [0, 1, null, 2]],
    ["booleans for the flags", [true, 0, 1, 1]],
    ["a flag of 2", [2, 0, 1, 1]],
    ["three elements", [1, 0, 1]],
    ["five elements", [1, 0, 1, 1, 1]],
    ["null", null],
    ["an object", { allowed: 1 }],
  ])("rejects %s, so no provider is called", async (_label, reply) => {
    await expect(budget(reply).reserve("gemini")).rejects.toMatchObject(protocolError);
  });

  it("accepts exactly the script's grant and refusal shapes", async () => {
    expect(await budget([1, 0, 10, 6]).reserve("gemini")).toMatchObject({ allowed: true, deniedBy: null, usedGlobal: 10, usedProvider: 6 });
    expect(await budget([0, 1, 10, 3]).reserve("gemini")).toMatchObject({ allowed: false, deniedBy: "global" });
    expect(await budget([0, 2, 5, 6]).reserve("gemini")).toMatchObject({ allowed: false, deniedBy: "provider" });
  });
});

describe("cache entries and write acknowledgements", () => {
  const setup = () => {
    const clock = makeClock(FETCHED_AT_MS);
    const redis = new FakeRedis(clock.now);
    const counts: string[] = [];
    const cache = new UpstashCache({ client: redis, retentionSeconds: 86_400, now: clock.now, logger: { warn: vi.fn() }, metrics: createAirMetrics((l) => counts.push(l)) });
    return { redis, cache, counts, clock };
  };
  const KEY = `${DEFAULT_CACHE_KEY_PREFIX}delhi-ncr`;

  it.each([
    ["a number", 42],
    ["an array", ["a"]],
    ["an object", { v: 1 }],
    ["a boolean", true],
  ])("a GET answering %s is a miss, never a hit, and is counted", async (_label, reply) => {
    const counts: string[] = [];
    const cache = new UpstashCache({ client: stub(reply), retentionSeconds: 60, metrics: createAirMetrics((l) => counts.push(l)) });
    expect(await cache.get("delhi-ncr")).toBeNull();
    expect(counts.join("\n")).toContain("cache_entry_corrupt");
  });

  it.each(["", "null", "[]", "42", '"text"', "{}", '{"v":1}', '{"v":2,"storedAtMs":1,"value":{}}', "{broken"])("corrupt stored text %j is a miss and is deleted", async (text) => {
    const { redis, cache } = setup();
    redis.plant(KEY, text);
    expect(await cache.get("delhi-ncr")).toBeNull();
    expect(redis.peek(KEY)).toBeNull();
  });

  it("an oversized stored value is discarded without being parsed", async () => {
    const { redis, cache } = setup();
    redis.plant(KEY, "x".repeat(512 * 1024 + 1));
    expect(await cache.get("delhi-ncr")).toBeNull();
    expect(redis.peek(KEY)).toBeNull();
  });

  it("a valid entry is still a hit (the checks do not reject real data)", async () => {
    const { cache } = setup();
    const value = makeSnapshot("delhi-ncr");
    await cache.set("delhi-ncr", { value, storedAtMs: FETCHED_AT_MS });
    expect(await cache.get("delhi-ncr")).toEqual({ value, storedAtMs: FETCHED_AT_MS });
  });

  it.each([null, 0, 1, "QUEUED", ["OK"], true])("a SET answered with %j did not store: it throws, never reports success", async (reply) => {
    const cache = new UpstashCache({ client: stub(reply), retentionSeconds: 60 });
    await expect(cache.set("delhi-ncr", { value: makeSnapshot("delhi-ncr"), storedAtMs: FETCHED_AT_MS })).rejects.toMatchObject(protocolError);
  });

  it.each([null, 2, "1", true])("a DEL answered with %j throws", async (reply) => {
    await expect(new UpstashCache({ client: stub(reply), retentionSeconds: 60 }).delete("delhi-ncr")).rejects.toMatchObject(protocolError);
  });

  it("a bad SET acknowledgement marks persistence unavailable instead of claiming durability", async () => {
    const cache = new TieredCache({
      memory: new MemoryCache(),
      durable: new UpstashCache({ client: stub(null), retentionSeconds: 60 }),
      freshWithinMs: 900_000,
      now: () => FETCHED_AT_MS,
    });
    expect(cache.capability()).toBe("persistent");
    const entry = { value: makeSnapshot("delhi-ncr"), storedAtMs: FETCHED_AT_MS };
    await cache.set("delhi-ncr", entry); // never throws for a durable problem
    expect(cache.capability()).toBe("persistent-unavailable");
    expect(await cache.get("delhi-ncr")).toEqual(entry); // still served from memory
  });
});

describe("AI explanation cache", () => {
  const { result, air } = resultFor("senior_respiratory");
  const grounding = buildGroundingContext(result, air);
  const explanation = compliantExplanation(result);
  const accept = (candidate: unknown): AiExplanation | null => {
    const outcome = validateExplanation(candidate, { allowedIds: grounding.allowedIds, contextJson: grounding.json });
    return outcome.ok ? outcome.value : null;
  };
  const key = aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "m1", contextJson: grounding.json });
  const build = (redis: FakeRedis, metrics = createAirMetrics(() => undefined)) => createAiCache({ ttlSeconds: 60, client: redis, now: redis.now, metrics });

  it.each(["null", "[]", "42", '"text"', "{}", '{"v":1}', '{"v":2,"explanation":{}}', '{"explanation":{}}', "{broken"])("stored %j is a miss and is deleted", async (text) => {
    const redis = new FakeRedis(makeClock(FETCHED_AT_MS).now);
    redis.plant(key, text);
    expect(await build(redis).get(key, accept)).toBeNull();
    expect(redis.peek(key)).toBeNull();
  });

  it.each([42, ["a"], { v: 1 }, true])("a GET answering %j is a miss", async (reply) => {
    const cache = createAiCache({ ttlSeconds: 60, client: stub(reply) });
    expect(await cache.get(key, accept)).toBeNull();
  });

  it("a SET that is not acknowledged is counted as a Redis failure, and the value still serves from memory", async () => {
    const counts: string[] = [];
    const cache = createAiCache({ ttlSeconds: 60, client: stub(null), metrics: createAirMetrics((l) => counts.push(l)) });
    await cache.set(key, explanation);
    expect(counts.join("\n")).toMatch(/redis_failure[\s\S]*protocol/);
    expect(await cache.get(key, accept)).toEqual(explanation);
  });

  it("a valid entry round-trips through Redis", async () => {
    const redis = new FakeRedis(makeClock(FETCHED_AT_MS).now);
    await build(redis).set(key, explanation);
    expect(await build(redis).get(key, accept)).toEqual(explanation);
  });
});

describe("HTTP envelope from the Upstash REST endpoint", () => {
  const CONFIG = { url: "https://fake-host-9999.upstash.io", token: "FAKE-TOKEN-0123456789" };
  const run = (fetchImpl: RedisFetch) => createUpstashRestClient(CONFIG, { fetchImpl }).command(["GET", "k"]);
  const text = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));

  it.each([
    ["an error member that is not a string", '{"error":{"message":"x"}}'],
    ["a null error beside a result", '{"result":"OK","error":null}'],
    ["an array body", '[{"result":1}]'],
    ["a bare string", '"OK"'],
    ["a number", "1"],
    ["an empty object", "{}"],
    ["a truncated body", '{"result":"OK'],
    ["trailing garbage", '{"result":1}{"result":2}'],
    ["whitespace only", "  "],
  ])("rejects %s as a protocol error", async (_label, body) => {
    await expect(run(text(body))).rejects.toMatchObject(protocolError);
  });

  it("a string error beside a result is a failed command: the result is never returned", async () => {
    await expect(run(text('{"result":1,"error":"ERR boom"}'))).rejects.toMatchObject({ kind: "command" });
  });

  it("a 2xx with an empty body (204) is a protocol error", async () => {
    await expect(run(() => Promise.resolve(new Response(null, { status: 204 })))).rejects.toMatchObject(protocolError);
  });

  it.each([
    [500, "http"],
    [502, "http"],
    [503, "http"],
    [429, "http"],
    [401, "auth"],
  ])("HTTP %i with an HTML body is %s, whatever the body says", async (status, kind) => {
    await expect(run(text("<html>gateway error</html>", status))).rejects.toMatchObject({ kind, status });
    await expect(run(text('{"result":"OK"}', status))).rejects.toMatchObject({ kind, status });
  });

  it("an error status with a valid-looking result is never treated as success", async () => {
    await expect(run(text('{"result":[1,2]}', 500))).rejects.toBeInstanceOf(RedisError);
  });

  it("a timeout and a dropped connection are different kinds, and neither is a miss", async () => {
    await expect(run(() => Promise.reject(new DOMException("signal timed out", "TimeoutError")))).rejects.toMatchObject({ kind: "timeout" });
    await expect(run(() => Promise.reject(new DOMException("aborted", "AbortError")))).rejects.toMatchObject({ kind: "timeout" });
    await expect(run(() => Promise.reject(new TypeError("fetch failed")))).rejects.toMatchObject({ kind: "network" });
  });

  it("a body that stalls after the headers is a timeout", async () => {
    const stalled: RedisFetch = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    await expect(createUpstashRestClient(CONFIG, { fetchImpl: stalled, timeoutMs: 30 }).command(["GET", "k"])).rejects.toMatchObject({ kind: "timeout" });
  });

  it("large integers and null results are returned exactly as sent (callers decide what they mean)", async () => {
    expect(await run(text('{"result":null}'))).toBeNull();
    expect(await run(text('{"result":[1,59000]}'))).toEqual([1, 59_000]);
  });
});
