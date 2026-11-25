import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Static guards for the Redis and rate-limit secret boundaries. Reads only src/. */
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function list(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return list(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const files = list(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const byPath = (p: string) => files.find((f) => f.path === p.split("/").join("/"));

describe("Redis credential boundaries", () => {
  it("never exposes a Redis variable through a NEXT_PUBLIC_ name", () => {
    const offenders = files.filter(({ text }) => /NEXT_PUBLIC_\w*(UPSTASH|REDIS)/i.test(text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it.each([
    "lib/redis/client.ts",
    "lib/cache/upstash.ts",
    "lib/ratelimit/redis.ts",
    "lib/ratelimit/gate.ts",
    "lib/data/defaultAirService.ts",
    "lib/env.ts",
  ])("marks %s server-only, so importing it from a Client Component fails the build", (path) => {
    expect(byPath(path)?.text, path).toMatch(/^import "server-only";/m);
  });

  it("never imports Redis, rate-limit or env modules from a Client Component", () => {
    const offenders = files
      .filter(({ text }) => /^["']use client["']/m.test(text))
      .filter(({ text }) => /from ["']@\/lib\/(redis|ratelimit|cache\/upstash|env|data\/defaultAirService)/.test(text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("reads the Redis URL and token only in env.ts, never from a request", () => {
    const readers = files.filter(({ text }) => /UPSTASH_REDIS_REST_(URL|TOKEN)/.test(text)).map((f) => f.path);
    expect(readers).toEqual(["lib/env.ts"]);
    const handler = byPath("lib/api/airHandler.ts")?.text ?? "";
    expect(handler).not.toMatch(/UPSTASH|process\.env/);
  });

  it("never writes a token, header value or client address to a log call", () => {
    const logCalls = files.flatMap(({ path, text }) =>
      [...text.matchAll(/(?:logger|consoleSafeLogger)\.warn\([^;]*?\);/gs)].map((m) => ({ path, call: m[0] })),
    );
    expect(logCalls.length).toBeGreaterThan(5);
    for (const { path, call } of logCalls) {
      // Check the FIELDS argument only: an event name such as "air.client_identifier_unavailable" is fine.
      const fields = call.slice(call.indexOf(",") + 1);
      expect(fields, path).not.toMatch(/token|authorization|headers|\bip\b|identifier|x-forwarded|secret|request\b/i);
    }
  });

  it("limits the Redis client to the commands the app needs", () => {
    const commands = new Set(
      files.flatMap(({ text }) => [...text.matchAll(/command\(\[\s*"([A-Z]+)"/g)].map((m) => m[1] ?? "")),
    );
    expect([...commands].sort()).toEqual(["DEL", "EVAL", "GET", "SET"]);
  });
});
