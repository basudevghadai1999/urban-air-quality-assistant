import "server-only";

import { createHash } from "node:crypto";

import type { SafeLogger } from "@/lib/observability/logger";
import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import type { RedisCommandClient } from "@/lib/redis";
import { isRedisError } from "@/lib/redis/errors";

import type { AiExplanation } from "./types";

/**
 * Cache of VALIDATED explanations.
 *
 * Key: SHA-256 of (prompt version, provider, model, the exact grounding context sent to the model).
 * The context carries the profile, city, resolved preferences, recommendations and the data timestamp. The context
 * holds every number, time and recommendation, so the key changes whenever the air data, the profile,
 * the preferences or any recommendation changes, and a stale explanation can never be reused for new
 * data. It contains no API key or personal secret (the context has none).
 *
 * Only fully validated explanations are written. On a read the entry is validated AGAIN against the
 * current request (`accept`), so a poisoned or outdated Redis value is dropped, never served.
 * Redis failures only cost a cache miss.
 */

export const AI_CACHE_KEY_PREFIX = "ai:v1:expl:";
const MAX_MEMORY_ENTRIES = 200;
const MAX_PAYLOAD_CHARS = 24_000;
const ENTRY_VERSION = 1;

export function aiCacheKey(parts: { readonly promptVersion: string; readonly provider: string; readonly model: string; readonly contextJson: string }): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ v: parts.promptVersion, p: parts.provider, m: parts.model, c: parts.contextJson }))
    .digest("hex");
  return `${AI_CACHE_KEY_PREFIX}${hash}`;
}

const KEY_PATTERN = /^ai:v1:expl:[0-9a-f]{64}$/;

/** Returns the validated explanation, or null to reject the candidate. */
export type Accept = (candidate: unknown) => AiExplanation | null;

export interface AiCache {
  get(key: string, accept: Accept): Promise<AiExplanation | null>;
  set(key: string, explanation: AiExplanation): Promise<void>;
}

export interface AiCacheOptions {
  readonly ttlSeconds: number;
  readonly client?: RedisCommandClient | null;
  readonly now?: () => number;
  readonly logger?: SafeLogger;
  readonly metrics?: AirMetrics;
}

export function createAiCache(options: AiCacheOptions): AiCache {
  const now = options.now ?? (() => Date.now());
  const client = options.client ?? null;
  const metrics = options.metrics ?? noopMetrics;
  const memory = new Map<string, { explanation: AiExplanation; expiresAtMs: number }>();

  const remember = (key: string, explanation: AiExplanation) => {
    memory.delete(key);
    memory.set(key, { explanation, expiresAtMs: now() + options.ttlSeconds * 1000 });
    while (memory.size > MAX_MEMORY_ENTRIES) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
    }
  };

  const redisFailed = (error: unknown) => {
    metrics.increment("redis_failure", { layer: "ai-cache", kind: isRedisError(error) ? error.kind : "unexpected" });
  };

  return {
    async get(key, accept) {
      if (!KEY_PATTERN.test(key)) return null;

      const local = memory.get(key);
      if (local !== undefined) {
        if (local.expiresAtMs > now()) {
          const checked = accept(local.explanation);
          if (checked !== null) return checked;
        }
        memory.delete(key);
      }
      if (client === null) return null;

      let raw: unknown;
      try {
        raw = await client.command(["GET", key]);
      } catch (error) {
        redisFailed(error);
        return null;
      }
      if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PAYLOAD_CHARS) return null;

      let explanation: AiExplanation | null = null;
      try {
        const payload = JSON.parse(raw) as { v?: unknown; explanation?: unknown };
        if (payload.v === ENTRY_VERSION) explanation = accept(payload.explanation);
      } catch {
        explanation = null;
      }
      if (explanation === null) {
        // Corrupt, poisoned or no longer valid for this request: discard it, best effort.
        try {
          await client.command(["DEL", key]);
        } catch (error) {
          redisFailed(error);
        }
        return null;
      }
      remember(key, explanation);
      return explanation;
    },

    async set(key, explanation) {
      if (!KEY_PATTERN.test(key)) return;
      remember(key, explanation);
      if (client === null) return;
      const payload = JSON.stringify({ v: ENTRY_VERSION, storedAtMs: now(), explanation });
      if (payload.length > MAX_PAYLOAD_CHARS) return;
      try {
        await client.command(["SET", key, payload, "EX", options.ttlSeconds]);
      } catch (error) {
        redisFailed(error);
      }
    },
  };
}
