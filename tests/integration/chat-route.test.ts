import { describe, expect, it, vi } from "vitest";

import { createChatService } from "@/lib/ai/chatService";
import { CHAT_LIMITS } from "@/lib/ai/chatTypes";
import { handleChatRequest } from "@/lib/api/chatHandler";
import { MAX_BODY_BYTES } from "@/lib/api/common";
import type { ChatApiError, ChatApiSuccess } from "@/types/api";
import { MemoryCache } from "@/lib/cache";
import { createAirService, type AirService } from "@/lib/data/airService";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { NormalizedAirData } from "@/types/air";

import { allowGate, fakeTransport, limitedGate, memoryBudget, readyConfig } from "../fixtures/ai";
import { MORNING_DIP } from "../fixtures/engine";
import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";
import { bytes, settle, streamedPost } from "../fixtures/streams";

/** Provider data and model output are SYNTHETIC and injected; no network or quota is used. */

const GOOD = "These suggestions come from modelled Open-Meteo and CAMS data, so use the outdoor activity windows as a guide.";

const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://localhost:3000/api/chat", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const airService = (): AirService =>
  createAirService({
    config: DEFAULT_AIR_SERVICE_CONFIG,
    cache: new MemoryCache<NormalizedAirData>(),
    now: () => FETCHED_AT_MS,
    fetcher: () => Promise.resolve(openMeteoResponseSchema.parse(makeOpenMeteoResponse(MORNING_DIP))),
    logger: { warn: vi.fn() },
  });

function setup(options: { reply?: string; gate?: RateLimitGate; airGate?: RateLimitGate } = {}) {
  const transport = fakeTransport(() => Promise.resolve({ text: JSON.stringify({ answer: options.reply ?? GOOD }), finishReason: "STOP", blockReason: null }));
  const chat = createChatService({
    getConfig: () => readyConfig(),
    getTransport: () => transport,
    budget: memoryBudget(20),
    clientGate: options.gate ?? allowGate,
    logger: { warn: vi.fn() },
  });
  const run = (body: unknown, headers?: Record<string, string>) =>
    handleChatRequest(post(body, headers), airService, () => FETCHED_AT_MS, {
      getChat: () => chat,
      ...(options.airGate === undefined ? {} : { getGate: () => options.airGate as RateLimitGate }),
    });
  return { run, transport, chat };
}

const valid = { cityId: "bengaluru", profileId: "family_toddlers", message: "Is it a good time for a walk?" };

describe("POST /api/chat: success", () => {
  it("returns the model's validated answer, uncached, with the AI headers", async () => {
    const { run, transport } = setup();
    const res = await run(valid);
    const body = (await res.json()) as ChatApiSuccess;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.chat).toMatchObject({ status: "generated", answer: GOOD, provider: "gemini" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-ai-status")).toBe("generated");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.userPrompt).toContain("Is it a good time for a walk?");
  });

  it("accepts earlier messages and passes them to the model as untrusted history", async () => {
    const { run, transport } = setup();
    const res = await run({ ...valid, history: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi, ask me about the air." }] });
    expect(res.status).toBe(200);
    expect(transport.requests[0]?.userPrompt).toContain("user: Hello");
    expect(transport.requests[0]?.userPrompt).toContain("assistant: Hi, ask me about the air.");
  });

  it("answers from the built-in rules (still 200) when the answer fails the safety checks", async () => {
    const { run } = setup({ reply: "It is safe to go outside right now." });
    const body = (await (await run(valid)).json()) as ChatApiSuccess;
    expect(body.chat.status).toBe("fallback");
    expect(body.chat.reasonCode).toBe("AI_VALIDATION_REJECTED");
    expect(body.chat.answer).not.toMatch(/safe to go outside/);
  });

  it("answers from the built-in rules when the per-client AI limit is reached, with retry-after", async () => {
    const { run, transport } = setup({ gate: limitedGate(17) });
    const body = (await (await run(valid)).json()) as ChatApiSuccess;
    expect(body.chat).toMatchObject({ status: "fallback", reasonCode: "AI_RATE_LIMITED", retryAfterSeconds: 17 });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("POST /api/chat: input is validated and never echoed", () => {
  const error = async (res: Response) => ((await res.json()) as ChatApiError).error;

  it("requires application/json", async () => {
    const { run } = setup();
    const res = await run(JSON.stringify(valid), { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect((await error(res)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects invalid JSON", async () => {
    const { run } = setup();
    const res = await run("{not json", { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("INVALID_JSON");
  });

  it("rejects a body over 8 KB, by declared length and by actual size", async () => {
    const { run, transport } = setup();
    const big = JSON.stringify({ ...valid, history: [{ role: "user", text: "x".repeat(MAX_BODY_BYTES) }] });
    expect((await run(big, { "content-type": "application/json", "content-length": String(big.length) })).status).toBe(413);
    expect((await run(big, { "content-type": "application/json" })).status).toBe(413);
    expect(transport.requests).toHaveLength(0);
  });

  it("cuts off an endless chunked body that declares no length, before any model call", async () => {
    const { transport } = setup();
    const probe = streamedPost(() => bytes("x".repeat(1024)));
    const res = await handleChatRequest(probe.request, airService, () => FETCHED_AT_MS, { getChat: () => ({ answer: () => Promise.reject(new Error("must not run")) }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ChatApiError).error.code).toBe("REQUEST_TOO_LARGE");
    expect(probe.cancelled()).toBe(true);
    expect(probe.pulls()).toBeLessThanOrEqual(MAX_BODY_BYTES / 1024 + 3);
    expect(transport.requests).toHaveLength(0);
  });

  it("accepts a valid body that arrives in several chunks", async () => {
    const { transport, chat } = setup();
    const data = bytes(JSON.stringify(valid));
    const probe = streamedPost((i) => (i * 9 < data.length ? data.slice(i * 9, (i + 1) * 9) : null));
    await settle();
    const res = await handleChatRequest(probe.request, airService, () => FETCHED_AT_MS, { getChat: () => chat });
    expect(res.status).toBe(200);
    expect(transport.requests).toHaveLength(1);
  });

  it.each([
    ["an over-long message", { ...valid, message: "q".repeat(CHAT_LIMITS.messageMax + 1) }],
    ["an empty message", { ...valid, message: "  " }],
    ["a control character", { ...valid, message: "hi\u0007there" }],
    ["an unknown city", { ...valid, cityId: "atlantis" }],
    ["an unknown field", { ...valid, role: "system" }],
    ["too many history entries", { ...valid, history: Array.from({ length: 7 }, () => ({ role: "user", text: "a" })) }],
  ])("rejects %s with 400 and no model call", async (_name, body) => {
    const { run, transport } = setup();
    const res = await run(body);
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("INVALID_REQUEST");
    expect(transport.requests).toHaveLength(0);
  });

  it("never echoes the submitted text in an error", async () => {
    const { run } = setup();
    const secretish = "SUPER-SECRET-QUESTION-TEXT ".repeat(40);
    const res = await run({ ...valid, message: secretish });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("SUPER-SECRET-QUESTION-TEXT");
  });
});

describe("POST /api/chat: rate limiting and failure handling", () => {
  it("answers 429 with Retry-After when the air gate limits the client, before any work", async () => {
    const { run, transport } = setup({ airGate: limitedGate(23) });
    const res = await run(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("23");
    expect(transport.requests).toHaveLength(0);
  });

  it("returns a controlled 500, with no detail, if the air service throws", async () => {
    const chat = createChatService({ getConfig: () => readyConfig(), getTransport: () => fakeTransport(() => Promise.reject(new Error("x"))), budget: memoryBudget(5), clientGate: allowGate });
    const broken = (): AirService => ({ getAirData: () => Promise.reject(new Error("db password is hunter2")) }) as unknown as AirService;
    const res = await handleChatRequest(post(valid), broken, () => FETCHED_AT_MS, { getChat: () => chat });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/hunter2|stack|at /);
  });
});
