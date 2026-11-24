/**
 * Redis connection settings: validation only. Pure, so it can be unit-tested
 * without an environment; `getRedisConfig` in `src/lib/env.ts` feeds it.
 *
 * These come ONLY from server environment variables, never from a request, so a
 * caller cannot point the server at an arbitrary Redis or HTTP endpoint.
 */

export interface RedisConfig {
  readonly url: string;
  readonly token: string;
}

export type RedisConfigProblem = "url" | "token";

export type RedisConfigResult =
  | { readonly ok: true; readonly config: RedisConfig }
  | { readonly ok: false; readonly problem: RedisConfigProblem };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_TOKEN_LENGTH = 512;
/** Base64/URL-safe characters only: keeps control characters out of the Authorization header. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Accept an https URL (Upstash endpoints), or http only for a local development
 * proxy. Reject credentials, query strings and fragments in the URL: the token
 * belongs in the Authorization header, never in a URL that could be logged.
 */
export function parseRedisConfig(rawUrl: string, rawToken: string): RedisConfigResult {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, problem: "url" };
  }

  const isLocalHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) return { ok: false, problem: "url" };
  if (url.username !== "" || url.password !== "") return { ok: false, problem: "url" };
  if (url.search !== "" || url.hash !== "") return { ok: false, problem: "url" };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, problem: "url" };

  const token = rawToken.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    return { ok: false, problem: "token" };
  }

  return { ok: true, config: { url: url.origin, token } };
}
