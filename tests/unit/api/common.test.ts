import { describe, expect, it, vi } from "vitest";

import { MAX_BODY_BYTES, applyRateLimit, errorResponse, readJsonBody, unavailableRetryAfterSeconds } from "@/lib/api/common";
import type { GateDecision, RateLimitGate } from "@/lib/ratelimit/gate";

import { bytes, fixedChunks, settle, streamedPost } from "../../fixtures/streams";

const JSON_TYPE = { "content-type": "application/json" };
const post = (body: string | null, headers: Record<string, string> = JSON_TYPE) =>
  new Request("http://localhost:3000/api/test", { method: "POST", headers, ...(body === null ? {} : { body }) });

/** `{"p":"xxx…"}` of exactly `size` bytes. */
const jsonOfSize = (size: number): string => {
  const overhead = bytes('{"p":""}').length;
  return `{"p":"${"x".repeat(size - overhead)}"}`;
};

const failure = async (result: Awaited<ReturnType<typeof readJsonBody>>) => {
  if (result.ok) throw new Error("expected a failure");
  return { status: result.response.status, body: (await result.response.json()) as { ok: false; error: { code: string; message: string } } };
};

describe("readJsonBody", () => {
  it("parses a normal JSON body", async () => {
    const result = await readJsonBody(post('{"cityId":"delhi-ncr","n":[1,2]}'));
    expect(result).toEqual({ ok: true, json: { cityId: "delhi-ncr", n: [1, 2] } });
  });

  it("accepts any JSON value and a content type with parameters or different case", async () => {
    expect(await readJsonBody(post("null"))).toEqual({ ok: true, json: null });
    expect(await readJsonBody(post("[1]", { "content-type": "Application/JSON; charset=utf-8" }))).toEqual({ ok: true, json: [1] });
  });

  it("treats an empty body and a missing body as invalid JSON", async () => {
    for (const request of [post(""), post(null)]) {
      const { status, body } = await failure(await readJsonBody(request));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "INVALID_JSON", message: "The request body is not valid JSON." });
    }
  });

  it("rejects malformed JSON with a fixed message that never echoes the body", async () => {
    const { status, body } = await failure(await readJsonBody(post('{"secret": LEAKED')));
    expect(status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
    expect(JSON.stringify(body)).not.toContain("LEAKED");
  });

  it("refuses a non-JSON content type with 415 and reads nothing", async () => {
    const probe = streamedPost(fixedChunks(1, 10), { "content-type": "text/plain" });
    await settle();
    const before = probe.pulls();
    const { status, body } = await failure(await readJsonBody(probe.request));
    expect(status).toBe(415);
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(probe.pulls()).toBe(before);
    expect((await failure(await readJsonBody(post("{}", {})))).status).toBe(415);
  });

  describe("body size limit", () => {
    it("accepts a body of exactly the limit and refuses one byte more", async () => {
      expect((await readJsonBody(post(jsonOfSize(MAX_BODY_BYTES)))).ok).toBe(true);
      const over = await failure(await readJsonBody(post(jsonOfSize(MAX_BODY_BYTES + 1))));
      expect(over.status).toBe(413);
      expect(over.body.error).toEqual({ code: "REQUEST_TOO_LARGE", message: "The request body is too large." });
    });

    it("counts bytes, not characters", async () => {
      // 4096 two-byte characters plus the JSON overhead is more than 8192 bytes but only about 4100 characters.
      const wide = `{"p":"${"é".repeat(MAX_BODY_BYTES / 2)}"}`;
      expect(wide.length).toBeLessThan(MAX_BODY_BYTES);
      expect((await failure(await readJsonBody(post(wide)))).status).toBe(413);
    });

    it("refuses an oversized Content-Length without reading the stream", async () => {
      const probe = streamedPost(fixedChunks(2, 10), { ...JSON_TYPE, "content-length": String(MAX_BODY_BYTES + 1) });
      await settle();
      const before = probe.pulls();
      expect((await failure(await readJsonBody(probe.request))).status).toBe(413);
      expect(probe.pulls()).toBe(before);
    });

    it("cuts off and cancels an oversized chunked body that has no Content-Length", async () => {
      // An endless 1 KiB-per-chunk body: without a bound this would never finish.
      const probe = streamedPost(() => new Uint8Array(1024).fill(120));
      expect(probe.request.headers.get("content-length")).toBeNull();
      const { status, body } = await failure(await readJsonBody(probe.request));
      expect(status).toBe(413);
      expect(body.error.code).toBe("REQUEST_TOO_LARGE");
      expect(probe.cancelled()).toBe(true);
      // The limit is 8 chunks; allow a few extra for the stream's internal read-ahead, nowhere near "all".
      expect(probe.pulls()).toBeLessThanOrEqual(MAX_BODY_BYTES / 1024 + 3);
    });

    it("cuts off a finite multi-chunk body whose chunks cross the limit", async () => {
      const probe = streamedPost(fixedChunks(3, 3000)); // 9000 bytes in three chunks
      expect((await failure(await readJsonBody(probe.request))).status).toBe(413);
      expect(probe.cancelled()).toBe(true);
    });

    it("accepts many chunks that add up to exactly the limit", async () => {
      const text = jsonOfSize(MAX_BODY_BYTES);
      const data = bytes(text);
      const probe = streamedPost((i) => (i * 1000 < data.length ? data.slice(i * 1000, (i + 1) * 1000) : null));
      expect(await readJsonBody(probe.request)).toEqual({ ok: true, json: JSON.parse(text) });
      expect(probe.cancelled()).toBe(false);
    });

    it("decodes a multi-byte character that is split across chunks", async () => {
      const data = bytes('{"p":"é€😀"}');
      const probe = streamedPost((i) => [data.slice(0, 7), data.slice(7, 9), data.slice(9)][i] ?? null);
      expect(await readJsonBody(probe.request)).toEqual({ ok: true, json: { p: "é€😀" } });
    });

    it("honours a custom limit", async () => {
      expect((await readJsonBody(post('{"a":1}'), 7)).ok).toBe(true);
      expect((await failure(await readJsonBody(post('{"a":12}'), 7))).status).toBe(413);
    });
  });

  it("reports a body that fails mid-stream as unreadable, not as too large", async () => {
    const probe = streamedPost((i) => {
      if (i === 0) return bytes('{"a":');
      throw new Error("connection reset");
    });
    const { status, body } = await failure(await readJsonBody(probe.request));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "INVALID_JSON", message: "The request body could not be read." });
  });
});

describe("errorResponse", () => {
  it("builds the JSON error envelope, never cached", async () => {
    const response = errorResponse(400, "INVALID_REQUEST", "Nope.");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: { code: "INVALID_REQUEST", message: "Nope." } });
  });

  it("adds only the extras that are given, and extra headers", async () => {
    const response = errorResponse(429, "RATE_LIMITED", "Wait.", {
      issues: [{ path: "a", message: "b" }],
      retryAfterSeconds: 7,
      headers: { "Retry-After": "7" },
    });
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Wait.", issues: [{ path: "a", message: "b" }], retryAfterSeconds: 7 },
    });
    const withCities = await errorResponse(400, "INVALID_CITY_ID", "x", { validCityIds: ["a"] }).json();
    expect(withCities.error.validCityIds).toEqual(["a"]);
  });
});

describe("unavailableRetryAfterSeconds", () => {
  it("is 60 seconds for missing data and 30 when the limiter could not decide", () => {
    expect(unavailableRetryAfterSeconds(false)).toBe(60);
    expect(unavailableRetryAfterSeconds(true)).toBe(30);
  });
});

describe("applyRateLimit", () => {
  const request = post("{}");
  const failure500 = () => new Response("boom", { status: 500 });
  const onFailure = { event: "test.gate_failed", cityId: "delhi-ncr", response: failure500 };
  const gateOf = (decision: GateDecision): (() => RateLimitGate) => () => () => Promise.resolve(decision);

  it("proceeds, not degraded, when there is no gate", async () => {
    expect(await applyRateLimit(request, undefined, onFailure)).toEqual({ kind: "proceed", degraded: false });
  });

  it("proceeds when the client is allowed, and flags a degraded limiter", async () => {
    const allowed: GateDecision = { kind: "allow", allowUpstream: true, result: { allowed: true, limit: 5, remaining: 4, resetSeconds: 60 } };
    expect(await applyRateLimit(request, gateOf(allowed), onFailure)).toEqual({ kind: "proceed", degraded: false });
    const degraded: GateDecision = { kind: "degraded", allowUpstream: false };
    expect(await applyRateLimit(request, gateOf(degraded), onFailure)).toEqual({ kind: "proceed", degraded: true });
  });

  it("answers a limited client with 429, Retry-After and rate-limit headers", async () => {
    const limited: GateDecision = { kind: "limited", retryAfterSeconds: 12, result: { allowed: false, limit: 5, remaining: 0, resetSeconds: 12 } };
    const outcome = await applyRateLimit(request, gateOf(limited), onFailure);
    if (outcome.kind !== "blocked") throw new Error("expected blocked");
    expect(outcome.response.status).toBe(429);
    expect(outcome.response.headers.get("retry-after")).toBe("12");
    expect(outcome.response.headers.get("ratelimit-limit")).toBe("5");
    expect(outcome.response.headers.get("ratelimit-remaining")).toBe("0");
    expect(outcome.response.headers.get("ratelimit-reset")).toBe("12");
    expect(await outcome.response.json()).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Please wait before trying again.", retryAfterSeconds: 12 },
    });
  });

  it("refuses with the caller's error, and logs only the event and city, when the gate throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = () => () => Promise.reject(new Error("bad config SECRET-VALUE"));
    const outcome = await applyRateLimit(request, throwing, onFailure);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.response.status).toBe(500);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toBe(JSON.stringify({ level: "warn", event: "test.gate_failed", cityId: "delhi-ncr" }));
    warn.mockRestore();
  });

  it("refuses when building the gate itself throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await applyRateLimit(request, () => { throw new Error("invalid setting"); }, onFailure);
    expect(outcome.kind).toBe("blocked");
    vi.restoreAllMocks();
  });
});
