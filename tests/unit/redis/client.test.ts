import { describe, expect, it, vi } from "vitest";

import { createUpstashRestClient, type RedisFetch } from "@/lib/redis";
import { RedisError } from "@/lib/redis/errors";

import { jsonResponse } from "../../fixtures/openMeteo";

const CONFIG = { url: "https://fake-host-9999.upstash.io", token: "FAKE-TOKEN-do-not-leak-0123456789" };

const reply = (body: unknown, init?: ResponseInit) => jsonResponse(body, init);

const catchRedisError = async (promise: Promise<unknown>): Promise<RedisError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RedisError) return error;
    throw error;
  }
  throw new Error("expected a RedisError");
};

/** Everything an error could leak through. */
const surface = (error: RedisError) => `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;

describe("createUpstashRestClient: request shape (Upstash REST protocol)", () => {
  it("POSTs the command as a JSON array to the database URL with a bearer token", async () => {
    const fetchImpl = vi.fn<RedisFetch>().mockResolvedValue(reply({ result: "OK" }));
    const client = createUpstashRestClient(CONFIG, { fetchImpl });
    await client.command(["SET", "key", "value", "EX", 900]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://fake-host-9999.upstash.io");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${CONFIG.token}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual(["SET", "key", "value", "EX", 900]);
  });

  it("never puts the token in the URL or body", async () => {
    const fetchImpl = vi.fn<RedisFetch>().mockResolvedValue(reply({ result: null }));
    await createUpstashRestClient(CONFIG, { fetchImpl }).command(["GET", "k"]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(CONFIG.token);
    expect(String(init.body)).not.toContain(CONFIG.token);
  });

  it("is safe by construction: no caching, no redirects, bounded by a timeout signal", async () => {
    const fetchImpl = vi.fn<RedisFetch>().mockResolvedValue(reply({ result: 1 }));
    await createUpstashRestClient(CONFIG, { fetchImpl }).command(["DEL", "k"]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["OK", "OK"],
    [null, null],
    [137, 137],
    ["a string", "a string"],
    [[3, 59_000], [3, 59_000]],
  ])("returns the raw result (%j)", async (result, expected) => {
    const client = createUpstashRestClient(CONFIG, { fetchImpl: () => Promise.resolve(reply({ result })) });
    expect(await client.command(["X"])).toEqual(expected);
  });
});

describe("createUpstashRestClient: failures are classified, never leaky", () => {
  it("times out when Redis does not answer, after exactly one attempt", async () => {
    const hang: RedisFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const fetchImpl = vi.fn(hang);
    const started = Date.now();
    const error = await catchRedisError(createUpstashRestClient(CONFIG, { fetchImpl, timeoutMs: 25 }).command(["GET", "k"]));
    expect(error.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retries: callers own the fallback policy
  });

  it("maps a network failure and does not retry", async () => {
    const fetchImpl = vi.fn<RedisFetch>().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 10.1.2.3"));
    const error = await catchRedisError(createUpstashRestClient(CONFIG, { fetchImpl }).command(["GET", "k"]));
    expect(error.kind).toBe("network");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(surface(error)).not.toContain("10.1.2.3");
    expect(surface(error)).not.toContain("ECONNREFUSED");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [400, "http"],
    [429, "http"],
    [500, "http"],
    [503, "http"],
  ] as const)("HTTP %i -> %s, with the status kept", async (status, kind) => {
    const client = createUpstashRestClient(CONFIG, {
      fetchImpl: () => Promise.resolve(reply({ error: "irrelevant" }, { status })),
    });
    const error = await catchRedisError(client.command(["GET", "k"]));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  it("classifies WRONGPASS / NOAUTH as auth and everything else as command, discarding the text", async () => {
    const auth = createUpstashRestClient(CONFIG, {
      fetchImpl: () => Promise.resolve(reply({ error: "WRONGPASS invalid or missing auth token" })),
    });
    expect((await catchRedisError(auth.command(["GET", "k"]))).kind).toBe("auth");

    const command = createUpstashRestClient(CONFIG, {
      fetchImpl: () => Promise.resolve(reply({ error: "ERR syntax error, command was: [\"SET\",\"k\",\"SECRET-PAYLOAD\"]" })),
    });
    const error = await catchRedisError(command.command(["SET", "k", "SECRET-PAYLOAD"]));
    expect(error.kind).toBe("command");
    expect(surface(error)).not.toContain("SECRET-PAYLOAD");
    expect(surface(error)).not.toContain("syntax error");
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["empty body", ""],
    ["an HTML error page", "<html>502</html>"],
    ["JSON without a result", JSON.stringify({ ok: true })],
    ["a JSON scalar", JSON.stringify("hello")],
    ["JSON null", "null"],
  ])("rejects %s as a protocol error", async (_label, body) => {
    const client = createUpstashRestClient(CONFIG, { fetchImpl: () => Promise.resolve(reply(body)) });
    expect((await catchRedisError(client.command(["GET", "k"]))).kind).toBe("protocol");
  });

  it("refuses an oversized response, by declared length and while streaming", async () => {
    const declared = createUpstashRestClient(CONFIG, {
      maxBytes: 1_000,
      fetchImpl: () => Promise.resolve(reply({ result: "x" }, { headers: { "Content-Length": "5000000" } })),
    });
    expect((await catchRedisError(declared.command(["GET", "k"]))).kind).toBe("too-large");

    const chunk = new TextEncoder().encode("x".repeat(400));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls > 1_000) controller.close();
      },
    });
    const streaming = createUpstashRestClient(CONFIG, {
      maxBytes: 1_000,
      fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
    });
    expect((await catchRedisError(streaming.command(["GET", "k"]))).kind).toBe("too-large");
    expect(pulls).toBeLessThan(20);
  });

  it("no failure path ever contains the token, the URL or the command", async () => {
    const failures: RedisFetch[] = [
      () => Promise.reject(new TypeError(`fetch failed ${CONFIG.url} Bearer ${CONFIG.token}`)),
      () => Promise.resolve(reply({ error: `ERR ${CONFIG.token}` }, { status: 500 })),
      () => Promise.resolve(reply({ error: `WRONGPASS ${CONFIG.token}` })),
      () => Promise.resolve(reply(`oops ${CONFIG.token}`)),
    ];
    for (const fetchImpl of failures) {
      const error = await catchRedisError(createUpstashRestClient(CONFIG, { fetchImpl }).command(["GET", "secret-key"]));
      const text = surface(error);
      expect(text).not.toContain(CONFIG.token);
      expect(text).not.toContain("fake-host-9999");
      expect(text).not.toContain("secret-key");
    }
  });
});
