import { describe, expect, it } from "vitest";

import { resolveAiConfig } from "@/lib/ai/config";
import { AI_SETTING_LIMITS, getAiSettings } from "@/lib/env";

/** Environments here are plain objects: neither `.env` nor `process.env` is read, and every key is fake. */

const KEY = "FAKE-config-test-key-0123456789";
const first = (c: ReturnType<typeof resolveAiConfig>) => (c.status === "ready" ? c.providers[0] : undefined);

describe("provider configuration (Gemini primary, Groq secondary)", () => {
  const GROQ = "FAKE-groq-test-key-0123456789";

  it("orders Gemini first and Groq second by default, and uses the documented Groq default model", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ });
    expect(c.status === "ready" && c.providers.map((p) => [p.id, p.model])).toEqual([["gemini", "gemini-3.5-flash"], ["groq", "openai/gpt-oss-20b"]]);
  });

  it("a missing Gemini key leaves Groq working, and a missing Groq key leaves Gemini working", () => {
    const groqOnly = resolveAiConfig({ GROQ_API_KEY: GROQ });
    expect(groqOnly.status === "ready" && groqOnly.providers.map((p) => p.id)).toEqual(["groq"]);
    const geminiOnly = resolveAiConfig({ GEMINI_API_KEY: KEY });
    expect(geminiOnly.status === "ready" && geminiOnly.providers.map((p) => p.id)).toEqual(["gemini"]);
  });

  it("neither key configured is AI_NOT_CONFIGURED", () => {
    expect(resolveAiConfig({})).toEqual({ status: "unavailable", reason: "AI_NOT_CONFIGURED" });
  });

  it("the order is configurable, deduplicated, and never adds an unconfigured provider", () => {
    const swapped = resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ, AI_PROVIDER_ORDER: "groq, gemini, groq" });
    expect(swapped.status === "ready" && swapped.providers.map((p) => p.id)).toEqual(["groq", "gemini"]);
    const only = resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ, AI_PROVIDER_ORDER: "groq" });
    expect(only.status === "ready" && only.providers.map((p) => p.id)).toEqual(["groq"]);
    const absent = resolveAiConfig({ GEMINI_API_KEY: KEY, AI_PROVIDER_ORDER: "groq" });
    expect(absent).toEqual({ status: "unavailable", reason: "AI_NOT_CONFIGURED" });
  });

  it.each(["openai", "gemini,claude", ",", "groq;gemini"])("rejects the invalid provider order %j", (order) => {
    expect(resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ, AI_PROVIDER_ORDER: order })).toEqual({ status: "unavailable", reason: "AI_INVALID_CONFIG" });
  });

  it("an invalid GROQ_MODEL disables only Groq; Gemini still works", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ, GROQ_MODEL: "has space" });
    expect(c.status === "ready" && c.providers.map((p) => p.id)).toEqual(["gemini"]);
    expect(resolveAiConfig({ GROQ_API_KEY: GROQ, GROQ_MODEL: "has space" })).toEqual({ status: "unavailable", reason: "AI_INVALID_CONFIG" });
  });

  it("honours GROQ_MODEL, and keeps both keys out of JSON, spread and string conversion", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY, GROQ_API_KEY: GROQ, GROQ_MODEL: "openai/gpt-oss-120b" });
    expect(c.status === "ready" && c.providers[1]?.model).toBe("openai/gpt-oss-120b");
    expect(JSON.stringify(c)).not.toContain(GROQ);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify({ ...(c.status === "ready" ? c.providers[1] : {}) })).not.toContain(GROQ);
  });

  it("per-provider daily budgets have conservative defaults and are validated", () => {
    expect(getAiSettings({}).providerDailyBudget).toEqual({ gemini: 200, groq: 200 });
    expect(getAiSettings({ AI_GROQ_DAILY_BUDGET: "50" }).providerDailyBudget.groq).toBe(50);
    expect(() => getAiSettings({ AI_GROQ_DAILY_BUDGET: "0" })).toThrow();
  });
});

describe("Gemini configuration", () => {
  it("is ready with a key, using the existing env utility and the documented default model", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY });
    expect(c.status).toBe("ready");
    expect(first(c)?.model).toBe("gemini-3.5-flash");
    expect(first(c)?.apiKey).toBe(KEY);
  });

  it("accepts the GEMINI_KEY fallback name, with GEMINI_API_KEY winning when both are set", () => {
    const fallback = resolveAiConfig({ GEMINI_KEY: "FAKE-fallback-key-0123456789" });
    expect(first(fallback)?.apiKey).toBe("FAKE-fallback-key-0123456789");
    const both = resolveAiConfig({ GEMINI_API_KEY: KEY, GEMINI_KEY: "FAKE-fallback-key-0123456789" });
    expect(first(both)?.apiKey).toBe(KEY);
    const blankPrimary = resolveAiConfig({ GEMINI_API_KEY: "  ", GEMINI_KEY: "FAKE-fallback-key-0123456789" });
    expect(first(blankPrimary)?.apiKey).toBe("FAKE-fallback-key-0123456789");
  });

  it("reports a missing key as AI_NOT_CONFIGURED, without throwing", () => {
    expect(resolveAiConfig({})).toEqual({ status: "unavailable", reason: "AI_NOT_CONFIGURED" });
    expect(resolveAiConfig({ GEMINI_API_KEY: "", GEMINI_KEY: "   " })).toEqual({ status: "unavailable", reason: "AI_NOT_CONFIGURED" });
  });

  it("selects the configured model and never substitutes another", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "gemini-2.5-flash-lite" });
    expect(first(c)?.model).toBe("gemini-2.5-flash-lite");
    const other = resolveAiConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "my-tuned/model_v2" });
    expect(first(other)?.model).toBe("my-tuned/model_v2");
  });

  it.each(["has space", "semi;colon", "../etc/passwd", "model?x=1", "a".repeat(101), "-leading", "<script>"])("rejects an invalid model name %j as AI_INVALID_CONFIG", (model) => {
    expect(resolveAiConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: model })).toEqual({ status: "unavailable", reason: "AI_INVALID_CONFIG" });
  });

  it("reports the kill switch as AI_DISABLED, checked before the key", () => {
    expect(resolveAiConfig({ GEMINI_API_KEY: KEY, AI_EXPLANATIONS_ENABLED: "false" })).toEqual({ status: "unavailable", reason: "AI_DISABLED" });
    expect(resolveAiConfig({ AI_EXPLANATIONS_ENABLED: "0" })).toEqual({ status: "unavailable", reason: "AI_DISABLED" });
    expect(resolveAiConfig({ GEMINI_API_KEY: KEY, AI_EXPLANATIONS_ENABLED: "TRUE" }).status).toBe("ready");
  });

  it("reports an invalid tuning value as AI_INVALID_CONFIG, never echoing it", () => {
    for (const env of [{ AI_REQUEST_TIMEOUT_MS: "5" }, { AI_DAILY_BUDGET: "0" }, { AI_RATE_LIMIT_MAX: "abc" }, { AI_EXPLANATIONS_ENABLED: "maybe" }, { AI_MAX_OUTPUT_TOKENS: "99999" }]) {
      const c = resolveAiConfig({ GEMINI_API_KEY: KEY, ...env });
      expect(c).toEqual({ status: "unavailable", reason: "AI_INVALID_CONFIG" });
      expect(JSON.stringify(c)).not.toContain(Object.values(env)[0] ?? "\u0000");
    }
  });

  it("keeps the key non-enumerable: JSON, spread and string conversion omit it", () => {
    const c = resolveAiConfig({ GEMINI_API_KEY: KEY });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify({ ...c })).not.toContain(KEY);
    expect(Object.keys(c)).not.toContain("apiKey");
    expect(String(JSON.stringify(c))).not.toMatch(/FAKE-config/);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe("AI settings", () => {
  it("defaults to 5 generations per client per minute, 300 per UTC day, a 20 s timeout and a 30-minute cache", () => {
    const s = getAiSettings({});
    expect(s).toEqual({
      enabled: true,
      timeoutMs: 20_000,
      maxOutputTokens: 3_000,
      thinkingBudget: null,
      rateLimit: { limit: 5, windowSeconds: 60 },
      dailyBudget: 300,
      providerDailyBudget: { gemini: 200, groq: 200 },
      providerOrder: ["gemini", "groq"],
      cacheTtlSeconds: 1_800,
    });
  });

  it("reads every documented override", () => {
    const s = getAiSettings({
      AI_REQUEST_TIMEOUT_MS: "9000",
      AI_MAX_OUTPUT_TOKENS: "1500",
      AI_THINKING_BUDGET: "128",
      AI_RATE_LIMIT_MAX: "2",
      AI_RATE_LIMIT_WINDOW_SECONDS: "30",
      AI_DAILY_BUDGET: "50",
      AI_CACHE_TTL_SECONDS: "600",
    });
    expect(s).toMatchObject({ timeoutMs: 9000, maxOutputTokens: 1500, thinkingBudget: 128, rateLimit: { limit: 2, windowSeconds: 30 }, dailyBudget: 50, cacheTtlSeconds: 600 });
  });

  it("enforces every bound, naming only the variable", () => {
    const L = AI_SETTING_LIMITS;
    const bad: [string, string][] = [
      ["AI_REQUEST_TIMEOUT_MS", String(L.timeoutMs.min - 1)],
      ["AI_REQUEST_TIMEOUT_MS", String(L.timeoutMs.max + 1)],
      ["AI_MAX_OUTPUT_TOKENS", String(L.maxOutputTokens.min - 1)],
      ["AI_RATE_LIMIT_MAX", "0"],
      ["AI_RATE_LIMIT_WINDOW_SECONDS", String(L.rateLimitWindowSeconds.max + 1)],
      ["AI_DAILY_BUDGET", String(L.dailyBudget.max + 1)],
      ["AI_CACHE_TTL_SECONDS", String(L.cacheTtlSeconds.min - 1)],
      ["AI_THINKING_BUDGET", "-1"],
      ["AI_DAILY_BUDGET", "1.5"],
    ];
    for (const [name, value] of bad) {
      expect(() => getAiSettings({ [name]: value }), `${name}=${value}`).toThrow(new RegExp(`Environment variable ${name} is invalid`));
      try {
        getAiSettings({ [name]: value });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value === "" ? "\u0000" : `=${value}`);
      }
    }
  });

  it("treats blank variables as unset", () => {
    expect(getAiSettings({ AI_DAILY_BUDGET: "  ", AI_THINKING_BUDGET: "" }).dailyBudget).toBe(300);
    expect(getAiSettings({ AI_THINKING_BUDGET: "" }).thinkingBudget).toBeNull();
  });
});
