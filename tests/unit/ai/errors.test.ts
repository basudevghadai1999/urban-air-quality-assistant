import { describe, expect, it } from "vitest";

import { AI_REASON_CODES, AI_REASON_MESSAGES, AiError, classifyGeminiError } from "@/lib/ai";

const withStatus = (status: number, message = "RAW PROVIDER TEXT with key AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE12345") => Object.assign(new Error(message), { name: "ApiError", status });

describe("Gemini error classification", () => {
  it.each([
    [429, "AI_QUOTA"],
    [401, "AI_AUTH_FAILED"],
    [403, "AI_AUTH_FAILED"],
    [404, "AI_MODEL_UNAVAILABLE"],
    [408, "AI_TIMEOUT"],
    [400, "AI_BAD_REQUEST"],
    [422, "AI_BAD_REQUEST"],
    [500, "AI_UPSTREAM_ERROR"],
    [503, "AI_UPSTREAM_ERROR"],
  ])("HTTP %i -> %s", (status, code) => {
    expect(classifyGeminiError(withStatus(status))).toBe(code);
  });

  it("classifies timeouts and aborts", () => {
    expect(classifyGeminiError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("AI_TIMEOUT");
    expect(classifyGeminiError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("AI_TIMEOUT");
    expect(classifyGeminiError(new Error("fetch failed", { cause: Object.assign(new Error("c"), { name: "TimeoutError" }) }))).toBe("AI_TIMEOUT");
    expect(classifyGeminiError(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }))).toBe("AI_TIMEOUT");
  });

  it("treats everything else, including non-errors, as a network failure", () => {
    expect(classifyGeminiError(new TypeError("fetch failed"))).toBe("AI_NETWORK");
    expect(classifyGeminiError("boom")).toBe("AI_NETWORK");
    expect(classifyGeminiError(null)).toBe("AI_NETWORK");
    expect(classifyGeminiError(undefined)).toBe("AI_NETWORK");
  });

  it("passes an AiError's own code through", () => {
    expect(classifyGeminiError(new AiError("AI_SAFETY_BLOCKED"))).toBe("AI_SAFETY_BLOCKED");
  });

  it("never lets the provider's message reach the sanitized outcome", () => {
    const code = classifyGeminiError(withStatus(500));
    const message = AI_REASON_MESSAGES[code];
    expect(message).not.toMatch(/RAW PROVIDER|AIza/);
    expect(new AiError(code).message).toBe(message);
  });
});

describe("reason codes", () => {
  it("every code has one fixed, user-readable message that exposes no internals", () => {
    expect(Object.keys(AI_REASON_MESSAGES).sort()).toEqual([...AI_REASON_CODES].sort());
    for (const code of AI_REASON_CODES) {
      const m = AI_REASON_MESSAGES[code];
      expect(m.length).toBeGreaterThan(20);
      expect(m).not.toMatch(/https?:|stack|exception|redis|token|api key|gemini-|status \d{3}|\b[45]\d\d\b/i);
      expect(m).toMatch(/[.]$/);
    }
  });
});
