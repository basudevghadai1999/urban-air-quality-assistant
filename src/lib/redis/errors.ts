/**
 * Redis failures. The message is FIXED text per kind: it never contains the
 * endpoint URL, the token, the command, a key or a value, and neither does
 * `detail`. Upstash error strings are deliberately discarded, because a failing
 * command's text can echo its arguments (cached data, keys).
 */

export type RedisErrorKind =
  | "timeout"
  | "network"
  | "auth"
  | "http"
  | "command"
  | "protocol"
  | "too-large";

const MESSAGES: Record<RedisErrorKind, string> = {
  timeout: "The Redis request timed out.",
  network: "The Redis service could not be reached.",
  auth: "The Redis service rejected the credentials.",
  http: "The Redis service returned an unexpected HTTP status.",
  command: "The Redis service reported an error for a command.",
  protocol: "The Redis service returned a response in an unexpected format.",
  "too-large": "The Redis response was larger than allowed.",
};

export class RedisError extends Error {
  readonly kind: RedisErrorKind;
  /** HTTP status, when the failure was an HTTP one. */
  readonly status: number | undefined;

  constructor(kind: RedisErrorKind, status?: number) {
    super(MESSAGES[kind]);
    this.name = "RedisError";
    this.kind = kind;
    this.status = status;
  }
}

export function isRedisError(error: unknown): error is RedisError {
  return error instanceof RedisError;
}
