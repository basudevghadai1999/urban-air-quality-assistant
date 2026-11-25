import type { AiReasonCode } from "./errors";
import type { AiProviderName } from "./types";

/**
 * Public contract of the chat assistant. Client-safe (types and constants only).
 *
 * The answer is PROSE ONLY, written from the server-built context for the selected city and profile.
 * Render it as PLAIN TEXT.
 *
 *   generated    a model wrote it and it passed every check
 *   fallback     built by deterministic code from the recommendation result (the model was unavailable,
 *                limited, slow, or its answer was rejected)
 *   unavailable  no answer could be produced at all (answer is null)
 */

export const CHAT_LIMITS = {
  /** Characters in one user question, after whitespace is collapsed. */
  messageMax: 500,
  /** Earlier messages a request may carry, oldest first. */
  historyMax: 6,
  historyTextMax: 900,
  answerMax: 900,
} as const;

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  readonly role: ChatRole;
  readonly text: string;
}

export const CHAT_STATUSES = ["generated", "fallback", "unavailable"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export interface ChatEnvelope {
  readonly status: ChatStatus;
  readonly answer: string | null;
  /** Why the model's answer is not being shown. Null for `generated`. */
  readonly reasonCode: AiReasonCode | null;
  /** Safe, user-readable. */
  readonly message: string;
  readonly provider: AiProviderName;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly retryAfterSeconds?: number;
}
