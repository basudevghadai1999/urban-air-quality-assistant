/**
 * Errors from the Open-Meteo integration.
 *
 * Each error has a stable `code` and a SAFE `publicMessage`. `detail` is for
 * server-side logs only and never contains response bodies, provider `reason`
 * strings, URLs or secrets. Nothing here is ever forwarded to a client.
 */

export type OpenMeteoErrorCode =
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_NETWORK"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_SERVER_ERROR"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "UNKNOWN_CITY";

export interface OpenMeteoErrorOptions {
  /** HTTP status from the provider, when there was one. */
  readonly status?: number;
  /** Parsed `Retry-After`, in seconds, bounded to a sane maximum. */
  readonly retryAfterSeconds?: number;
  /** Server-side diagnostics only. Must not contain provider response text. */
  readonly detail?: string;
}

export class OpenMeteoError extends Error {
  readonly code: OpenMeteoErrorCode;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly detail: string | undefined;

  constructor(code: OpenMeteoErrorCode, options: OpenMeteoErrorOptions = {}) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "OpenMeteoError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail;
  }

  /** The only text that may be shown to a user. */
  get publicMessage(): string {
    return PUBLIC_MESSAGES[this.code];
  }
}

const PUBLIC_MESSAGES: Record<OpenMeteoErrorCode, string> = {
  UPSTREAM_TIMEOUT: "The air quality provider did not respond in time.",
  UPSTREAM_NETWORK: "The air quality provider could not be reached.",
  UPSTREAM_RATE_LIMITED: "The air quality provider is limiting requests right now.",
  UPSTREAM_REJECTED: "The air quality provider rejected the request.",
  UPSTREAM_SERVER_ERROR: "The air quality provider is having problems.",
  UPSTREAM_HTTP: "The air quality provider returned an unexpected response.",
  UPSTREAM_TOO_LARGE: "The air quality provider returned an unexpectedly large response.",
  UPSTREAM_INVALID_RESPONSE: "The air quality provider returned data in an unexpected format.",
  UNKNOWN_CITY: "That city is not supported.",
};

export function isOpenMeteoError(error: unknown): error is OpenMeteoError {
  return error instanceof OpenMeteoError;
}
