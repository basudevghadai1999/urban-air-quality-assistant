import type { AiReasonCode } from "./errors";

/**
 * Public contract of the Gemini explanation layer. Client-safe (types only).
 *
 * The explanation is PROSE ONLY. Every number, time, ID and estimate in the response comes from the
 * deterministic result next to it, which this layer never modifies.
 */

export interface AiTopAction {
  /** A recommendation ID that exists in the deterministic result. */
  readonly recommendationId: string;
  readonly explanation: string;
  readonly practicalGuidance: string;
}

export interface AiExplanation {
  readonly overview: string;
  readonly situationExplanation: string;
  readonly personalizedSummary: string;
  readonly topActions: readonly AiTopAction[];
  readonly routineExplanation: string;
  readonly outdoorActivityExplanation: string;
  readonly indoorAirExplanation: string;
  readonly transportExplanation: string;
  readonly impactExplanation: string;
  readonly dataLimitations: readonly string[];
  readonly safetyDisclaimer: string;
}

/**
 *   generated    a model wrote it and it passed every check
 *   cached       a previously generated, validated explanation was reused (no model call)
 *   fallback     built by deterministic code from the recommendation result; the model's output, if any, was discarded
 *   unavailable  no explanation could be produced at all (explanation is null)
 *
 * Render every string in `explanation` as PLAIN TEXT.
 */
export type AiStatus = "generated" | "cached" | "fallback" | "unavailable";

/** Who wrote the explanation: a model provider, or the deterministic templates. */
export type AiProviderName = "gemini" | "groq" | "deterministic";

/** One provider that was tried (or skipped) before the result, with a sanitized reason code. */
export interface AiAttempt {
  readonly provider: "gemini" | "groq";
  readonly reasonCode: AiReasonCode;
}

export interface AiTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AiEnvelope {
  readonly status: AiStatus;
  /** Why the model's output is not being shown. Null for `generated` and `cached`. */
  readonly reasonCode: AiReasonCode | null;
  /** Safe, user-readable. */
  readonly message: string;
  readonly explanation: AiExplanation | null;
  /** `gemini` or `groq` for `generated` and `cached`; `deterministic` for `fallback` and `unavailable`. */
  readonly provider: AiProviderName;
  /** Present for `generated` and `cached`. */
  readonly model: string | null;
  /** Providers that failed or were skipped before this result, in order. Omitted when none. */
  readonly attempts?: readonly AiAttempt[];
  /** Provider-reported token counts for a `generated` result (null fields: not reported). */
  readonly tokenUsage?: AiTokenUsage;
  readonly promptVersion: string;
  /** Seconds to wait before asking again, when the cause is a rate limit or budget. */
  readonly retryAfterSeconds?: number;
  /** Always true: the numbers in the response are the engine's, never the model's. */
  readonly numbersFromEngine: true;
}
