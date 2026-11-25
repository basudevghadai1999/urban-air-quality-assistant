import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The real SDK client, with `@google/genai` mocked: proves WHAT we ask the SDK for (one attempt, a
 * timeout, structured output, no key in the request body) without any network or quota.
 */

const generateContent = vi.fn();
const constructed: { apiKey?: string }[] = [];

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: { apiKey?: string }) {
      constructed.push(options);
    }
  },
}));

const { createGeminiTransport } = await import("@/lib/ai/client");

const request = {
  model: "gemini-2.5-flash",
  systemInstruction: "SYSTEM",
  userPrompt: "USER",
  responseJsonSchema: { type: "object" },
  maxOutputTokens: 900,
  temperature: 0.2,
  thinkingBudget: 0 as number | null,
  timeoutMs: 6_000,
};

beforeEach(() => {
  generateContent.mockReset();
  constructed.length = 0;
});

describe("Gemini SDK transport", () => {
  it("builds the client server-side with the key passed explicitly", () => {
    createGeminiTransport("FAKE-sdk-key-0123456789");
    expect(constructed).toEqual([{ apiKey: "FAKE-sdk-key-0123456789" }]);
  });

  it("asks for JSON with a schema, one attempt, a timeout, and no retries", async () => {
    generateContent.mockResolvedValue({ text: '{"ok":true}', candidates: [{ finishReason: "STOP" }] });
    await createGeminiTransport("FAKE-sdk-key-0123456789").generate(request);
    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0]?.[0] as { model: string; contents: string; config: Record<string, unknown> };
    expect(call.model).toBe("gemini-2.5-flash");
    expect(call.contents).toBe("USER");
    expect(call.config).toMatchObject({
      systemInstruction: "SYSTEM",
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
      maxOutputTokens: 900,
      temperature: 0.2,
      candidateCount: 1,
      thinkingConfig: { thinkingBudget: 0 },
      httpOptions: { timeout: 6_000, retryOptions: { attempts: 1 } },
    });
    expect(call.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("omits the thinking configuration when none is chosen", async () => {
    generateContent.mockResolvedValue({ text: "{}", candidates: [{ finishReason: "STOP" }] });
    await createGeminiTransport("k").generate({ ...request, thinkingBudget: null });
    expect((generateContent.mock.calls[0]?.[0] as { config: Record<string, unknown> }).config).not.toHaveProperty("thinkingConfig");
  });

  it("keeps the API key out of the request payload", async () => {
    generateContent.mockResolvedValue({ text: "{}", candidates: [] });
    await createGeminiTransport("FAKE-sdk-key-0123456789").generate(request);
    expect(JSON.stringify(generateContent.mock.calls)).not.toContain("FAKE-sdk-key");
  });

  it("maps the response to text, finish reason and block reason", async () => {
    generateContent.mockResolvedValue({ text: "T", candidates: [{ finishReason: "MAX_TOKENS" }], promptFeedback: { blockReason: "SAFETY" } });
    expect(await createGeminiTransport("k").generate(request)).toMatchObject({ text: "T", finishReason: "MAX_TOKENS", blockReason: "SAFETY" });
    generateContent.mockResolvedValue({});
    expect(await createGeminiTransport("k").generate(request)).toMatchObject({ text: null, finishReason: null, blockReason: null, usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
  });

  it("lets SDK errors propagate unchanged, for the caller to classify and discard", async () => {
    const boom = Object.assign(new Error("PROVIDER BODY"), { status: 429 });
    generateContent.mockRejectedValue(boom);
    await expect(createGeminiTransport("k").generate(request)).rejects.toBe(boom);
  });
});

describe("Gemini cancellation", () => {
  it("passes the caller's signal to the SDK together with the timeout guard, and the SDK call aborts when either fires", async () => {
    generateContent.mockResolvedValue({ text: "{}", candidates: [{ finishReason: "STOP" }] });
    const caller = new AbortController();
    await createGeminiTransport("FAKE-sdk-key-0123456789").generate({ ...request, signal: caller.signal });
    const signal = (generateContent.mock.calls[0]?.[0] as { config: { abortSignal: AbortSignal } }).config.abortSignal;
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("without a caller signal only the timeout guard is passed, and a disconnected caller aborts nothing shared", async () => {
    generateContent.mockResolvedValue({ text: "{}", candidates: [{ finishReason: "STOP" }] });
    await createGeminiTransport("FAKE-sdk-key-0123456789").generate(request);
    const signal = (generateContent.mock.calls[0]?.[0] as { config: { abortSignal: AbortSignal } }).config.abortSignal;
    expect(signal.aborted).toBe(false);
  });
});
