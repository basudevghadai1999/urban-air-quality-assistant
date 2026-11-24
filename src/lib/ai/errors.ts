/**
 * Failure taxonomy for the Gemini explanation layer.
 *
 * Every way the layer can fail maps to ONE sanitized reason code and ONE fixed, user-readable
 * message. Raw provider errors never reach a client, a log or a metric: the SDK's `ApiError`
 * message can contain the provider's response text, so it is classified and then discarded.
 *
 * This file imports nothing from the SDK (classification is by shape), so it is client-safe
 * and the types can be shared with the future dashboard.
 */

export const AI_REASON_CODES = [
  "AI_DISABLED",
  "AI_NOT_CONFIGURED",
  "AI_INVALID_CONFIG",
  "AI_AIR_DATA_UNAVAILABLE",
  "AI_INPUT_TOO_LARGE",
  "AI_RATE_LIMITED",
  "AI_PROTECTION_UNAVAILABLE",
  "AI_BUDGET_EXHAUSTED",
  "AI_TIMEOUT",
  "AI_QUOTA",
  "AI_AUTH_FAILED",
  "AI_MODEL_UNAVAILABLE",
  "AI_BAD_REQUEST",
  "AI_UPSTREAM_ERROR",
  "AI_NETWORK",
  "AI_SAFETY_BLOCKED",
  "AI_EMPTY_RESPONSE",
  "AI_TRUNCATED",
  "AI_INVALID_JSON",
  "AI_SCHEMA_INVALID",
  "AI_VALIDATION_REJECTED",
  "AI_INTERNAL",
] as const;

export type AiReasonCode = (typeof AI_REASON_CODES)[number];

/** Shown to users. Fixed text: never derived from a provider message. */
export const AI_REASON_MESSAGES: Readonly<Record<AiReasonCode, string>> = {
  AI_DISABLED: "AI explanations are switched off. The recommendations below come from the built-in rules.",
  AI_NOT_CONFIGURED: "AI explanations are not set up on this server. The recommendations below come from the built-in rules.",
  AI_INVALID_CONFIG: "AI explanations are misconfigured on this server. The recommendations below come from the built-in rules.",
  AI_AIR_DATA_UNAVAILABLE: "There is no air quality data to explain right now, so a general explanation is shown.",
  AI_INPUT_TOO_LARGE: "This result was too large to send for an AI explanation. A standard explanation is shown.",
  AI_RATE_LIMITED: "You have requested AI explanations too quickly. A standard explanation is shown; try again shortly.",
  AI_PROTECTION_UNAVAILABLE: "AI explanations are paused because usage limits cannot be checked right now. A standard explanation is shown.",
  AI_BUDGET_EXHAUSTED: "Today's AI explanation allowance has been used. A standard explanation is shown; AI explanations resume tomorrow (UTC).",
  AI_TIMEOUT: "The AI explanation took too long. A standard explanation is shown.",
  AI_QUOTA: "The AI service is busy or over its quota. A standard explanation is shown.",
  AI_AUTH_FAILED: "The AI service rejected this server's credentials. A standard explanation is shown.",
  AI_MODEL_UNAVAILABLE: "The configured AI model is not available. A standard explanation is shown.",
  AI_BAD_REQUEST: "The AI service could not process the request. A standard explanation is shown.",
  AI_UPSTREAM_ERROR: "The AI service had a problem. A standard explanation is shown.",
  AI_NETWORK: "The AI service could not be reached. A standard explanation is shown.",
  AI_SAFETY_BLOCKED: "The AI service declined to answer. A standard explanation is shown.",
  AI_EMPTY_RESPONSE: "The AI service returned no explanation. A standard explanation is shown.",
  AI_TRUNCATED: "The AI explanation was cut short and was discarded. A standard explanation is shown.",
  AI_INVALID_JSON: "The AI explanation was malformed and was discarded. A standard explanation is shown.",
  AI_SCHEMA_INVALID: "The AI explanation did not have the expected structure and was discarded. A standard explanation is shown.",
  AI_VALIDATION_REJECTED: "The AI explanation failed safety checks and was discarded. A standard explanation is shown.",
  AI_INTERNAL: "AI explanations hit an unexpected problem. A standard explanation is shown.",
};

/** A failure inside the layer, carrying only a reason code. */
export class AiError extends Error {
  readonly code: AiReasonCode;
  constructor(code: AiReasonCode) {
    super(AI_REASON_MESSAGES[code]);
    this.name = "AiError";
    this.code = code;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}

interface ErrorLike {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly code?: unknown;
  readonly cause?: unknown;
}

function asLike(value: unknown): ErrorLike | null {
  return typeof value === "object" && value !== null ? (value as ErrorLike) : null;
}

/**
 * Classify anything thrown while calling Gemini. Only the HTTP status and the error's name or code
 * are read; the message is never used. Unknown errors are treated as network failures.
 */
export function classifyGeminiError(error: unknown): AiReasonCode {
  if (isAiError(error)) return error.code;
  const e = asLike(error);
  if (e === null) return "AI_NETWORK";

  if (typeof e.status === "number") {
    const status = e.status;
    if (status === 429) return "AI_QUOTA";
    if (status === 401 || status === 403) return "AI_AUTH_FAILED";
    if (status === 404) return "AI_MODEL_UNAVAILABLE";
    if (status === 408) return "AI_TIMEOUT";
    if (status >= 500) return "AI_UPSTREAM_ERROR";
    if (status >= 400) return "AI_BAD_REQUEST";
  }

  const name = typeof e.name === "string" ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "AI_TIMEOUT";
  const cause = asLike(e.cause);
  if (cause !== null && (cause.name === "AbortError" || cause.name === "TimeoutError")) return "AI_TIMEOUT";
  if (typeof e.code === "string" && /^(ETIMEDOUT|UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT)$/.test(e.code)) return "AI_TIMEOUT";
  return "AI_NETWORK";
}

/** Provider-neutral name for the same classification (Gemini SDK errors and Groq HTTP errors both expose `status`). */
export const classifyProviderError = classifyGeminiError;

/**
 * Failures after which the NEXT configured provider may be tried. Everything else ends the chain at
 * the deterministic fallback.
 *
 * Eligible: the provider itself is unavailable or unusable, or it produced output we cannot use.
 *   AI_TIMEOUT, AI_QUOTA (429), AI_UPSTREAM_ERROR (5xx), AI_NETWORK, AI_MODEL_UNAVAILABLE (404),
 *   AI_AUTH_FAILED (this provider's key was refused; the other provider has its own key),
 *   AI_EMPTY_RESPONSE, AI_TRUNCATED, AI_INVALID_JSON, AI_SCHEMA_INVALID (malformed output),
 *   AI_VALIDATION_REJECTED (output failed the grounding/safety checks; the same checks gate the next
 *   provider, so a rejected output is never shown).
 *
 * NOT eligible, because a second provider would not help or would be unsafe:
 *   AI_SAFETY_BLOCKED (a refusal is a decision, not an outage: it is not shopped around),
 *   AI_BAD_REQUEST (our request was malformed; resending it elsewhere repeats the bug),
 *   AI_INTERNAL (a programming error), and every pre-flight code (disabled, not configured, invalid
 *   config, no air data, input too large, rate limited, budget exhausted, protection unavailable),
 *   none of which come from a provider.
 */
const FAILOVER_ELIGIBLE: ReadonlySet<AiReasonCode> = new Set<AiReasonCode>([
  "AI_TIMEOUT",
  "AI_QUOTA",
  "AI_UPSTREAM_ERROR",
  "AI_NETWORK",
  "AI_MODEL_UNAVAILABLE",
  "AI_AUTH_FAILED",
  "AI_EMPTY_RESPONSE",
  "AI_TRUNCATED",
  "AI_INVALID_JSON",
  "AI_SCHEMA_INVALID",
  "AI_VALIDATION_REJECTED",
]);

export function isFailoverEligible(code: AiReasonCode): boolean {
  return FAILOVER_ELIGIBLE.has(code);
}
