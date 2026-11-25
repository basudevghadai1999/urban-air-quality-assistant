import type { ChatEnvelope } from "@/lib/ai/chatTypes";
import type { AiEnvelope } from "@/lib/ai/types";
import type { RecommendationResult } from "@/lib/engine";

/** Wire contracts of POST /api/recommend and POST /api/chat. (GET /api/air's live in `./air`.) */

/** A field at fault: its path and a fixed message, never the submitted value. */
export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

/** The one list of `/api/recommend` error codes: the type, the client validator and the tests derive from it. */
export const RECOMMEND_API_ERROR_CODES = [
  "UNSUPPORTED_MEDIA_TYPE",
  "REQUEST_TOO_LARGE",
  "INVALID_JSON",
  "INVALID_REQUEST",
  "RATE_LIMITED",
  "RATE_LIMITING_UNAVAILABLE",
  "AIR_DATA_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type RecommendApiErrorCode = (typeof RECOMMEND_API_ERROR_CODES)[number];

export interface RecommendApiSuccess {
  readonly ok: true;
  readonly data: RecommendationResult;
  /** Present only when the request set `explain: true`. Prose only: every number lives in `data`. */
  readonly ai?: AiEnvelope;
}

export interface RecommendApiError {
  readonly ok: false;
  readonly error: {
    readonly code: RecommendApiErrorCode;
    readonly message: string;
    readonly issues?: readonly ApiIssue[];
    readonly retryAfterSeconds?: number;
  };
  /** Present for AIR_DATA_UNAVAILABLE and RATE_LIMITING_UNAVAILABLE: the engine's explicit unavailable result. */
  readonly data?: RecommendationResult;
  readonly ai?: AiEnvelope;
}

/** The one list of `/api/chat` error codes: the type, the client validator and the tests derive from it. */
export const CHAT_API_ERROR_CODES = ["UNSUPPORTED_MEDIA_TYPE", "REQUEST_TOO_LARGE", "INVALID_JSON", "INVALID_REQUEST", "RATE_LIMITED", "INTERNAL_ERROR"] as const;
export type ChatApiErrorCode = (typeof CHAT_API_ERROR_CODES)[number];

export interface ChatApiSuccess {
  readonly ok: true;
  readonly chat: ChatEnvelope;
}

export interface ChatApiError {
  readonly ok: false;
  readonly error: {
    readonly code: ChatApiErrorCode;
    readonly message: string;
    readonly issues?: readonly ApiIssue[];
    readonly retryAfterSeconds?: number;
  };
}
