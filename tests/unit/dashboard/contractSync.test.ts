import { describe, expect, it } from "vitest";

import { errorResponse } from "@/lib/api/common";
import { AI_REASON_CODES } from "@/lib/ai/errors";
import { AI_PROVIDER_NAMES, AI_STATUSES } from "@/lib/ai/types";
import { CHAT_STATUSES } from "@/lib/ai/chatTypes";
import { aiEnvelopeSchema, airErrorSchema, chatEnvelopeSchema, chatErrorSchema, recommendErrorSchema, type SameContract } from "@/lib/client/apiSchemas";
import { AIR_API_ERROR_CODES } from "@/types/air";
import { CHAT_API_ERROR_CODES, RECOMMEND_API_ERROR_CODES } from "@/types/api";

import { envelopeFor, recommendFor, airFor } from "../../fixtures/dashboard";

/**
 * Server and client must agree on every enum. Three layers:
 *   1. compile time: `ContractInSync` in `apiSchemas.ts` (mutual assignability), proven to work below;
 *   2. one shared list per enum, from which the server type and the client schema are both derived;
 *   3. these tests: the lists are pinned (so a change is a deliberate edit that also reviews the client) and
 *      the real validators accept every member the server can send, and nothing else.
 */

describe("compile-time guard", () => {
  // These are type-level assertions: if `SameContract` stopped detecting a drift, `tsc` would fail here.
  it("detects a member the schema forgot, an extra one, a rename and a changed optionality", () => {
    const forgot: SameContract<{ k: "a" }, { k: "a" | "b" }> = false;
    const extra: SameContract<{ k: "a" | "b" }, { k: "a" }> = false;
    const renamed: SameContract<{ k: "a" | "c" }, { k: "a" | "b" }> = false;
    const optionality: SameContract<{ k?: "a" }, { k: "a" }> = false;
    const nested: SameContract<{ list: { s: "x" | "y" }[] }, { list: readonly { s: "x" }[] }> = false;
    expect([forgot, extra, renamed, optionality, nested]).toEqual([false, false, false, false, false]);
  });

  it("accepts identical shapes, ignoring the index signature of a loose object and readonly", () => {
    const same: SameContract<{ k: "a" | "b"; list: { s: "x" }[]; [key: string]: unknown }, { readonly k: "a" | "b"; readonly list: readonly { readonly s: "x" }[] }> = true;
    expect(same).toBe(true);
  });
});

describe("error codes", () => {
  it.each([
    ["air", AIR_API_ERROR_CODES, airErrorSchema, ["MISSING_CITY_ID", "INVALID_CITY_ID", "UNSUPPORTED_PARAMETER", "DUPLICATE_PARAMETER", "REQUEST_TOO_LARGE", "RATE_LIMITED", "RATE_LIMITING_UNAVAILABLE", "AIR_DATA_UNAVAILABLE", "INTERNAL_ERROR"]],
    ["recommend", RECOMMEND_API_ERROR_CODES, recommendErrorSchema, ["UNSUPPORTED_MEDIA_TYPE", "REQUEST_TOO_LARGE", "INVALID_JSON", "INVALID_REQUEST", "RATE_LIMITED", "RATE_LIMITING_UNAVAILABLE", "AIR_DATA_UNAVAILABLE", "INTERNAL_ERROR"]],
    ["chat", CHAT_API_ERROR_CODES, chatErrorSchema, ["UNSUPPORTED_MEDIA_TYPE", "REQUEST_TOO_LARGE", "INVALID_JSON", "INVALID_REQUEST", "RATE_LIMITED", "INTERNAL_ERROR"]],
  ] as const)("%s: the list is pinned, and the client accepts exactly it", async (_name, codes, schema, pinned) => {
    // Adding, removing or renaming a code fails here until this list (and so the client) is reviewed.
    expect([...codes]).toEqual([...pinned]);
    for (const code of codes) {
      // The body the REAL server helper builds for that code is what the client validator must accept.
      const body: unknown = await errorResponse(code === "RATE_LIMITED" ? 429 : 400, code, "Fixed message.", { retryAfterSeconds: 5 }).json();
      expect(schema.safeParse(body).success, code).toBe(true);
    }
    for (const unknown of ["TEAPOT", "rate_limited", "", "INVALID_JSON ", null, 7]) {
      expect(schema.safeParse({ ok: false, error: { code: unknown, message: "m" } }).success, String(unknown)).toBe(false);
    }
  });

  it("a code that only another endpoint sends is refused", () => {
    const body = (code: string) => ({ ok: false, error: { code, message: "m" } });
    expect(chatErrorSchema.safeParse(body("AIR_DATA_UNAVAILABLE")).success).toBe(false);
    expect(chatErrorSchema.safeParse(body("RATE_LIMITING_UNAVAILABLE")).success).toBe(false);
    expect(recommendErrorSchema.safeParse(body("MISSING_CITY_ID")).success).toBe(false);
    expect(airErrorSchema.safeParse(body("INVALID_JSON")).success).toBe(false);
  });
});

describe("AI and chat enums", () => {
  const result = recommendFor(airFor("delhi-ncr"));
  const chat = { status: "generated", answer: "Plan the walk for the morning.", reasonCode: null, message: "ok", provider: "groq", model: "m", promptVersion: "t" };

  it("pins the status and provider lists", () => {
    expect([...AI_STATUSES]).toEqual(["generated", "cached", "fallback", "unavailable"]);
    expect([...AI_PROVIDER_NAMES]).toEqual(["gemini", "groq", "deterministic"]);
    expect([...CHAT_STATUSES]).toEqual(["generated", "fallback", "unavailable"]);
  });

  it.each(AI_STATUSES)("the explanation validator accepts status %s and rejects a made-up one", (status) => {
    const base = envelopeFor(result, "fallback");
    expect(aiEnvelopeSchema.safeParse({ ...base, status }).success).toBe(true);
    expect(aiEnvelopeSchema.safeParse({ ...base, status: `${status}-x` }).success).toBe(false);
  });

  it.each(AI_PROVIDER_NAMES)("both validators accept provider %s and reject a made-up one", (provider) => {
    expect(aiEnvelopeSchema.safeParse({ ...envelopeFor(result, "fallback"), provider }).success).toBe(true);
    expect(chatEnvelopeSchema.safeParse({ ...chat, provider }).success).toBe(true);
    expect(aiEnvelopeSchema.safeParse({ ...envelopeFor(result, "fallback"), provider: "mistral" }).success).toBe(false);
    expect(chatEnvelopeSchema.safeParse({ ...chat, provider: "mistral" }).success).toBe(false);
  });

  it.each(CHAT_STATUSES)("the chat validator accepts status %s", (status) => {
    expect(chatEnvelopeSchema.safeParse({ ...chat, status }).success).toBe(true);
    expect(chatEnvelopeSchema.safeParse({ ...chat, status: "cached" }).success).toBe(false);
  });

  it("every AI reason code the server can send is accepted, an unknown one is not", () => {
    for (const reasonCode of AI_REASON_CODES) {
      expect(chatEnvelopeSchema.safeParse({ ...chat, status: "fallback", reasonCode }).success, reasonCode).toBe(true);
      expect(aiEnvelopeSchema.safeParse({ ...envelopeFor(result, "fallback"), reasonCode }).success, reasonCode).toBe(true);
    }
    expect(chatEnvelopeSchema.safeParse({ ...chat, status: "fallback", reasonCode: "AI_TEAPOT" }).success).toBe(false);
  });
});
