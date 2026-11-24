import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryRateLimiter } from "@/lib/ratelimit";
import { UNIDENTIFIED_BUCKET, createRateLimitGate, hashClientKey, type GateDecision } from "@/lib/ratelimit/gate";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";
import type { IpTrust } from "@/lib/ratelimit";
import { createAirMetrics } from "@/lib/observability/metrics";

import { FakeRedis, makeClock } from "../../fixtures/fakeRedis";

const POLICY = { limit: 3, windowSeconds: 60 };
const SECRET = "fake-hash-secret-for-tests";

const req = (headers: Record<string, string> = {}, url = "http://localhost/api/air?cityId=mumbai") =>
  new Request(url, { headers });
const fromIp = (ip: string, url?: string) => req({ "cf-connecting-ip": ip }, url);

function build(options: { trust?: IpTrust; redis?: FakeRedis | null; secret?: string } = {}) {
  const clock = makeClock(1_000_000);
  const redis = options.redis === undefined ? new FakeRedis(clock.now) : options.redis;
  const limiter = redis === null ? new MemoryRateLimiter(POLICY, clock.now) : new RedisRateLimiter({ client: redis, policy: POLICY });
  const logger = { warn: vi.fn() };
  const lines: string[] = [];
  const metrics = createAirMetrics((line) => lines.push(line));
  const gate = createRateLimitGate({ limiter, ipTrust: options.trust ?? "render", hashSecret: options.secret ?? SECRET, logger, metrics });
  return { gate, redis, logger, lines, metrics, clock };
}

const kinds = async (gate: ReturnType<typeof build>["gate"], make: () => Request, n: number) => {
  const out: GateDecision["kind"][] = [];
  for (let i = 0; i < n; i += 1) out.push((await gate(make())).kind);
  return out;
};

describe("rate-limit gate: decisions", () => {
  it("allows up to the limit, then limits", async () => {
    const { gate } = build();
    expect(await kinds(gate, () => fromIp("198.51.100.1"), 5)).toEqual(["allow", "allow", "allow", "limited", "limited"]);
  });

  it("limited decisions carry Retry-After information", async () => {
    const { gate } = build();
    for (let i = 0; i < 3; i += 1) await gate(fromIp("198.51.100.1"));
    const decision = await gate(fromIp("198.51.100.1"));
    expect(decision).toMatchObject({ kind: "limited", retryAfterSeconds: 60, result: { allowed: false, limit: 3, remaining: 0 } });
  });

  it("allowed decisions permit upstream refreshes", async () => {
    const decision = await build().gate(fromIp("198.51.100.1"));
    expect(decision).toMatchObject({ kind: "allow", allowUpstream: true, result: { limit: 3, remaining: 2 } });
  });

  it("gives each client its own allowance", async () => {
    const { gate } = build();
    expect(await kinds(gate, () => fromIp("198.51.100.1"), 4)).toContain("limited");
    expect((await gate(fromIp("198.51.100.2"))).kind).toBe("allow");
  });

  it("resets after the window", async () => {
    const { gate, redis, clock } = build();
    await kinds(gate, () => fromIp("198.51.100.1"), 4);
    clock.advance(61_000);
    expect(redis).not.toBeNull();
    expect((await gate(fromIp("198.51.100.1"))).kind).toBe("allow");
  });
});

describe("rate-limit gate: the key never depends on the URL (no bypass through query parameters)", () => {
  it("shares one allowance across different cities, parameters and URLs", async () => {
    const { gate } = build();
    const urls = [
      "http://localhost/api/air?cityId=mumbai",
      "http://localhost/api/air?cityId=patna",
      "http://localhost/api/air?cityId=mumbai&x=1",
      "http://localhost/api/air?cityId=mumbai&x=2",
      "http://localhost/api/air?cityId=mumbai&cb=" + Math.random(),
    ];
    const decisions: string[] = [];
    for (const url of urls) decisions.push((await gate(fromIp("198.51.100.1", url))).kind);
    expect(decisions).toEqual(["allow", "allow", "allow", "limited", "limited"]);
  });
});

describe("rate-limit gate: client identification and spoofing", () => {
  it("without Render trust (trust none), a spoofed X-Forwarded-For cannot dodge the limit by rotating", async () => {
    const { gate } = build({ trust: "none" });
    const decisions: string[] = [];
    for (let i = 0; i < 6; i += 1) decisions.push((await gate(req({ "x-forwarded-for": `203.0.113.${i + 1}` }))).kind);
    expect(decisions).toEqual(["allow", "allow", "allow", "limited", "limited", "limited"]);
  });

  it("on Render, rotating a client-supplied X-Forwarded-For does nothing when CF-Connecting-IP is fixed", async () => {
    const { gate } = build({ trust: "render" });
    const decisions: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      decisions.push((await gate(req({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": `203.0.113.${i + 1}` }))).kind);
    }
    expect(decisions).toEqual(["allow", "allow", "allow", "limited", "limited"]);
  });

  it("with no usable identifier, clients share one bucket: limited, never unlimited", async () => {
    const { gate, redis } = build({ trust: "render" });
    const decisions = await kinds(gate, () => req(), 5);
    expect(decisions).toEqual(["allow", "allow", "allow", "limited", "limited"]);
    expect(redis?.keys()).toEqual([`air:v1:rl:${UNIDENTIFIED_BUCKET}`]);
  });

  it("counts the missing-identifier event and logs it at most once", async () => {
    const { gate, logger, metrics } = build({ trust: "none" });
    for (let i = 0; i < 4; i += 1) await gate(req());
    expect(metrics.snapshot().client_identifier_unavailable).toBe(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("air.client_identifier_unavailable", { kind: "none" });
  });

  it("groups an IPv6 client by /64", async () => {
    const { gate } = build();
    const addresses = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:aaaa::3", "2001:db8:1:2::4"];
    const decisions: string[] = [];
    for (const ip of addresses) decisions.push((await gate(fromIp(ip))).kind);
    expect(decisions).toEqual(["allow", "allow", "allow", "limited"]);
  });
});

describe("rate-limit gate: client identifiers are hashed before use", () => {
  it("never puts an IP address in a Redis key", async () => {
    const { gate, redis } = build();
    await gate(fromIp("198.51.100.77"));
    await gate(fromIp("2001:db8:aaaa:bbbb::1"));
    for (const key of redis?.keys() ?? []) {
      expect(key).toMatch(/^air:v1:rl:c:[0-9a-f]{32}$/);
      expect(key).not.toContain("198");
      expect(key).not.toContain("2001");
    }
    expect(redis?.keys()).toHaveLength(2);
  });

  it("hashes with a keyed hash, so Redis keys cannot be brute-forced back to an IPv4 address", () => {
    const plain = createHash("sha256").update("v4:198.51.100.77").digest("hex").slice(0, 32);
    expect(hashClientKey("v4:198.51.100.77", SECRET)).not.toBe(plain);
    expect(hashClientKey("v4:198.51.100.77", SECRET)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for one secret (so every instance agrees) and different for another", () => {
    expect(hashClientKey("v4:1.2.3.4", SECRET)).toBe(hashClientKey("v4:1.2.3.4", SECRET));
    expect(hashClientKey("v4:1.2.3.4", SECRET)).not.toBe(hashClientKey("v4:1.2.3.4", "another-secret"));
    expect(hashClientKey("v4:1.2.3.4", SECRET)).not.toBe(hashClientKey("v4:1.2.3.5", SECRET));
  });

  it("makes separate instances sharing a secret and Redis count one client together", async () => {
    const clock = makeClock(1_000_000);
    const redis = new FakeRedis(clock.now);
    const a = build({ redis }).gate;
    const b = build({ redis }).gate;
    const decisions: string[] = [];
    for (let i = 0; i < 5; i += 1) decisions.push((await (i % 2 === 0 ? a : b)(fromIp("198.51.100.1"))).kind);
    expect(decisions).toEqual(["allow", "allow", "allow", "limited", "limited"]);
  });

  it("never logs or counts a raw IP address", async () => {
    const { gate, logger, lines, redis } = build();
    redis!.down = "timeout";
    await gate(fromIp("198.51.100.77"));
    redis!.down = null;
    for (let i = 0; i < 5; i += 1) await gate(fromIp("198.51.100.77"));
    const everything = JSON.stringify([logger.warn.mock.calls, lines]);
    expect(everything).not.toContain("198.51.100.77");
    expect(everything).not.toContain("198.51");
  });
});

describe("rate-limit gate: when Redis cannot be used", () => {
  it("returns degraded (no upstream refresh), never allow, for every failure type", async () => {
    for (const kind of ["timeout", "network", "auth", "http"] as const) {
      const { gate, redis } = build();
      redis!.down = kind;
      expect(await gate(fromIp("198.51.100.1"))).toEqual({ kind: "degraded", allowUpstream: false });
    }
  });

  it("stays degraded for as long as Redis is down: there is no fail-open path", async () => {
    const { gate, redis } = build();
    redis!.down = "timeout";
    expect(await kinds(gate, () => fromIp("198.51.100.1"), 50)).toEqual(Array(50).fill("degraded"));
  });

  it("recovers by itself when Redis comes back", async () => {
    const { gate, redis } = build();
    redis!.down = "network";
    expect((await gate(fromIp("198.51.100.1"))).kind).toBe("degraded");
    redis!.down = null;
    expect((await gate(fromIp("198.51.100.1"))).kind).toBe("allow");
  });

  it("counts the failure, and logs it at most once, without detail", async () => {
    const { gate, redis, metrics, logger } = build();
    redis!.down = "auth";
    for (let i = 0; i < 5; i += 1) await gate(fromIp("198.51.100.1"));
    expect(metrics.snapshot().rate_limit_degraded).toBe(5);
    expect(metrics.snapshot().redis_failure).toBe(5);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("air.rate_limiter_unavailable", { kind: "auth" });
  });

  it("treats an unexpected limiter error as degraded too", async () => {
    const gate = createRateLimitGate({
      limiter: { check: () => Promise.reject(new Error("boom")) },
      ipTrust: "render",
      hashSecret: SECRET,
    });
    expect(await gate(fromIp("198.51.100.1"))).toEqual({ kind: "degraded", allowUpstream: false });
  });

  it("counts rate-limit rejections", async () => {
    const { gate, metrics } = build();
    await kinds(gate, () => fromIp("198.51.100.1"), 6);
    expect(metrics.snapshot().rate_limit_rejection).toBe(3);
  });
});

describe("rate-limit gate with the in-memory limiter (no Redis configured)", () => {
  it("limits per instance", async () => {
    const { gate } = build({ redis: null });
    expect(await kinds(gate, () => fromIp("198.51.100.1"), 4)).toEqual(["allow", "allow", "allow", "limited"]);
  });
});
