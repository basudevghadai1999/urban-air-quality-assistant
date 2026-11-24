import { describe, expect, it } from "vitest";

import { parseRedisConfig } from "@/lib/redis/config";

// Obviously fake values: tests never read the real environment.
const TOKEN = "AbCd1234-fake_token~value+/=";

describe("parseRedisConfig", () => {
  it("accepts an https Upstash-style URL and normalises it to its origin", () => {
    const result = parseRedisConfig("https://fake-name-12345.upstash.io/", TOKEN);
    expect(result).toEqual({ ok: true, config: { url: "https://fake-name-12345.upstash.io", token: TOKEN } });
  });

  it("trims surrounding whitespace", () => {
    const result = parseRedisConfig("  https://fake.upstash.io  ", `  ${TOKEN}\n`);
    expect(result).toEqual({ ok: true, config: { url: "https://fake.upstash.io", token: TOKEN } });
  });

  it.each(["http://localhost:8079", "http://127.0.0.1:8079", "http://[::1]:8079"])(
    "allows plain http only for a local development proxy (%s)",
    (url) => {
      expect(parseRedisConfig(url, TOKEN).ok).toBe(true);
    },
  );

  it.each([
    "http://redis.example.com",
    "http://10.0.0.5:8079",
    "http://localhost.evil.example",
    "ftp://fake.upstash.io",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "redis://fake.upstash.io:6379",
    "//fake.upstash.io",
    "not a url",
    "",
  ])("rejects the URL %j", (url) => {
    expect(parseRedisConfig(url, TOKEN)).toEqual({ ok: false, problem: "url" });
  });

  it.each([
    "https://user:pass@fake.upstash.io",
    "https://fake.upstash.io/path",
    "https://fake.upstash.io?token=abc",
    "https://fake.upstash.io/#frag",
  ])("rejects credentials, paths, queries and fragments in the URL: %s", (url) => {
    expect(parseRedisConfig(url, TOKEN)).toEqual({ ok: false, problem: "url" });
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["contains a space", "abc def"],
    ["contains a newline (header injection)", "abc\r\nX-Evil: 1"],
    ["contains a quote", 'abc"def'],
    ["contains non-ASCII", "abcé"],
    ["too long", "a".repeat(513)],
  ])("rejects a token that is %s", (_label, token) => {
    expect(parseRedisConfig("https://fake.upstash.io", token)).toEqual({ ok: false, problem: "token" });
  });

  it("reports the URL problem first when both are bad, and never echoes either value", () => {
    const result = parseRedisConfig("nope", "bad token");
    expect(result).toEqual({ ok: false, problem: "url" });
    expect(JSON.stringify(result)).not.toContain("bad token");
  });
});
