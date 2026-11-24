import { describe, expect, it } from "vitest";

import { GENERATION_TEMPERATURE, defaultThinkingBudget, generateExplanationText, interpretResponse } from "@/lib/ai/generator";
import { AiError, SYSTEM_INSTRUCTION, buildGroundingContext } from "@/lib/ai";
import type { GeminiRequest } from "@/lib/ai/client";
import type { ProviderTarget } from "@/lib/ai/provider";
import type { AiSettings } from "@/lib/env";

import { fakeTransport, readyConfig, resultFor } from "../../fixtures/ai";

const { result, air } = resultFor("family_toddlers");
const grounding = buildGroundingContext(result, air);
const ok = { text: '{"a":1}', finishReason: "STOP", blockReason: null };

describe("interpretResponse", () => {
  it("returns the text of a complete response", () => {
    expect(interpretResponse(ok)).toBe('{"a":1}');
  });

  it.each([
    [{ ...ok, blockReason: "SAFETY" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, blockReason: "PROHIBITED_CONTENT" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, finishReason: "SAFETY" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, finishReason: "RECITATION" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, finishReason: "PROHIBITED_CONTENT" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, finishReason: "BLOCKLIST" }, "AI_SAFETY_BLOCKED"],
    [{ ...ok, finishReason: "MAX_TOKENS" }, "AI_TRUNCATED"],
    [{ ...ok, text: null }, "AI_EMPTY_RESPONSE"],
    [{ ...ok, text: "" }, "AI_EMPTY_RESPONSE"],
    [{ ...ok, text: "   \n" }, "AI_EMPTY_RESPONSE"],
  ])("refuses %j with %s", (response, code) => {
    expect(() => interpretResponse(response)).toThrowError(expect.objectContaining({ code }));
  });

  it("never returns the text of a truncated response, so partial JSON is never parsed", () => {
    expect(() => interpretResponse({ text: '{"overview":"cut o', finishReason: "MAX_TOKENS", blockReason: null })).toThrow(AiError);
  });
});

describe("thinking default", () => {
  it("turns thinking off for Flash models, leaves other models alone, and lets the setting override", () => {
    expect(defaultThinkingBudget("gemini-2.5-flash", null)).toBe(0);
    expect(defaultThinkingBudget("gemini-2.5-flash-lite", null)).toBe(0);
    expect(defaultThinkingBudget("gemini-3.5-flash", null)).toBeNull();
    expect(defaultThinkingBudget("gemini-2.5-pro", null)).toBeNull();
    expect(defaultThinkingBudget("some-other-model", null)).toBeNull();
    expect(defaultThinkingBudget("gemini-2.5-flash", 512)).toBe(512);
    expect(defaultThinkingBudget("gemini-2.5-pro", 128)).toBe(128);
  });
});

const generatorArgs = (): [ProviderTarget, AiSettings] => {
  const config = readyConfig();
  return [config.providers[0] as ProviderTarget, config.settings];
};

describe("generateExplanationText", () => {
  it("sends one request with the configured model, bounded output, a low temperature and a structured-output schema", async () => {
    const config = readyConfig({ maxOutputTokens: 1_234, timeoutMs: 7_000 }, "gemini-2.5-flash");
    const target = config.providers[0] as ProviderTarget;
    const t = fakeTransport(() => Promise.resolve(ok));
    expect((await generateExplanationText(t, target, config.settings, grounding)).text).toBe(ok.text);
    expect(t.requests).toHaveLength(1);
    const r = t.requests[0] as GeminiRequest;
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.maxOutputTokens).toBe(1_234);
    expect(r.timeoutMs).toBe(7_000);
    expect(r.temperature).toBe(GENERATION_TEMPERATURE);
    expect(r.thinkingBudget).toBe(0);
    expect(r.systemInstruction).toBe(SYSTEM_INSTRUCTION);
    expect(r.userPrompt).toContain(grounding.json);
    const schema = r.responseJsonSchema as { properties: { topActions: { items: { properties: { recommendationId: { enum: string[] } } } } } };
    expect(schema.properties.topActions.items.properties.recommendationId.enum).toEqual(grounding.allowedIds);
  });

  it("never puts the API key in the request", async () => {
    const t = fakeTransport(() => Promise.resolve(ok));
    await generateExplanationText(t, ...generatorArgs(), grounding);
    expect(JSON.stringify(t.requests)).not.toContain("FAKE-TEST-KEY");
  });

  it.each([
    [Object.assign(new Error("RAW"), { name: "ApiError", status: 429 }), "AI_QUOTA"],
    [Object.assign(new Error("RAW"), { name: "ApiError", status: 500 }), "AI_UPSTREAM_ERROR"],
    [Object.assign(new Error("RAW"), { name: "ApiError", status: 404 }), "AI_MODEL_UNAVAILABLE"],
    [Object.assign(new Error("RAW"), { name: "ApiError", status: 403 }), "AI_AUTH_FAILED"],
    [Object.assign(new Error("RAW"), { name: "TimeoutError" }), "AI_TIMEOUT"],
    [new TypeError("fetch failed"), "AI_NETWORK"],
  ])("turns a transport failure into a sanitized reason code (%#)", async (error, code) => {
    const t = fakeTransport(() => Promise.reject(error));
    const failure = await generateExplanationText(t, ...generatorArgs(), grounding).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiError);
    expect((failure as AiError).code).toBe(code);
    expect((failure as AiError).message).not.toContain("RAW");
  });

  it("makes exactly one attempt per call: it never retries", async () => {
    const t = fakeTransport(() => Promise.reject(Object.assign(new Error("x"), { status: 500 })));
    await generateExplanationText(t, ...generatorArgs(), grounding).catch(() => undefined);
    expect(t.requests).toHaveLength(1);
  });
});
