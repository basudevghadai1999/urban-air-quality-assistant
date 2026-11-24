import { describe, expect, it } from "vitest";

import { canonicalizeIp, identityFromHeaders } from "@/lib/ratelimit";

const headers = (init: Record<string, string>) => new Headers(init);

describe("canonicalizeIp", () => {
  it.each([
    ["203.0.113.7", "v4:203.0.113.7"],
    ["203.0.113.7:51234", "v4:203.0.113.7"],
    ["  203.0.113.7  ", "v4:203.0.113.7"],
    ["2001:db8::1", "v6:2001:db8:0:0"],
    ["2001:0db8:0000:0001:0000:0000:0000:0001", "v6:2001:db8:0:1"],
    ["[2001:db8:0:1::5]:443", "v6:2001:db8:0:1"],
    ["fe80::1%eth0", "v6:fe80:0:0:0"],
    ["::1", "v6:0:0:0:0"],
    ["::", "v6:0:0:0:0"],
  ])("normalises %s", (input, expected) => {
    expect(canonicalizeIp(input)).toBe(expected);
  });

  it("maps IPv4-in-IPv6 to the IPv4 client", () => {
    expect(canonicalizeIp("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(canonicalizeIp("::ffff:cb00:7107")).toBe("v4:203.0.113.7");
    expect(canonicalizeIp("0:0:0:0:0:ffff:203.0.113.7")).toBe("v4:203.0.113.7");
  });

  it("groups an IPv6 client by /64, so rotating addresses inside one subnet does not create new buckets", () => {
    const a = canonicalizeIp("2001:db8:aaaa:bbbb:1111:2222:3333:4444");
    const b = canonicalizeIp("2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc");
    const other = canonicalizeIp("2001:db8:aaaa:bbbc::1");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it.each([
    "",
    "   ",
    "unknown",
    "localhost",
    "999.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4x",
    "::g",
    ":::",
    "1:2:3:4:5:6:7:8:9",
    "2001:db8::1::2",
    "[::1",
    "1.2.3.4, 5.6.7.8",
    "<script>alert(1)</script>",
    "203.0.113.7\r\nX-Evil: 1",
    // Trailing text after a bracketed address must not be silently ignored.
    "[2001:db8::1], 1.1.1.1",
    "[2001:db8::1]:443, 1.1.1.1",
    "[2001:db8::1]garbage",
    "[2001:db8::1]:99999999",
    "[2001:db8::1]:abc",
    "[]",
    "[ ]",
  ])("rejects %j", (input) => {
    expect(canonicalizeIp(input)).toBeNull();
  });
});

const SPOOFABLE = {
  "x-forwarded-for": "198.51.100.9",
  "x-real-ip": "198.51.100.10",
  "x-vercel-forwarded-for": "198.51.100.11",
  "true-client-ip": "198.51.100.14",
  forwarded: "for=198.51.100.12",
};

describe("identityFromHeaders: trust = none (no explicit Render trust)", () => {
  it("trusts NO header, including CF-Connecting-IP, so spoofed headers cannot choose or rotate the key", () => {
    const spoofed = headers({ ...SPOOFABLE, "cf-connecting-ip": "198.51.100.13" });
    expect(identityFromHeaders(spoofed, "none")).toEqual({ identifier: null, source: null });
  });

  it("returns the same answer however the headers are rotated", () => {
    const first = identityFromHeaders(headers({ "cf-connecting-ip": "1.1.1.1" }), "none");
    const second = identityFromHeaders(headers({ "cf-connecting-ip": "2.2.2.2" }), "none");
    expect(first).toEqual(second);
  });
});

describe("identityFromHeaders: trust = render (CF-Connecting-IP only)", () => {
  it("reads a valid IPv4 client", () => {
    expect(identityFromHeaders(headers({ "cf-connecting-ip": "198.51.100.1" }), "render")).toEqual({
      identifier: "v4:198.51.100.1",
      source: "cf-connecting-ip",
    });
  });

  it("reads a valid IPv6 client, grouped by /64", () => {
    expect(identityFromHeaders(headers({ "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" }), "render").identifier).toBe("v6:2001:db8:1:2");
    expect(identityFromHeaders(headers({ "cf-connecting-ip": "2001:db8::1" }), "render").identifier).toBe("v6:2001:db8:0:0");
  });

  it("maps an IPv4-mapped IPv6 client to its IPv4 identifier, so existing keys are unchanged", () => {
    expect(identityFromHeaders(headers({ "cf-connecting-ip": "::ffff:198.51.100.1" }), "render").identifier).toBe("v4:198.51.100.1");
  });

  it("is case-insensitive about the header name and tolerates surrounding spaces", () => {
    expect(identityFromHeaders(headers({ "CF-Connecting-IP": "  198.51.100.2  " }), "render").identifier).toBe("v4:198.51.100.2");
  });

  it("ignores every other forwarding header, even when they hold valid addresses", () => {
    expect(identityFromHeaders(headers(SPOOFABLE), "render")).toEqual({ identifier: null, source: null });
  });

  it("ignores spoofed X-Forwarded-For and the like when CF-Connecting-IP is present", () => {
    const result = identityFromHeaders(headers({ ...SPOOFABLE, "cf-connecting-ip": "203.0.113.200" }), "render");
    expect(result).toEqual({ identifier: "v4:203.0.113.200", source: "cf-connecting-ip" });
  });

  it("does not let a rotating X-Forwarded-For change the identifier", () => {
    const a = identityFromHeaders(headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1" }), "render");
    const b = identityFromHeaders(headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "2.2.2.2" }), "render");
    expect(a).toEqual(b);
  });

  it.each([
    "not-an-ip",
    "unknown",
    "999.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "::g",
    "2001:db8::1::2",
    "1.1.1.1, 2.2.2.2",
    "1.1.1.1,2.2.2.2",
    "2001:db8::1, 1.1.1.1",
    "198.51.100.1:443",
    "[2001:db8::1]",
    "[2001:db8::1]:443",
    "fe80::1%eth0",
    "198.51.100.1 extra",
    "198.51.100.1;evil",
    "<script>alert(1)</script>",
    "   ",
  ])("rejects a malformed value %j and falls back to no identity", (value) => {
    expect(identityFromHeaders(headers({ "cf-connecting-ip": value }), "render")).toEqual({ identifier: null, source: null });
  });

  it("rejects a repeated header (joined with a comma) instead of trusting either value", () => {
    const h = new Headers();
    h.append("cf-connecting-ip", "198.51.100.1");
    h.append("cf-connecting-ip", "203.0.113.9");
    expect(identityFromHeaders(h, "render")).toEqual({ identifier: null, source: null });
  });

  it("does not fall back to X-Forwarded-For when CF-Connecting-IP is malformed", () => {
    const result = identityFromHeaders(headers({ "cf-connecting-ip": "garbage", "x-forwarded-for": "198.51.100.3" }), "render");
    expect(result).toEqual({ identifier: null, source: null });
  });

  it("returns no identity when the header is missing", () => {
    expect(identityFromHeaders(headers({}), "render")).toEqual({ identifier: null, source: null });
  });
});
