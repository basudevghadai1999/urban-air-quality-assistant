import { BodyTooLargeError, readTextCapped } from "@/lib/http";
import { consoleSafeLogger } from "@/lib/observability/logger";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { AirApiErrorCode } from "@/types/air";
import type { ApiIssue, ChatApiErrorCode, RecommendApiErrorCode } from "@/types/api";

/**
 * Behavior shared by the API handlers (`/api/air`, `/api/recommend`, `/api/chat`): the JSON error
 * envelope, bounded JSON request parsing and the rate-limit gate. Each handler keeps its own
 * validation, messages and response bodies; only what was identical lives here.
 */

/** A request body is read through a counter that stops at this many bytes. */
export const MAX_BODY_BYTES = 8 * 1024;

export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

const LIMITER_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;
const DATA_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

/** `Retry-After` for a 503: shorter when the limiter (not the provider) was the reason. */
export const unavailableRetryAfterSeconds = (degraded: boolean): number =>
  degraded ? LIMITER_UNAVAILABLE_RETRY_AFTER_SECONDS : DATA_UNAVAILABLE_RETRY_AFTER_SECONDS;

/** Every code any endpoint may send. Each client validator accepts exactly its own endpoint's list. */
export type ApiErrorCode = AirApiErrorCode | RecommendApiErrorCode | ChatApiErrorCode;

export interface ErrorExtras {
  readonly validCityIds?: readonly string[];
  readonly issues?: readonly ApiIssue[];
  readonly retryAfterSeconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** `{ ok: false, error: { code, message, ... } }`, never cached. Messages are fixed text. */
export function errorResponse(status: number, code: ApiErrorCode, message: string, extra: ErrorExtras = {}): Response {
  const body = {
    ok: false,
    error: {
      code,
      message,
      ...(extra.validCityIds === undefined ? {} : { validCityIds: extra.validCityIds }),
      ...(extra.issues === undefined ? {} : { issues: extra.issues }),
      ...(extra.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: extra.retryAfterSeconds }),
    },
  };
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...extra.headers } });
}

export type JsonBodyResult = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly response: Response };

/**
 * Parse a JSON request body: `application/json` only, at most `maxBytes`. The limit is enforced while
 * the stream is consumed (a declared Content-Length is only a fast first check), so a chunked body
 * without a length is cut off, and cancelled, as soon as it passes the limit.
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, response: errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as application/json.") };
  }

  let text: string;
  try {
    text = await readTextCapped(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: errorResponse(413, "REQUEST_TOO_LARGE", "The request body is too large.") };
    }
    return { ok: false, response: errorResponse(400, "INVALID_JSON", "The request body could not be read.") };
  }

  try {
    const json: unknown = JSON.parse(text);
    return { ok: true, json };
  } catch {
    return { ok: false, response: errorResponse(400, "INVALID_JSON", "The request body is not valid JSON.") };
  }
}

export type GateOutcome =
  | { readonly kind: "blocked"; readonly response: Response }
  /** `degraded`: the limiter could not decide, so the caller must serve cached data only. */
  | { readonly kind: "proceed"; readonly degraded: boolean };

/**
 * Run the per-client gate. Limited -> a 429 with `Retry-After`. A gate that throws (for example an
 * invalid rate-limit setting) -> the caller's 500, never an unprotected request. No gate -> proceed.
 */
export async function applyRateLimit(
  request: Request,
  getGate: (() => RateLimitGate) | undefined,
  onFailure: { readonly event: string; readonly cityId: string; readonly response: () => Response },
): Promise<GateOutcome> {
  if (getGate === undefined) return { kind: "proceed", degraded: false };

  let decision;
  try {
    decision = await getGate()(request);
  } catch {
    consoleSafeLogger.warn(onFailure.event, { cityId: onFailure.cityId });
    return { kind: "blocked", response: onFailure.response() };
  }

  if (decision.kind === "limited") {
    const { result, retryAfterSeconds } = decision;
    return {
      kind: "blocked",
      response: errorResponse(429, "RATE_LIMITED", "Too many requests. Please wait before trying again.", {
        retryAfterSeconds,
        headers: {
          "Retry-After": String(retryAfterSeconds),
          "RateLimit-Limit": String(result.limit),
          "RateLimit-Remaining": "0",
          "RateLimit-Reset": String(result.resetSeconds),
        },
      }),
    };
  }
  return { kind: "proceed", degraded: decision.kind === "degraded" };
}
