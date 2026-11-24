import { describe, expect, it } from "vitest";

import { aiCacheKey, createAiCache } from "@/lib/ai/cache";
import { AI_REASON_MESSAGES, PROMPT_VERSION, buildGroundingContext, isFailoverEligible, type AiEnvelope, type AiExplanation, type AiReasonCode } from "@/lib/ai";
import { PROFILE_IDS } from "@/lib/engine/types";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";
import { FAKE_API_KEY, buildService, compliantExplanation, degradedGate, limitedGate, modelText, providerTarget, readyConfig, resultFor } from "../../fixtures/ai";
import { MORNING_DIP, NOW, snapshot, stale, unavailable } from "../../fixtures/engine";
import { MemoryProviderBudget, RedisProviderBudget } from "@/lib/ai/providerBudget";

/** Both providers are fakes returning SYNTHETIC text written by these tests. No network, no quota. */

const BOTH = readyConfig({}, "gem-model", ["gemini", "groq"]);
const request = () => new Request("http://localhost/api/recommend", { method: "POST" });
const input = (profile = "senior_respiratory" as (typeof PROFILE_IDS)[number], air = snapshot(MORNING_DIP)) => ({ request: request(), ...resultFor(profile, air) });
const good = (result = resultFor().result) => () => Promise.resolve(modelText(compliantExplanation(result)));
const http = (status: number) => () => Promise.reject(Object.assign(new Error("RAW provider text"), { name: "ApiError", status }));
const text = (t: string) => () => Promise.resolve({ text: t, finishReason: "STOP", blockReason: null });
const providersTried = (e: AiEnvelope) => (e.attempts ?? []).map((a) => `${a.provider}:${a.reasonCode}`);

describe("provider priority", () => {
  it("Gemini success means Groq is never called", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: good(i.result), respondGroq: http(500) });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "generated", provider: "gemini", model: "gem-model" });
    expect(env.attempts).toBeUndefined();
    expect(h.groqTransport.requests).toHaveLength(0);
  });

  it.each([
    ["503 overload", http(503), "AI_UPSTREAM_ERROR"],
    ["429 rate limit", http(429), "AI_QUOTA"],
    ["timeout", () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), "AI_TIMEOUT"],
    ["network failure", () => Promise.reject(new TypeError("fetch failed")), "AI_NETWORK"],
    ["401 key refused", http(401), "AI_AUTH_FAILED"],
    ["404 model gone", http(404), "AI_MODEL_UNAVAILABLE"],
    ["malformed JSON", text("{oops"), "AI_INVALID_JSON"],
    ["schema failure", text('{"overview":"x"}'), "AI_SCHEMA_INVALID"],
    ["empty answer", text(""), "AI_EMPTY_RESPONSE"],
    ["truncated answer", () => Promise.resolve({ text: "{", finishReason: "MAX_TOKENS", blockReason: null }), "AI_TRUNCATED"],
  ])("a Gemini %s sends the request to Groq", async (_name, geminiBehaviour, code) => {
    const i = input();
    const h = buildService({ config: BOTH, respond: geminiBehaviour, respondGroq: good(i.result) });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "generated", provider: "groq", model: "test-groq-model", reasonCode: null });
    expect(providersTried(env)).toEqual([`gemini:${code}`]);
    expect(env.explanation).toEqual(compliantExplanation(i.result));
    expect(h.transport.requests).toHaveLength(1);
    expect(h.groqTransport.requests).toHaveLength(1);
  });

  it("output that fails validation (an invented figure) is recoverable: Groq is asked, and its output is validated the same way", async () => {
    const i = input();
    const invented: AiExplanation = { ...compliantExplanation(i.result), overview: "The AQI is 612 today." };
    const h = buildService({ config: BOTH, respond: good(i.result), respondGroq: good(i.result) });
    h.transport.respond = () => Promise.resolve(modelText(invented));
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "generated", provider: "groq" });
    expect(providersTried(env)).toEqual(["gemini:AI_VALIDATION_REJECTED"]);
    expect(h.metrics.snapshot()).toMatchObject({ ai_provider_fallback: 1, gemini_validation_rejection: 1 });
  });

  it("Groq output is held to the same validator: a hostile Groq answer is discarded, not shown", async () => {
    const i = input();
    const hostile: AiExplanation = { ...compliantExplanation(i.result), overview: "This is perfectly safe and guaranteed to protect your lungs." };
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: () => Promise.resolve(modelText(hostile)) });
    const env = await h.service.explain(i);
    expect(env.status).toBe("fallback");
    expect(env.provider).toBe("deterministic");
    expect(env.reasonCode).toBe("AI_VALIDATION_REJECTED");
    expect(providersTried(env)).toEqual(["gemini:AI_UPSTREAM_ERROR", "groq:AI_VALIDATION_REJECTED"]);
    expect(JSON.stringify(env)).not.toContain("guaranteed");
  });

  it("both providers failing returns the deterministic fallback, with each sanitized reason", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: http(429) });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "fallback", provider: "deterministic", reasonCode: "AI_QUOTA", model: null });
    expect(env.message).toBe(AI_REASON_MESSAGES.AI_QUOTA);
    expect(providersTried(env)).toEqual(["gemini:AI_UPSTREAM_ERROR", "groq:AI_QUOTA"]);
    expect(env.explanation).toEqual(compliantExplanation(i.result));
    expect(JSON.stringify(env)).not.toContain("RAW provider text");
  });

  it("each provider is called at most once per request: no retry loops", async () => {
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: http(503) });
    await h.service.explain(input());
    expect(h.transport.requests).toHaveLength(1);
    expect(h.groqTransport.requests).toHaveLength(1);
  });

  it("a missing Gemini key leaves Groq working, and Gemini is never called", async () => {
    const i = input();
    const h = buildService({ config: readyConfig({}, "m", ["groq"]), respond: http(500), respondGroq: good(i.result) });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "generated", provider: "groq" });
    expect(h.transport.requests).toHaveLength(0);
  });

  it("a missing Groq key leaves Gemini working, and a Gemini failure goes straight to the fallback", async () => {
    const i = input();
    const ok = buildService({ config: readyConfig({}, "m", ["gemini"]), respond: good(i.result), respondGroq: http(500) });
    expect((await ok.service.explain(i)).provider).toBe("gemini");
    const down = buildService({ config: readyConfig({}, "m", ["gemini"]), respond: http(503), respondGroq: good(i.result) });
    const env = await down.service.explain(i);
    expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_UPSTREAM_ERROR" });
    expect(down.groqTransport.requests).toHaveLength(0);
  });

  it("neither provider configured: deterministic fallback, no call", async () => {
    const h = buildService({ config: { status: "unavailable", reason: "AI_NOT_CONFIGURED" }, respond: http(500), respondGroq: http(500) });
    const env = await h.service.explain(input());
    expect(env).toMatchObject({ status: "fallback", provider: "deterministic", reasonCode: "AI_NOT_CONFIGURED" });
    expect(h.transport.requests.length + h.groqTransport.requests.length).toBe(0);
  });

  it("follows the configured order: Groq first when configured first", async () => {
    const i = input();
    const config = readyConfig({}, "m", ["gemini", "groq"]);
    const swapped = { ...config, providers: [...config.providers].reverse() };
    const h = buildService({ config: swapped, respond: good(i.result), respondGroq: good(i.result) });
    expect((await h.service.explain(i)).provider).toBe("groq");
    expect(h.transport.requests).toHaveLength(0);
  });
});

describe("failures that must NOT reach the second provider", () => {
  const stopsAt = async (behaviour: () => Promise<{ text: string | null; finishReason: string | null; blockReason: string | null }>, code: AiReasonCode) => {
    const i = input();
    const h = buildService({ config: BOTH, respond: behaviour, respondGroq: good(i.result) });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "fallback", reasonCode: code, provider: "deterministic" });
    expect(h.groqTransport.requests).toHaveLength(0);
  };

  it("a safety refusal is a decision, not an outage", async () => {
    await stopsAt(() => Promise.resolve({ text: null, finishReason: "SAFETY", blockReason: null }), "AI_SAFETY_BLOCKED");
    await stopsAt(() => Promise.resolve({ text: null, finishReason: null, blockReason: "PROHIBITED_CONTENT" }), "AI_SAFETY_BLOCKED");
  });

  it("a bad request is our bug: resending it elsewhere would repeat it", async () => {
    await stopsAt(http(400), "AI_BAD_REQUEST");
  });

  it("the eligibility table is explicit", () => {
    const eligible: AiReasonCode[] = ["AI_TIMEOUT", "AI_QUOTA", "AI_UPSTREAM_ERROR", "AI_NETWORK", "AI_MODEL_UNAVAILABLE", "AI_AUTH_FAILED", "AI_EMPTY_RESPONSE", "AI_TRUNCATED", "AI_INVALID_JSON", "AI_SCHEMA_INVALID", "AI_VALIDATION_REJECTED"];
    const never: AiReasonCode[] = ["AI_SAFETY_BLOCKED", "AI_BAD_REQUEST", "AI_INTERNAL", "AI_DISABLED", "AI_NOT_CONFIGURED", "AI_INVALID_CONFIG", "AI_AIR_DATA_UNAVAILABLE", "AI_INPUT_TOO_LARGE", "AI_RATE_LIMITED", "AI_PROTECTION_UNAVAILABLE", "AI_BUDGET_EXHAUSTED"];
    for (const c of eligible) expect(isFailoverEligible(c), c).toBe(true);
    for (const c of never) expect(isFailoverEligible(c), c).toBe(false);
  });
});

describe("the deterministic result never changes", () => {
  it.each(PROFILE_IDS)("%s: byte-identical whichever provider answers, however hostile", async (profile) => {
    const i = input(profile);
    const before = JSON.stringify(i.result);
    const airBefore = JSON.stringify(i.air);
    const hostile = JSON.stringify({ overview: "AQI is 1.", aqi: 1, result: { aqiContext: { aqi: 1 } }, topActions: [{ recommendationId: "ROUTINE_fake-1", explanation: "x", practicalGuidance: "y" }] });
    for (const [gemini, groq] of [[good(i.result), good(i.result)], [http(503), good(i.result)], [text(hostile), text(hostile)], [http(503), http(503)]] as const) {
      const h = buildService({ config: BOTH, respond: gemini, respondGroq: groq });
      await h.service.explain(i);
      expect(JSON.stringify(i.result)).toBe(before);
      expect(JSON.stringify(i.air)).toBe(airBefore);
    }
  });

  it("fresh, stale and unavailable air-data states all work through the chain", async () => {
    for (const air of [snapshot(MORNING_DIP), stale(snapshot(MORNING_DIP)), unavailable()]) {
      const i = input("senior_respiratory", air);
      const h = buildService({ config: BOTH, respond: http(503), respondGroq: good(i.result) });
      const env = await h.service.explain(i);
      if (i.result.status === "ok") expect(env.provider).toBe("groq");
      else expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_AIR_DATA_UNAVAILABLE" });
    }
  });
});

describe("budgets across providers", () => {
  it("switching provider cannot bypass the global budget", async () => {
    const budget = new MemoryProviderBudget({ global: 1, providers: { gemini: 10, groq: 10 } }, () => NOW);
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: good(i.result), budget });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_BUDGET_EXHAUSTED" });
    expect(env.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.groqTransport.requests).toHaveLength(0);
    expect(providersTried(env)).toEqual(["gemini:AI_UPSTREAM_ERROR"]);
  });

  it("a full Gemini cap skips Gemini (no call) and uses Groq", async () => {
    const budget = new MemoryProviderBudget({ global: 10, providers: { gemini: 0, groq: 10 } }, () => NOW);
    const i = input();
    const h = buildService({ config: BOTH, respond: good(i.result), respondGroq: good(i.result), budget });
    const env = await h.service.explain(i);
    expect(env).toMatchObject({ status: "generated", provider: "groq" });
    expect(providersTried(env)).toEqual(["gemini:AI_BUDGET_EXHAUSTED"]);
    expect(h.transport.requests).toHaveLength(0);
    expect(h.metrics.snapshot().ai_budget_rejection).toBe(1);
  });

  it("a full Groq cap leaves Gemini working and does not charge Groq", async () => {
    const budget = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 0 } }, () => NOW);
    const i = input();
    const h = buildService({ config: BOTH, respond: good(i.result), respondGroq: good(i.result), budget });
    expect((await h.service.explain(i)).provider).toBe("gemini");
    expect((await budget.reserve("groq")).deniedBy).toBe("provider");
  });

  it("every provider cap full: fallback with the reset time, and no call", async () => {
    const budget = new MemoryProviderBudget({ global: 10, providers: { gemini: 0, groq: 0 } }, () => NOW);
    const h = buildService({ config: BOTH, respond: good(), respondGroq: good(), budget });
    const env = await h.service.explain(input());
    expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_BUDGET_EXHAUSTED" });
    expect(env.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.transport.requests.length + h.groqTransport.requests.length).toBe(0);
  });

  it("a failover spends one global unit per CALL, so a failing primary cannot double spend unnoticed", async () => {
    const budget = new MemoryProviderBudget({ global: 5, providers: { gemini: 5, groq: 5 } }, () => NOW);
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: good(i.result), budget });
    await h.service.explain(i);
    expect(await budget.reserve("gemini")).toMatchObject({ usedGlobal: 3, usedProvider: 2 });
  });

  it("a Redis outage means no provider is called", async () => {
    const clock = makeClock(NOW);
    const redis = new FakeRedis(clock.now);
    redis.down = "network";
    const budget = new RedisProviderBudget({ client: redis, limits: { global: 5, providers: { gemini: 5, groq: 5 } }, now: clock.now });
    const h = buildService({ config: BOTH, respond: good(), respondGroq: good(), budget });
    const env = await h.service.explain(input());
    expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_PROTECTION_UNAVAILABLE" });
    expect(h.transport.requests.length + h.groqTransport.requests.length).toBe(0);
  });

  it("a cache hit and a deterministic fallback reserve nothing", async () => {
    const i = input();
    const budget = new MemoryProviderBudget({ global: 2, providers: { gemini: 2, groq: 2 } }, () => NOW);
    const h = buildService({ config: BOTH, respond: good(i.result), respondGroq: good(i.result), budget });
    await h.service.explain(i); // generated: 1 unit
    for (let n = 0; n < 5; n += 1) expect((await h.service.explain(i)).status).toBe("cached");
    const cold = buildService({ config: BOTH, respond: good(), respondGroq: good(), budget, gate: limitedGate() });
    expect((await cold.service.explain(input("family_toddlers"))).reasonCode).toBe("AI_RATE_LIMITED");
    const off = buildService({ config: { status: "unavailable", reason: "AI_DISABLED" }, budget });
    await off.service.explain(i);
    expect(await budget.reserve("gemini")).toMatchObject({ allowed: true, usedGlobal: 2, usedProvider: 2 });
  });

  it("the per-client limit is decided once per request, before any provider, and applies to the whole chain", async () => {
    let decisions = 0;
    const gate = () => {
      decisions += 1;
      return Promise.resolve({ kind: "allow" as const, allowUpstream: true as const, result: { allowed: true, limit: 5, remaining: 4, resetSeconds: 60 } });
    };
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: good(i.result), gate });
    await h.service.explain(i);
    expect(decisions).toBe(1);
    const limited = buildService({ config: BOTH, respond: good(), respondGroq: good(), gate: limitedGate(30) });
    expect(await limited.service.explain(input())).toMatchObject({ reasonCode: "AI_RATE_LIMITED", retryAfterSeconds: 30 });
    const degraded = buildService({ config: BOTH, respond: good(), respondGroq: good(), gate: degradedGate });
    expect((await degraded.service.explain(input())).reasonCode).toBe("AI_PROTECTION_UNAVAILABLE");
    expect(limited.transport.requests.length + limited.groqTransport.requests.length + degraded.transport.requests.length).toBe(0);
  });
});

describe("cache across providers", () => {
  it("a Groq explanation is cached and reused as `cached` with provider groq, with no further call", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: good(i.result) });
    expect((await h.service.explain(i)).provider).toBe("groq");
    const again = await h.service.explain(i);
    expect(again).toMatchObject({ status: "cached", provider: "groq", model: "test-groq-model" });
    expect(h.transport.requests).toHaveLength(1);
    expect(h.groqTransport.requests).toHaveLength(1);
  });

  it("provider and model are part of the key", () => {
    const g = buildGroundingContext(...(Object.values(resultFor()) as [never, never]));
    const k = (provider: string, model: string) => aiCacheKey({ promptVersion: PROMPT_VERSION, provider, model, contextJson: g.json });
    expect(k("gemini", "m")).not.toBe(k("groq", "m"));
    expect(k("groq", "a")).not.toBe(k("groq", "b"));
    expect(k("groq", "a")).toBe(k("groq", "a"));
  });

  it("a different Groq model is a separate cache entry", async () => {
    const i = input();
    const cache = createAiCache({ ttlSeconds: 1800, now: () => NOW });
    const a = buildService({ config: readyConfig({}, "m", ["groq"]), respondGroq: good(i.result), cache });
    await a.service.explain(i);
    const otherModel = { ...readyConfig({}, "m", ["groq"]), providers: [providerTarget("groq", "another-model")] };
    const b = buildService({ config: otherModel, respondGroq: good(i.result), cache });
    expect((await b.service.explain(i)).status).toBe("generated");
  });

  it("failures and rejected output are never cached, so a failing provider cannot poison the entry", async () => {
    const i = input();
    const cache = createAiCache({ ttlSeconds: 1800, now: () => NOW });
    const bad = text(JSON.stringify({ ...compliantExplanation(i.result), overview: "The AQI is 612." }));
    const failing = buildService({ config: BOTH, respond: bad, respondGroq: http(500), cache });
    expect((await failing.service.explain(i)).status).toBe("fallback");
    const recovered = buildService({ config: BOTH, respond: good(i.result), respondGroq: http(500), cache });
    expect((await recovered.service.explain(i)).status).toBe("generated");
  });

  it("an invalid cached entry is discarded and regenerated", async () => {
    const i = input();
    const cache = createAiCache({ ttlSeconds: 1800, now: () => NOW });
    const g = buildGroundingContext(i.result, i.air);
    const key = aiCacheKey({ promptVersion: PROMPT_VERSION, provider: "gemini", model: "gem-model", contextJson: g.json });
    await cache.set(key, { ...compliantExplanation(i.result), overview: "The AQI is 612 and this is safe." });
    const h = buildService({ config: BOTH, respond: good(i.result), cache });
    const env = await h.service.explain(i);
    expect(env.status).toBe("generated");
    expect(JSON.stringify(env)).not.toContain("612");
  });

  it("identical concurrent requests share one provider chain and one budget unit", async () => {
    const i = input();
    const budget = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: () => new Promise((r) => setTimeout(() => r(modelText(compliantExplanation(i.result))), 5)), budget });
    const results = await Promise.all([1, 2, 3, 4].map(() => h.service.explain(i)));
    expect(results.every((r) => r.status === "generated" && r.provider === "groq")).toBe(true);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.groqTransport.requests).toHaveLength(1);
    expect(await budget.reserve("gemini")).toMatchObject({ usedGlobal: 3 });
  });
});

describe("token usage and observability", () => {
  const usage = { inputTokens: 4000, outputTokens: 700, totalTokens: 4700 };

  it("records provider-reported usage, latency and provider on the envelope and metrics", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: () => Promise.resolve({ ...modelText(compliantExplanation(i.result)), usage }) });
    const env = await h.service.explain(i);
    expect(env.tokenUsage).toEqual(usage);
    expect(h.metrics.snapshot()).toMatchObject({ ai_provider_request: 2, ai_provider_failure: 1, ai_provider_success: 1, ai_tokens_input: 4000, ai_tokens_output: 700, ai_tokens_total: 4700, ai_provider_fallback: 1, ai_cache_miss: 1 });
  });

  it("when a provider reports no usage it is recorded as unreported, never estimated", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: good(i.result) });
    const env = await h.service.explain(i);
    expect(env.tokenUsage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(h.metrics.snapshot()).toMatchObject({ ai_tokens_unreported: 1, ai_tokens_input: 0, ai_tokens_output: 0 });
  });

  it("counts cache hits and fallbacks", async () => {
    const i = input();
    const h = buildService({ config: BOTH, respond: good(i.result) });
    await h.service.explain(i);
    await h.service.explain(i);
    expect(h.metrics.snapshot()).toMatchObject({ ai_cache_hit: 1, ai_cache_miss: 1 });
    const f = buildService({ config: BOTH, respond: http(503), respondGroq: http(503) });
    await f.service.explain(i);
    expect(f.metrics.snapshot()).toMatchObject({ ai_fallback: 1, ai_provider_failure: 2 });
  });

  it("never logs prompts, context, explanation text, keys or raw provider errors", async () => {
    const i = input();
    const g = buildGroundingContext(i.result, i.air);
    const explanation = compliantExplanation(i.result);
    const h = buildService({ config: BOTH, respond: http(503), respondGroq: () => Promise.resolve({ ...modelText(explanation), usage }) });
    await h.service.explain(i);
    const failing = buildService({ config: BOTH, respond: http(503), respondGroq: http(429) });
    await failing.service.explain(i);
    const logged = [...h.logs, ...failing.logs].join("\n");
    expect(logged).not.toContain(FAKE_API_KEY);
    expect(logged).not.toContain("RAW provider text");
    expect(logged).not.toContain(g.json.slice(0, 80));
    expect(logged).not.toContain(explanation.overview);
  });

  it("sends the same bounded request to both providers: shared prompt, output cap and schema", async () => {
    const i = input();
    const h = buildService({ config: readyConfig({ maxOutputTokens: 1_500 }, "m", ["gemini", "groq"]), respond: http(503), respondGroq: good(i.result) });
    await h.service.explain(i);
    const [a, b] = [h.transport.requests[0]!, h.groqTransport.requests[0]!];
    expect(a.systemInstruction).toBe(b.systemInstruction);
    expect(a.userPrompt).toBe(b.userPrompt);
    expect(JSON.stringify(a.responseJsonSchema)).toBe(JSON.stringify(b.responseJsonSchema));
    expect([a.maxOutputTokens, b.maxOutputTokens]).toEqual([1_500, 1_500]);
    expect(b.thinkingBudget).toBeNull();
  });
});
