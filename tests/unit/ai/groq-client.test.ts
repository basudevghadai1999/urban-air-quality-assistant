import { describe, expect, it, vi } from "vitest";

import { classifyProviderError } from "@/lib/ai/errors";
import { GROQ_CHAT_COMPLETIONS_URL, ProviderHttpError, createGroqTransport, toGroqStrictSchema } from "@/lib/ai/groqClient";
import { buildResponseJsonSchema } from "@/lib/ai/schema";

/** `fetch` is a fake: no network, no quota. The key here is a fake string. */

const KEY = "FAKE-groq-key-0123456789abcdef";
const request = {
  model: "openai/gpt-oss-20b",
  systemInstruction: "SYSTEM",
  userPrompt: "USER",
  responseJsonSchema: buildResponseJsonSchema(["ROUTINE_a-1", "INDOOR_X"]),
  maxOutputTokens: 900,
  temperature: 0.2,
  thinkingBudget: null,
  timeoutMs: 6_000,
};

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(respond());
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const completion = (content: string, finish = "stop", usage: unknown = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) => ok({ choices: [{ message: { content }, finish_reason: finish }], usage });

describe("request", () => {
  it("posts once to the Groq chat completions endpoint with the key only in the Authorization header", async () => {
    const f = fakeFetch(() => completion("{}"));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(GROQ_CHAT_COMPLETIONS_URL);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(String(call.init.body)).not.toContain(KEY);
    expect(call.url).not.toContain(KEY);
  });

  it("sends the shared prompts, a strict json_schema, bounded output and no streaming or tools", async () => {
    const f = fakeFetch(() => completion("{}"));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request);
    const body = JSON.parse(String(f.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.messages).toEqual([{ role: "system", content: "SYSTEM" }, { role: "user", content: "USER" }]);
    expect(body.max_completion_tokens).toBe(900);
    expect(body.temperature).toBe(0.2);
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("tools");
    const format = body.response_format as { type: string; json_schema: { strict: boolean; name: string; schema: Record<string, unknown> } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
  });

  it("uses best-effort schema mode for a model Groq does not document as strict, and no reasoning option", async () => {
    const f = fakeFetch(() => completion("{}"));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate({ ...request, model: "some/other-model" });
    const body = JSON.parse(String(f.calls[0]?.init.body)) as { response_format: { json_schema: { strict: boolean } } };
    expect(body.response_format.json_schema.strict).toBe(false);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("bounds the call with a timeout signal and refuses redirects (the key cannot be forwarded)", async () => {
    const f = fakeFetch(() => completion("{}"));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request);
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(f.calls[0]?.init.redirect).toBe("error");
  });

  it("adapts the shared schema without weakening it: required and additionalProperties stay, unsupported keywords go", () => {
    const adapted = toGroqStrictSchema(request.responseJsonSchema) as Record<string, unknown>;
    expect(JSON.stringify(adapted)).not.toMatch(/propertyOrdering|minItems|maxItems/);
    expect(adapted.required).toEqual((request.responseJsonSchema as { required: string[] }).required);
    expect(adapted.additionalProperties).toBe(false);
    const props = adapted.properties as { topActions: { items: { properties: { recommendationId: { enum: string[] } } } } };
    const ids = props.topActions.items.properties.recommendationId.enum;
    expect(ids).toEqual(["ROUTINE_a-1", "INDOOR_X"]);
    // The source schema is untouched.
    expect(JSON.stringify(request.responseJsonSchema)).toContain("propertyOrdering");
  });
});

describe("response", () => {
  it("returns the message text and the provider's own token counts", async () => {
    const f = fakeFetch(() => completion('{"a":1}'));
    const r = await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request);
    expect(r).toEqual({ text: '{"a":1}', finishReason: "stop", blockReason: null, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
  });

  it("reports missing usage as null, never an estimate", async () => {
    const f = fakeFetch(() => completion("{}", "stop", null));
    const r = await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request);
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    const odd = fakeFetch(() => completion("{}", "stop", { prompt_tokens: "12", completion_tokens: -1, total_tokens: Number.NaN }));
    expect((await createGroqTransport(KEY, { fetchImpl: odd.fn }).generate(request)).usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("maps Groq's finish reasons to the shared vocabulary", async () => {
    expect((await createGroqTransport(KEY, { fetchImpl: fakeFetch(() => completion("{", "length")).fn }).generate(request)).finishReason).toBe("MAX_TOKENS");
    expect((await createGroqTransport(KEY, { fetchImpl: fakeFetch(() => completion("", "content_filter")).fn }).generate(request)).finishReason).toBe("SAFETY");
  });

  it("returns null text when there is no usable message", async () => {
    const r = await createGroqTransport(KEY, { fetchImpl: fakeFetch(() => ok({ choices: [] })).fn }).generate(request);
    expect(r.text).toBeNull();
  });
});

describe("failures carry a status only", () => {
  const classify = async (response: () => Response | Promise<Response>) => {
    const failure = await createGroqTransport(KEY, { fetchImpl: fakeFetch(response).fn }).generate(request).catch((e: unknown) => e);
    return { failure, code: classifyProviderError(failure) };
  };

  it.each([
    [429, "AI_QUOTA"],
    [503, "AI_UPSTREAM_ERROR"],
    [500, "AI_UPSTREAM_ERROR"],
    [401, "AI_AUTH_FAILED"],
    [403, "AI_AUTH_FAILED"],
    [404, "AI_MODEL_UNAVAILABLE"],
    [400, "AI_BAD_REQUEST"],
  ])("HTTP %i is classified as %s", async (status, code) => {
    const r = await classify(() => new Response(`{"error":{"message":"RAW provider text with ${KEY}"}}`, { status }));
    expect(r.failure).toBeInstanceOf(ProviderHttpError);
    expect(r.code).toBe(code);
    expect(String((r.failure as Error).message)).not.toContain("RAW");
    expect(String((r.failure as Error).message)).not.toContain(KEY);
  });

  it("never reads an error response body", async () => {
    const text = vi.fn(() => Promise.resolve("RAW"));
    const response = { ok: false, status: 503, text } as unknown as Response;
    await classify(() => response);
    expect(text).not.toHaveBeenCalled();
  });

  it("treats an unparseable or oversized success body as an upstream error", async () => {
    expect((await classify(() => new Response("not json", { status: 200 }))).code).toBe("AI_UPSTREAM_ERROR");
    expect((await classify(() => new Response("x".repeat(200_001), { status: 200 }))).code).toBe("AI_UPSTREAM_ERROR");
  });

  it("classifies a timeout and a network failure", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    expect((await createGroqTransport(KEY, { fetchImpl: (() => Promise.reject(timeout)) as unknown as typeof fetch }).generate(request).catch((e: unknown) => classifyProviderError(e)))).toBe("AI_TIMEOUT");
    expect((await createGroqTransport(KEY, { fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch }).generate(request).catch((e: unknown) => classifyProviderError(e)))).toBe("AI_NETWORK");
  });

  it("makes exactly one request even when it fails: no retry", async () => {
    const f = fakeFetch(() => new Response("", { status: 503 }));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate(request).catch(() => undefined);
    expect(f.calls).toHaveLength(1);
  });
});
