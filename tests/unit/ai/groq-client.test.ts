import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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

describe("bounded body and cancellation", () => {
  const LIMIT = 200_000;
  /** A 200 OK whose body arrives in the given chunks, optionally ending in an error. */
  function streamed(chunks: Uint8Array[], options: { failWith?: Error; headers?: Record<string, string>; pulls?: { n: number } } = {}) {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.pulls) options.pulls.n += 1;
        const chunk = chunks[i++];
        if (chunk !== undefined) controller.enqueue(chunk);
        else if (options.failWith) controller.error(options.failWith);
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: options.headers });
  }
  const enc = (s: string) => new TextEncoder().encode(s);
  /** A valid completion padded to exactly `bytes` bytes. */
  function completionOfSize(bytes: number): string {
    const base = JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }], pad: "" });
    return base.replace('"pad":""', `"pad":"${"a".repeat(bytes - base.length)}"`);
  }
  const run = (response: () => Response, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    createGroqTransport(KEY, { fetchImpl: (() => Promise.resolve(response())) as unknown as typeof fetch }).generate({ ...request, ...extra });
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

  it("accepts a body exactly at the limit and refuses one a byte over", async () => {
    const atLimit = completionOfSize(LIMIT);
    expect(enc(atLimit).byteLength).toBe(LIMIT);
    expect((await run(() => new Response(atLimit, { status: 200 }))).finishReason).toBe("stop");

    const over = await errorOf(run(() => new Response(completionOfSize(LIMIT + 1), { status: 200 })));
    expect(over).toBeInstanceOf(ProviderHttpError);
    expect(classifyProviderError(over)).toBe("AI_UPSTREAM_ERROR");
  });

  it("reads a chunked body, including a multibyte character split across chunks", async () => {
    const full = enc(JSON.stringify({ choices: [{ message: { content: "Air is café-clean today ✓" }, finish_reason: "stop" }] }));
    const cut = full.indexOf(0xc3) + 1; // between the two bytes of "é"
    const out = await run(() => streamed([full.slice(0, cut), full.slice(cut, cut + 7), full.slice(cut + 7)]));
    expect(out.text).toBe("Air is café-clean today ✓");
  });

  it("counts BYTES, not characters: multibyte text over the limit is refused", async () => {
    const text = "é".repeat(LIMIT / 2 + 1); // 100,001 characters, 200,002 bytes
    expect(text.length).toBeLessThan(LIMIT);
    const err = await errorOf(run(() => new Response(`{"x":"${text}"}`, { status: 200 })));
    expect(err).toBeInstanceOf(ProviderHttpError);
  });

  it("stops reading and cancels the stream once the limit is passed (no unbounded buffering)", async () => {
    const pulls = { n: 0 };
    const chunk = new Uint8Array(50_000).fill(97);
    const many = Array.from({ length: 100 }, () => chunk); // 5 MB on offer
    const err = await errorOf(run(() => streamed(many, { pulls })));
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(pulls.n).toBeLessThan(10); // read about 4 chunks, not all 100
  });

  it("refuses by a declared Content-Length without reading, and ignores a missing or invalid one while streaming", async () => {
    const pulls = { n: 0 };
    const declared = await errorOf(run(() => streamed([enc("{}")], { headers: { "content-length": String(LIMIT + 1) }, pulls })));
    expect(declared).toBeInstanceOf(ProviderHttpError);
    expect(pulls.n).toBeLessThanOrEqual(1); // at most the platform's own one-chunk prefill: nothing was consumed

    const good = JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    expect((await run(() => streamed([enc(good)], { headers: { "content-length": "not-a-number" } }))).text).toBe("ok");
    expect((await run(() => streamed([enc(good)]))).text).toBe("ok");
    // A false small length does not let a large body through: the stream is still counted.
    const lie = await errorOf(run(() => streamed([new Uint8Array(LIMIT + 10).fill(97)], { headers: { "content-length": "5" } })));
    expect(lie).toBeInstanceOf(ProviderHttpError);
  });

  it("a stream that breaks keeps its own error (a network failure), distinct from 'too large'", async () => {
    const err = await errorOf(run(() => streamed([enc('{"choices":')], { failWith: new TypeError("terminated") })));
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect(classifyProviderError(err)).toBe("AI_NETWORK");
  });

  it("sends the caller's signal with the request, and aborts when the caller leaves", async () => {
    const caller = new AbortController();
    const f = fakeFetch(() => completion("{}"));
    await createGroqTransport(KEY, { fetchImpl: f.fn }).generate({ ...request, signal: caller.signal });
    const sent = f.calls[0]?.init.signal as AbortSignal;
    expect(sent.aborted).toBe(false);
    caller.abort();
    expect(sent.aborted).toBe(true);

    const gone = new AbortController();
    gone.abort();
    const fetchImpl = ((_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(completion("{}")))) as unknown as typeof fetch;
    const err = await errorOf(createGroqTransport(KEY, { fetchImpl }).generate({ ...request, signal: gone.signal }));
    expect(err?.name).toBe("AbortError");
  });

  it("tells a timeout from a caller's cancellation by the signal's reason", async () => {
    const outcome = async (caller?: AbortController) => {
      const fetchImpl = ((_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          caller?.abort();
        })) as unknown as typeof fetch;
      return errorOf(createGroqTransport(KEY, { fetchImpl }).generate({ ...request, timeoutMs: 20, ...(caller === undefined ? {} : { signal: caller.signal }) }));
    };
    const timedOut = await outcome();
    expect(timedOut?.name).toBe("TimeoutError");
    expect(classifyProviderError(timedOut)).toBe("AI_TIMEOUT");

    const caller = new AbortController();
    const cancelled = await outcome(caller);
    expect(cancelled?.name).toBe("AbortError"); // not a TimeoutError: the caller's own signal says which it was
    expect(caller.signal.aborted).toBe(true);
  });

  it("a body read that is aborted mid-stream rejects with the abort, not a partial answer", async () => {
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('{"choices":'));
        caller.signal.addEventListener("abort", () => controller.error(caller.signal.reason));
      },
    });
    const pending = errorOf(run(() => new Response(body, { status: 200 })));
    setTimeout(() => caller.abort(), 5);
    expect((await pending)?.name).toBe("AbortError");
  });
});

describe("against a real local HTTP server (the real fetch, no network beyond loopback)", () => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  async function serve(handler: Handler) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())), server };
  }
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);
  const until = async (cond: () => boolean, ms = 2_000) => {
    const start = Date.now();
    while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };

  it("a body that stalls after the headers is cut off at the call's timeout, as a timeout", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":'); // then nothing, and the connection stays open
    });
    try {
      const started = Date.now();
      const err = await errorOf(createGroqTransport(KEY, { url: s.url }).generate({ ...request, timeoutMs: 150 }));
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(classifyProviderError(err)).toBe("AI_TIMEOUT");
    } finally {
      s.server.closeAllConnections();
      await s.close();
    }
  });

  it("an endless body is refused at the limit within moments, and the connection is released", async () => {
    let closed = false;
    let sent = 0;
    const s = await serve((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      req.socket.on("close", () => (closed = true));
      const chunk = Buffer.alloc(32_768, 97);
      const pump = () => {
        while (!closed && res.write(chunk)) sent += chunk.length;
        if (!closed) res.once("drain", pump);
      };
      pump();
    });
    try {
      const started = Date.now();
      const err = await errorOf(createGroqTransport(KEY, { url: s.url }).generate({ ...request, timeoutMs: 10_000 }));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect(await until(() => closed)).toBe(true); // the reader was cancelled: the server sees the connection go
      expect(sent).toBeLessThan(5_000_000); // a few buffers of kernel/stream slack, nowhere near an unbounded read
    } finally {
      s.server.closeAllConnections();
      await s.close();
    }
  });

  it("an error response's body is released unread", async () => {
    let closed = false;
    const s = await serve((req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      req.socket.on("close", () => (closed = true));
      res.write("RAW provider text"); // never ended
    });
    try {
      const err = await errorOf(createGroqTransport(KEY, { url: s.url }).generate(request));
      expect(classifyProviderError(err)).toBe("AI_UPSTREAM_ERROR");
      expect(await until(() => closed)).toBe(true);
    } finally {
      s.server.closeAllConnections();
      await s.close();
    }
  });
});
