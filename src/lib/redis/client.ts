import "server-only";

import { BodyTooLargeError, isAbortError, readTextCapped } from "@/lib/http";

import type { RedisConfig } from "./config";
import { RedisError } from "./errors";
import { isRecord } from "./replies";

/**
 * Minimal client for the Upstash Redis REST API.
 * Protocol (https://upstash.com/docs/redis/features/restapi): POST the command as a
 * JSON array to the database URL with `Authorization: Bearer <token>`; the reply is
 * `{"result": ...}` or `{"error": "..."}`.
 *
 * Why not the official `@upstash/redis` SDK? Its defaults conflict with this
 * service's reliability rules, and neutralising them takes four overrides:
 *   - it retries failed requests (default 5 times, exponential backoff);
 *   - a plain AbortSignal that fires yields a fake successful `{result: null}`,
 *     so a timeout would masquerade as a cache miss;
 *   - its errors embed the whole command ("command was: ..."), which here
 *     contains cached data and keys;
 *   - it exposes no response-size cap or redirect refusal.
 * We use four commands (GET, SET ... EX, DEL, EVAL), so a thin client over the
 * documented protocol is smaller than the configuration the SDK would need, and
 * adds no dependency.
 *
 * Properties: one attempt per command (the callers own retry/fallback policy), a
 * hard timeout, redirects refused, a response-size cap, and errors that never
 * contain the URL, token, command or payload.
 */

export type RedisArg = string | number;

export interface RedisCommandClient {
  /** Run one Redis command and return its raw `result`. Throws `RedisError` on any failure. */
  command(args: readonly RedisArg[]): Promise<unknown>;
}

export type RedisFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RestClientOptions {
  /** Injectable for tests; defaults to global `fetch`. */
  readonly fetchImpl?: RedisFetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export const DEFAULT_REDIS_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function createUpstashRestClient(
  config: RedisConfig,
  options: RestClientOptions = {},
): RedisCommandClient {
  const fetchImpl: RedisFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async command(args) {
      let response: Response;
      try {
        response = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RedisError(isAbortError(error) ? "timeout" : "network");
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RedisError(response.status === 401 || response.status === 403 ? "auth" : "http", response.status);
      }

      let text: string;
      try {
        text = await readTextCapped(response, maxBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) throw new RedisError("too-large");
        throw new RedisError(isAbortError(error) ? "timeout" : "network");
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RedisError("protocol");
      }
      if (!isRecord(body)) throw new RedisError("protocol");

      // An `error` member of any type means the command did not succeed, even if a `result` is also present.
      if ("error" in body) {
        // Keep only a coarse class; the message itself can echo command arguments.
        if (typeof body.error !== "string") throw new RedisError("protocol");
        throw new RedisError(/^(WRONGPASS|NOAUTH)\b/.test(body.error) ? "auth" : "command");
      }
      if (!("result" in body)) throw new RedisError("protocol");
      return body.result;
    },
  };
}
