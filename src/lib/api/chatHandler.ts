import { chatRequestSchema } from "@/lib/ai/chatSchema";
import type { ChatEnvelope } from "@/lib/ai/chatTypes";
import type { ChatService } from "@/lib/ai/chatService";
import { consoleAirLogger, type AirService } from "@/lib/data/airService";
import { describeIssues, generateRecommendations, type RecommendationResult } from "@/lib/engine";
import type { GateDecision, RateLimitGate } from "@/lib/ratelimit/gate";
import type { NormalizedAirData } from "@/types/air";

import { rateLimitedResponse } from "./airHandler";

/**
 * Request handling for POST /api/chat. Thin by design, in the same order as /api/recommend: validate,
 * rate-limit, fetch air data through the existing service, run the deterministic engine, then ask the
 * chat service to answer from that result.
 *
 * This is the only endpoint that accepts free text, so the input rules are the tightest:
 *  - `Content-Type: application/json`, body at most 8 KB;
 *  - exactly `{ cityId, profileId, message, history? }`, strictly validated: unknown keys are refused;
 *  - `message` is one question of at most 500 characters (whitespace collapsed, control characters
 *    refused) and `history` at most six earlier messages. They reach the model only inside labelled,
 *    untrusted blocks, and the answer is validated before it is returned.
 * Error bodies are fixed text: no stack traces, no upstream detail, no echo of what was submitted.
 */

export const MAX_BODY_BYTES = 8 * 1024;

export type ChatApiErrorCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "REQUEST_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ChatApiSuccess {
  readonly ok: true;
  readonly chat: ChatEnvelope;
}

export interface ChatApiError {
  readonly ok: false;
  readonly error: {
    readonly code: ChatApiErrorCode;
    readonly message: string;
    readonly issues?: readonly { readonly path: string; readonly message: string }[];
    readonly retryAfterSeconds?: number;
  };
}

export interface ChatHandlerOptions {
  /** Builds the per-client rate-limit gate for air data. Omitted: no rate limiting (unit tests only). */
  readonly getGate?: () => RateLimitGate;
  readonly getChat: () => ChatService;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

function fail(status: number, code: ChatApiErrorCode, message: string, issues?: ChatApiError["error"]["issues"]): Response {
  const body: ChatApiError = { ok: false, error: { code, message, ...(issues === undefined ? {} : { issues }) } };
  return Response.json(body, { status, headers: JSON_HEADERS });
}

async function readBody(request: Request): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: fail(413, "REQUEST_TOO_LARGE", "The request body is too large.") };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: fail(400, "INVALID_JSON", "The request body could not be read.") };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: fail(413, "REQUEST_TOO_LARGE", "The request body is too large.") };
  }
  return { ok: true, text };
}

export async function handleChatRequest(
  request: Request,
  getService: () => AirService,
  now: () => number,
  options: ChatHandlerOptions,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as application/json.");
  }

  const body = await readBody(request);
  if (!body.ok) return body.response;

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return fail(400, "INVALID_JSON", "The request body is not valid JSON.");
  }

  const parsed = chatRequestSchema.safeParse(json);
  if (!parsed.success) {
    // Only field paths and fixed messages: the submitted text is never echoed.
    return fail(400, "INVALID_REQUEST", "The request is not valid. See the listed fields.", describeIssues(parsed.error));
  }
  const { cityId, profileId, message, history } = parsed.data;

  let decision: GateDecision | null = null;
  if (options.getGate !== undefined) {
    try {
      decision = await options.getGate()(request);
    } catch {
      consoleAirLogger.warn("chat.rate_limit_gate_failed", { cityId });
      return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
    }
    if (decision.kind === "limited") return rateLimitedResponse(decision);
  }
  const degraded = decision?.kind === "degraded";

  let result: RecommendationResult;
  let air: NormalizedAirData;
  try {
    air = await getService().getAirData(cityId, degraded ? { allowUpstream: false } : {});
    const outcome = generateRecommendations({ air, profileId, preferences: undefined, nowMs: now() });
    if (!outcome.ok) {
      consoleAirLogger.warn("chat.engine_rejected_validated_input", { cityId });
      return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
    }
    result = outcome.result;
  } catch {
    consoleAirLogger.warn("chat.failed", { cityId });
    return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
  }

  let chat: ChatEnvelope;
  try {
    chat = await options.getChat().answer({ request, result, air, message, history: history ?? [] });
  } catch {
    // The chat service never throws; this guards the wiring so a bug there returns a controlled error.
    consoleAirLogger.warn("chat.service_failed", { cityId });
    return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
  }

  const success: ChatApiSuccess = { ok: true, chat };
  return Response.json(success, { status: 200, headers: { ...JSON_HEADERS, "X-AI-Status": chat.status, "X-AI-Provider": chat.provider } });
}
