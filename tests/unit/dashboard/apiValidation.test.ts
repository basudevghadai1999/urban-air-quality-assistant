import { afterEach, describe, expect, it, vi } from "vitest";

import { CITY_IDS } from "@/config/cities";
import { fetchAir, fetchChat, fetchRecommendations } from "@/lib/client/dashboardApi";
import * as schemas from "@/lib/client/apiSchemas";
import { normalizedAirDataSchema } from "@/lib/cache/snapshotSchema";
import { PROFILE_IDS } from "@/lib/engine/types";

import { airFor, envelopeFor, recommendFor, staleAir, unavailableAir } from "../../fixtures/dashboard";

/**
 * What the browser does with response bodies it cannot trust. Payloads are built by the REAL mapper and engine,
 * then damaged one field at a time, so each case shows a specific rule rejecting a specific kind of damage.
 */

afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;

/** Answer every fetch with this status and raw body text (a fresh Response each time, as a real fetch gives). */
function respond(status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(text, { status }))));
}

type Json = Record<string, unknown>;
/** A deep copy with one nested value replaced, or removed when `value` is `undefined`. */
function damage<T>(source: T, path: readonly (string | number)[], value: unknown): T {
  const copy = structuredClone(source) as Json;
  let node: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy as T;
}

const air = airFor("delhi-ncr");
const result = recommendFor(air);
const chat = { status: "generated", answer: "Plan the walk for the morning.", reasonCode: null, message: "ok", provider: "groq", model: "m", promptVersion: "t" };
const okAir = (data: unknown) => ({ ok: true, data });
const okRec = (data: unknown, ai?: unknown) => ({ ok: true, data, ...(ai === undefined ? {} : { ai }) });

describe("valid payloads pass unchanged", () => {
  it.each(CITY_IDS)("a fresh reading for %s", async (cityId) => {
    const data = airFor(cityId);
    respond(200, okAir(data));
    const out = await fetchAir(cityId, signal());
    expect(out).toEqual({ ok: true, data });
  });

  it("a stale reading", async () => {
    const data = staleAir();
    respond(200, okAir(data));
    expect(await fetchAir("delhi-ncr", signal())).toEqual({ ok: true, data });
  });

  it.each(PROFILE_IDS)("a recommendation result for %s, with and without the nullable fields", async (profileId) => {
    for (const source of [airFor("mumbai"), staleAir("mumbai"), unavailableAir("mumbai")]) {
      const data = recommendFor(source, profileId);
      respond(200, okRec(data));
      const out = await fetchRecommendations("mumbai", profileId, false, signal());
      expect(out).toEqual({ ok: true, data: { result: data, ai: null } });
    }
  });

  it.each(["generated-gemini", "generated-groq", "cached-gemini", "fallback", "unavailable"] as const)("an AI envelope: %s", async (kind) => {
    const ai = envelopeFor(result, kind);
    respond(200, okRec(result, ai));
    const out = await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal());
    expect(out.ok && out.data.ai).toEqual(ai);
  });

  it("an AI envelope with attempts, token usage and a retry delay", async () => {
    const ai = envelopeFor(result, "fallback", "AI_BUDGET_EXHAUSTED", {
      attempts: [{ provider: "gemini", reasonCode: "AI_QUOTA" }],
      tokenUsage: { inputTokens: 10, outputTokens: null, totalTokens: null },
      retryAfterSeconds: 120,
    });
    respond(200, okRec(result, ai));
    expect((await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal())).ok).toBe(true);
  });

  it.each([
    chat,
    { ...chat, status: "fallback", reasonCode: "AI_RATE_LIMITED", provider: "deterministic", model: null, retryAfterSeconds: 30 },
    { ...chat, status: "unavailable", answer: null, reasonCode: "AI_INTERNAL", provider: "deterministic", model: null },
  ])("a chat envelope: %#", async (envelope) => {
    respond(200, { ok: true, chat: envelope });
    expect(await fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())).toEqual({ ok: true, chat: envelope });
  });

  it("fields a newer server adds are tolerated, and kept", async () => {
    respond(200, okAir({ ...air, addedLater: { a: 1 } }));
    const out = await fetchAir("delhi-ncr", signal());
    expect(out.ok).toBe(true);
    respond(200, okRec({ ...result, addedLater: true }));
    expect((await fetchRecommendations("delhi-ncr", "family_toddlers", false, signal())).ok).toBe(true);
  });
});

describe("malformed air payloads are rejected, never shown", () => {
  it.each([
    ["a missing required field", damage(air, ["cityName"], undefined)],
    ["a number where text belongs", damage(air, ["cityName"], 42)],
    ["a string where a number belongs", damage(air, ["ageSeconds"], "7")],
    ["an unknown city", damage(air, ["cityId"], "atlantis")],
    ["an unknown freshness status", damage(air, ["freshnessStatus"], "FRESH")],
    ["an unavailable status on a 200 reading", damage(air, ["freshnessStatus"], "unavailable")],
    ["a nested array that is not an array", damage(air, ["historicalHourlyData", "hours"], "none")],
    ["a nested element of the wrong type", damage(air, ["historicalHourlyData", "hours", 0, "epochSeconds"], "noon")],
    ["a cache status outside the set", damage(air, ["cache", "status"], "warm")],
    ["an AQI that is not the maximum sub-index", damage(air, ["calculatedAqi", "aqi"], 499)],
    ["a valid AQI with no category", damage(air, ["calculatedAqi", "category"], null)],
    ["an AQI above the scale", damage(air, ["calculatedAqi", "aqi"], 9_999)],
    ["null data", null],
    ["an empty object", {}],
    ["an array", [air]],
    ["a string", "air"],
  ])("%s", async (_name, data) => {
    respond(200, okAir(data));
    const out = await fetchAir("delhi-ncr", signal());
    expect(out).toMatchObject({ ok: false, data: null, failure: { kind: "server", cause: "invalid-response", retryAfterSeconds: null } });
  });

  it("an ok flag with no data, and an error envelope on a 200", async () => {
    for (const body of [{ ok: true }, { ok: false, error: { code: "INTERNAL_ERROR", message: "x" } }, { data: air }]) {
      respond(200, body);
      expect(await fetchAir("delhi-ncr", signal())).toMatchObject({ ok: false, failure: { cause: "invalid-response" } });
    }
  });
});

describe("malformed recommendation payloads are rejected", () => {
  it.each([
    ["a missing section", damage(result, ["routine"], undefined)],
    ["a missing nested section", damage(result, ["outdoorWindows", "periods"], undefined)],
    ["an unknown status", damage(result, ["status"], "maybe")],
    ["an unknown profile", damage(result, ["profileId"], "astronaut")],
    ["a wrong schema version", damage(result, ["schemaVersion"], 2)],
    ["an unknown priority tier", damage(result, ["prioritized", 0, "tier"], "urgent")],
    ["a score that is text", damage(result, ["prioritized", 0, "score"], "high")],
    ["steps that are not a list", damage(result, ["routine", "items", 0, "instructions"], "walk")],
    ["a confidence level outside the set", damage(result, ["routine", "items", 0, "confidence", "level"], "certain")],
    ["a window indicator that is text", damage(result, ["outdoorWindows", "analyses", Object.keys(result.outdoorWindows.analyses)[0] ?? "x", "best", "indicator"], "low")],
    ["window wording that says safe", damage(result, ["outdoorWindows", "wording"], "Safe window")],
    ["an engine that claims to have used a model", damage(result, ["provenance", "engine", "llmUsed"], true)],
    ["an unknown transport mode", damage(result, ["transport", "options", 0, "mode"], "teleport")],
    ["an unknown emissions direction", damage(result, ["emissions", "rows", 0, "direction"], "sideways")],
    ["null", null],
    ["an empty object", {}],
  ])("%s", async (_name, data) => {
    respond(200, okRec(data));
    const out = await fetchRecommendations("delhi-ncr", "family_toddlers", false, signal());
    expect(out).toMatchObject({ ok: false, data: null, failure: { kind: "server", cause: "invalid-response" } });
  });

  it("a malformed explanation is dropped, and the deterministic result is kept", async () => {
    const good = envelopeFor(result, "fallback");
    for (const ai of [
      { status: "generated" },
      damage(good, ["numbersFromEngine"], false),
      damage(good, ["status"], "great"),
      damage(good, ["explanation", "topActions"], "all of them"),
      damage(good, ["provider"], "openai"),
      damage(good, ["reasonCode"], "AI_MADE_UP"),
      "text",
      null,
    ]) {
      respond(200, okRec(result, ai));
      const out = await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal());
      expect(out).toEqual({ ok: true, data: { result, ai: null } });
    }
  });
});

describe("malformed chat payloads are rejected", () => {
  it.each([
    ["an answer that is not text", { ...chat, answer: { toString: "x" } }],
    ["a missing message", damage(chat, ["message"], undefined)],
    ["an unknown status", { ...chat, status: "thinking" }],
    ["an unknown provider", { ...chat, provider: "openai" }],
    ["an unknown reason code", { ...chat, reasonCode: "AI_MADE_UP" }],
    ["a negative retry delay", { ...chat, retryAfterSeconds: -1 }],
    ["a missing envelope", undefined],
    ["a string envelope", "hello"],
  ])("%s", async (_name, envelope) => {
    respond(200, { ok: true, ...(envelope === undefined ? {} : { chat: envelope }) });
    expect(await fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())).toMatchObject({ ok: false, failure: { kind: "server", cause: "invalid-response" } });
  });
});

describe("failures are told apart", () => {
  const cause = async () => [
    (await fetchAir("delhi-ncr", signal())) as { ok: false; failure: { kind: string; cause: string; retryAfterSeconds: number | null } },
    (await fetchRecommendations("delhi-ncr", "family_toddlers", false, signal())) as { ok: false; failure: { kind: string; cause: string; retryAfterSeconds: number | null } },
    (await fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())) as { ok: false; failure: { kind: string; cause: string; retryAfterSeconds: number | null } },
  ].map((o) => o.failure);

  it("a network error is a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    for (const f of await cause()) expect(f).toMatchObject({ kind: "network", cause: "network" });
  });

  it.each([
    ["an HTML error page", 502, "<html><body>Bad gateway</body></html>"],
    ["an empty body", 200, ""],
    ["truncated JSON", 200, '{"ok":true,"data":{'],
    ["plain text", 500, "Internal Server Error"],
  ])("%s is invalid JSON", async (_name, status, body) => {
    respond(status, body);
    for (const f of await cause()) expect(f).toMatchObject({ kind: "server", cause: "invalid-json" });
  });

  it("a well-formed error is an HTTP failure and keeps its retry delay", async () => {
    respond(429, { ok: false, error: { code: "RATE_LIMITED", message: "slow down", retryAfterSeconds: 45 } });
    for (const f of await cause()) expect(f).toEqual({ kind: "rate-limited", cause: "http", retryAfterSeconds: 45, message: expect.any(String) });
  });

  it("an error body of the wrong shape is still classified by its status, with no retry delay trusted", async () => {
    for (const body of [{}, { error: "nope" }, { ok: false, error: { code: "RATE_LIMITED", message: "x", retryAfterSeconds: "30" } }, { ok: false, error: { code: "RATE_LIMITED", message: "x", retryAfterSeconds: -5 } }, []]) {
      respond(429, body);
      for (const f of await cause()) expect(f).toMatchObject({ kind: "rate-limited", cause: "invalid-response", retryAfterSeconds: null });
    }
    respond(503, { error: { code: "AIR_DATA_UNAVAILABLE" } });
    for (const f of await cause()) expect(f).toMatchObject({ kind: "server", cause: "invalid-response" });
  });

  it("an error code the contract does not define is not trusted to mean 'unavailable'", async () => {
    respond(503, { ok: false, error: { code: "AIR_DATA_UNAVAILABLE_BUT_DIFFERENT", message: "x" } });
    for (const f of await cause()) expect(f).toMatchObject({ kind: "server", cause: "invalid-response" });
  });

  it("never passes a server message, stack or provider detail to the user", async () => {
    const secret = "GEMINI_API_KEY=abc stack trace at /srv/app.js";
    respond(500, { ok: false, error: { code: "INTERNAL_ERROR", message: secret } });
    for (const f of await cause()) expect(JSON.stringify(f)).not.toContain("abc");
    respond(200, okAir({ ...air, cityName: 5, hidden: secret }));
    expect(JSON.stringify(await fetchAir("delhi-ncr", signal()))).not.toContain("abc");
  });
});

describe("what a failed response may carry", () => {
  it("keeps a valid unavailable state, and drops one that is invalid", async () => {
    const data = unavailableAir();
    const envelope = { ok: false, error: { code: "AIR_DATA_UNAVAILABLE", message: "x", retryAfterSeconds: 60 } };
    respond(503, { ...envelope, data });
    expect(await fetchAir("delhi-ncr", signal())).toMatchObject({ ok: false, data, failure: { kind: "unavailable", cause: "http", retryAfterSeconds: 60 } });
    for (const bad of [damage(data, ["cityId"], "atlantis"), { ...data, freshnessStatus: "fresh" }, { ...data, calculatedAqi: { aqi: 50 } }, "x", 7]) {
      respond(503, { ...envelope, data: bad });
      expect(await fetchAir("delhi-ncr", signal())).toMatchObject({ ok: false, data: null, failure: { kind: "unavailable", cause: "http" } });
    }
  });

  it("an unavailable state cannot be turned into a reading by sending a fresh one with an error", async () => {
    respond(503, { ok: false, error: { code: "AIR_DATA_UNAVAILABLE", message: "x" }, data: air });
    expect(await fetchAir("delhi-ncr", signal())).toMatchObject({ ok: false, data: null });
  });

  it("keeps the unavailable recommendation result and its envelope, and drops invalid parts", async () => {
    const unavailable = recommendFor(unavailableAir());
    const ai = envelopeFor(unavailable, "unavailable");
    const envelope = { ok: false, error: { code: "AIR_DATA_UNAVAILABLE", message: "x" } };
    respond(503, { ...envelope, data: unavailable, ai });
    expect(await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal())).toMatchObject({ ok: false, data: { result: unavailable, ai }, failure: { kind: "unavailable" } });
    respond(503, { ...envelope, data: unavailable, ai: { status: "unavailable" } });
    expect(await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal())).toMatchObject({ ok: false, data: { result: unavailable, ai: null } });
    respond(503, { ...envelope, data: damage(unavailable, ["routine"], undefined), ai });
    expect(await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal())).toMatchObject({ ok: false, data: null, failure: { kind: "unavailable" } });
  });
});

describe("hostile payloads", () => {
  it("JSON that tries to pollute prototypes changes nothing and is rejected or ignored", async () => {
    respond(200, `{"ok":true,"data":${JSON.stringify(air).slice(0, -1)},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}`);
    await fetchAir("delhi-ncr", signal());
    respond(200, '{"__proto__":{"polluted":true},"ok":true,"chat":{"__proto__":{"polluted":true}}}');
    await fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal());
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("markup in text fields stays plain text, unchanged, for the UI to render as text", async () => {
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    respond(200, { ok: true, chat: { ...chat, answer: markup } });
    expect(await fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())).toEqual({ ok: true, chat: { ...chat, answer: markup } });
  });

  it("a very deeply nested body fails safely instead of throwing", async () => {
    respond(200, `${"[".repeat(5_000)}${"]".repeat(5_000)}`);
    const out = await fetchAir("delhi-ncr", signal());
    expect(out.ok).toBe(false);
  });

  it("a hostile body never makes a call throw", async () => {
    for (const body of ["null", "true", "123", '"x"', "[]", "{}", '{"ok":true,"data":[]}', '{"ok":true,"chat":null}']) {
      respond(200, body);
      await expect(fetchAir("delhi-ncr", signal())).resolves.toMatchObject({ ok: false });
      await expect(fetchRecommendations("delhi-ncr", "family_toddlers", true, signal())).resolves.toMatchObject({ ok: false });
      await expect(fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())).resolves.toMatchObject({ ok: false });
    }
  });
});

describe("each payload is validated once", () => {
  it("parses the result and the envelope once per call, and the air reading once", async () => {
    const result$ = vi.spyOn(schemas.recommendationResultSchema, "safeParse");
    const ai$ = vi.spyOn(schemas.aiEnvelopeSchema, "safeParse");
    respond(200, okRec(result, envelopeFor(result, "fallback")));
    await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal());
    expect(result$).toHaveBeenCalledTimes(1);
    expect(ai$).toHaveBeenCalledTimes(1);

    const reading$ = vi.spyOn(normalizedAirDataSchema, "safeParse");
    respond(200, okAir(air));
    expect((await fetchAir("delhi-ncr", signal())).ok).toBe(true);
    expect(reading$).toHaveBeenCalledTimes(1);
  });

  it("does not parse a recommendation result at all when the transport failed", async () => {
    const result$ = vi.spyOn(schemas.recommendationResultSchema, "safeParse");
    respond(500, "oops");
    await fetchRecommendations("delhi-ncr", "family_toddlers", false, signal());
    expect(result$).not.toHaveBeenCalled();
  });
});

describe("on-demand validators", () => {
  it("report a network failure, and never throw, when the validator chunk cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("@/lib/client/apiSchemas", () => {
      throw new Error("ChunkLoadError");
    });
    try {
      const client = await import("@/lib/client/dashboardApi");
      respond(200, okAir(air));
      expect(await client.fetchAir("delhi-ncr", signal())).toMatchObject({ ok: false, data: null, failure: { kind: "network", cause: "network" } });
      expect(await client.fetchRecommendations("delhi-ncr", "family_toddlers", false, signal())).toMatchObject({ ok: false, failure: { kind: "network" } });
      expect(await client.fetchChat("delhi-ncr", "family_toddlers", "hi", [], signal())).toMatchObject({ ok: false, failure: { kind: "network" } });
    } finally {
      vi.doUnmock("@/lib/client/apiSchemas");
      vi.resetModules();
    }
  });

  it("still rethrows a caller abort, so a replaced request is never shown as an error", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))));
    const pending = fetchAir("delhi-ncr", controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("the schemas stay client-safe", () => {
  it("apiSchemas imports no server-only module", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("src/lib/client/apiSchemas.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(text).not.toMatch(/server-only|@\/lib\/env"|@\/lib\/redis|@\/lib\/ratelimit|@\/lib\/data\/|process\.env/);
    // Values come from constants modules only; the engine and the AI services are type-only imports.
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from "@\/lib\/engine";/m);
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*from "@\/lib\/ai\/(service|client|generator|defaultAiService|groqClient)"/m);
  });
});
