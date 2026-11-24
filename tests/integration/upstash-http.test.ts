import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { UpstashCache } from "@/lib/cache/upstash";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";
import { createUpstashRestClient } from "@/lib/redis";
import { RedisError } from "@/lib/redis/errors";

import { FakeRedis } from "../fixtures/fakeRedis";
import { makeSnapshot } from "../fixtures/snapshot";

/**
 * The Redis client against a REAL local HTTP server speaking the Upstash REST
 * protocol, so real `fetch` behaviour (timeouts, redirects, streaming, headers) is exercised,
 * not just mocked. The server is a local stand-in: no live Redis is involved.
 */

const TOKEN = "FAKE-http-test-token-0123456789";
const open: Server[] = [];

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

async function serve(handler: Handler): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

/** A faithful Upstash-style endpoint backed by FakeRedis: bearer auth, POST command array, {result}/{error}. */
function upstashLike(redis: FakeRedis): Handler {
  return (request, response, body) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "WRONGPASS invalid or missing auth token" }));
      return;
    }
    redis
      .command(JSON.parse(body) as (string | number)[])
      .then((result) => response.end(JSON.stringify({ result })))
      .catch(() => {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "ERR simulated" }));
      });
  };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("Upstash REST client over real HTTP", () => {
  it("round-trips a full snapshot through UpstashCache", async () => {
    const redis = new FakeRedis(() => Date.now());
    const { url } = await serve(upstashLike(redis));
    const cache = new UpstashCache({ client: createUpstashRestClient({ url, token: TOKEN }), retentionSeconds: 86_400 });

    const snapshot = makeSnapshot("mumbai", Date.now());
    await cache.set("mumbai", { value: snapshot, storedAtMs: Date.parse(snapshot.fetchedAt ?? "") });
    const got = await cache.get("mumbai");
    expect(got?.value).toEqual(snapshot);
    expect(redis.ttlSeconds("air:v1:snapshot:mumbai")).toBe(86_400);
  });

  it("drives the rate limiter over HTTP (atomic EVAL result arrays survive the wire)", async () => {
    const redis = new FakeRedis(() => Date.now());
    const { url } = await serve(upstashLike(redis));
    const limiter = new RedisRateLimiter({ client: createUpstashRestClient({ url, token: TOKEN }), policy: { limit: 2, windowSeconds: 60 } });
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push((await limiter.check("c:abc")).allowed);
    expect(results).toEqual([true, true, false]);
  });

  it("surfaces a wrong token as an auth error, without echoing it", async () => {
    const { url } = await serve(upstashLike(new FakeRedis(() => Date.now())));
    const client = createUpstashRestClient({ url, token: "WRONG-token-1234" });
    const error = await client.command(["GET", "k"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisError);
    expect((error as RedisError).kind).toBe("auth");
    expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain("WRONG-token-1234");
  });

  it("times out a server that never answers, after one attempt", async () => {
    const { url, hits } = await serve(() => undefined); // accepts the request, never responds
    const started = Date.now();
    const error = await createUpstashRestClient({ url, token: TOKEN }, { timeoutMs: 150 }).command(["GET", "k"]).catch((e: unknown) => e);
    expect((error as RedisError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hits()).toBe(1);
  });

  it("refuses to follow a redirect, so credentials are never forwarded elsewhere", async () => {
    const target = await serve((_req, res) => res.end(JSON.stringify({ result: "REACHED" })));
    const redirector = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", target.url);
      res.end();
    });
    const error = await createUpstashRestClient({ url: redirector.url, token: TOKEN }).command(["GET", "k"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisError);
    expect(target.hits()).toBe(0);
  });

  it("refuses an oversized response while streaming it", async () => {
    const { url } = await serve((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.write('{"result":"');
      res.end("x".repeat(3 * 1024 * 1024) + '"}');
    });
    const error = await createUpstashRestClient({ url, token: TOKEN }, { maxBytes: 100_000 }).command(["GET", "k"]).catch((e: unknown) => e);
    expect((error as RedisError).kind).toBe("too-large");
  });

  it("classifies a server that returns HTML as a protocol error", async () => {
    const { url } = await serve((_req, res) => res.end("<html>Bad gateway</html>"));
    const error = await createUpstashRestClient({ url, token: TOKEN }).command(["GET", "k"]).catch((e: unknown) => e);
    expect((error as RedisError).kind).toBe("protocol");
  });

  it("classifies a refused connection as a network error", async () => {
    const { url } = await serve(() => undefined);
    const dead = new URL(url);
    await new Promise<void>((resolve) => open[0]?.close(() => resolve()));
    const error = await createUpstashRestClient({ url: `http://127.0.0.1:${dead.port}`, token: TOKEN }, { timeoutMs: 1_000 })
      .command(["GET", "k"])
      .catch((e: unknown) => e);
    expect((error as RedisError).kind).toBe("network");
  });

  it("sends the token only in the Authorization header, never in the URL or body", async () => {
    let seen: { url: string | undefined; body: string; auth: string | undefined } | null = null;
    const { url } = await serve((request, response, body) => {
      seen = { url: request.url, body, auth: request.headers.authorization };
      response.end(JSON.stringify({ result: "OK" }));
    });
    await createUpstashRestClient({ url, token: TOKEN }).command(["SET", "k", "v", "EX", 60]);
    expect(seen).toEqual({ url: "/", body: JSON.stringify(["SET", "k", "v", "EX", 60]), auth: `Bearer ${TOKEN}` });
  });
});
