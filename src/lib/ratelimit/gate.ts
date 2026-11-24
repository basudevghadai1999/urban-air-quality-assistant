import "server-only";

import { createHmac } from "node:crypto";

import { silentLogger, type SafeLogger } from "@/lib/observability/logger";
import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { isRedisError } from "@/lib/redis/errors";

import { identityFromHeaders, type IpTrust } from "./clientIp";
import type { RateLimiter, RateLimitResult } from "./types";

/**
 * The per-request rate-limit decision for /api/air.
 *
 *   allow     counted, under the limit        -> serve normally
 *   limited   over the limit                  -> HTTP 429 with Retry-After; nothing else is done
 *   degraded  the limiter could not decide    -> upstream refreshes are NOT allowed. The caller
 *             may serve already-cached data, but must not call the provider, and must answer 503
 *             for anything it cannot serve from cache. A limiter failure is never "allowed".
 *
 * What is counted: every request that passed input validation, including cache hits,
 * keyed by the CLIENT only (never the URL or query), so varying parameters cannot
 * create fresh buckets. Rejected (400) requests are not counted: they do no work.
 *
 * Privacy: the client's address is never logged or stored. It is reduced to a keyed
 * hash (HMAC-SHA256, truncated), so Redis keys cannot be reversed back to an IP by
 * someone who can read Redis; a plain hash of an IPv4 address could be brute-forced.
 */

export type GateDecision =
  | { readonly kind: "allow"; readonly allowUpstream: true; readonly result: RateLimitResult }
  | { readonly kind: "limited"; readonly result: RateLimitResult; readonly retryAfterSeconds: number }
  | { readonly kind: "degraded"; readonly allowUpstream: false };

export type RateLimitGate = (request: Request) => Promise<GateDecision>;

export interface GateOptions {
  readonly limiter: RateLimiter;
  readonly ipTrust: IpTrust;
  /** Secret key for hashing client identifiers. */
  readonly hashSecret: string;
  readonly logger?: SafeLogger;
  readonly metrics?: AirMetrics;
}

/** Clients that cannot be told apart share this bucket: safe (never unlimited), if blunt. */
export const UNIDENTIFIED_BUCKET = "shared";

const IDENTIFIER_LOG_INTERVAL_MS = 60_000;

/** Keyed hash of a client identifier: 32 hex characters. */
export function hashClientKey(identifier: string, secret: string): string {
  return createHmac("sha256", secret).update(identifier).digest("hex").slice(0, 32);
}

export function createRateLimitGate(options: GateOptions): RateLimitGate {
  const { limiter, ipTrust, hashSecret } = options;
  const logger = options.logger ?? silentLogger;
  const metrics = options.metrics ?? noopMetrics;
  let lastIdentifierLogMs = Number.NEGATIVE_INFINITY;
  let lastFailureLogMs = Number.NEGATIVE_INFINITY;

  return async (request) => {
    const { identifier } = identityFromHeaders(request.headers, ipTrust);

    let key: string;
    if (identifier === null) {
      key = UNIDENTIFIED_BUCKET;
      metrics.increment("client_identifier_unavailable", { kind: ipTrust });
      const nowMs = Date.now();
      if (nowMs - lastIdentifierLogMs >= IDENTIFIER_LOG_INTERVAL_MS) {
        lastIdentifierLogMs = nowMs;
        logger.warn("air.client_identifier_unavailable", { kind: ipTrust });
      }
    } else {
      key = `c:${hashClientKey(identifier, hashSecret)}`;
    }

    let result: RateLimitResult;
    try {
      result = await limiter.check(key);
    } catch (error) {
      const kind = isRedisError(error) ? error.kind : "unexpected";
      metrics.increment("rate_limit_degraded", { kind });
      if (isRedisError(error)) metrics.increment("redis_failure", { layer: "ratelimit", kind });
      const nowMs = Date.now();
      if (nowMs - lastFailureLogMs >= IDENTIFIER_LOG_INTERVAL_MS) {
        lastFailureLogMs = nowMs;
        logger.warn("air.rate_limiter_unavailable", { kind });
      }
      return { kind: "degraded", allowUpstream: false };
    }

    if (!result.allowed) {
      metrics.increment("rate_limit_rejection");
      return { kind: "limited", result, retryAfterSeconds: result.resetSeconds };
    }
    return { kind: "allow", allowUpstream: true, result };
  };
}
