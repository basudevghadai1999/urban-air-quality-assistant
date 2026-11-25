import { chatRequestSchema } from "@/lib/ai/chatSchema";
import type { ChatEnvelope } from "@/lib/ai/chatTypes";
import type { ChatService } from "@/lib/ai/chatService";
import type { AirService } from "@/lib/data/airService";
import { consoleSafeLogger } from "@/lib/observability/logger";
import { describeIssues, generateRecommendations, type RecommendationResult } from "@/lib/engine";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { ApiIssue, ChatApiErrorCode, ChatApiSuccess } from "@/types/api";
import type { NormalizedAirData } from "@/types/air";

import { applyRateLimit, errorResponse, JSON_HEADERS, readJsonBody } from "./common";

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

export interface ChatHandlerOptions {
  /** Builds the per-client rate-limit gate for air data. Omitted: no rate limiting (unit tests only). */
  readonly getGate?: () => RateLimitGate;
  readonly getChat: () => ChatService;
}

const fail = (status: number, code: ChatApiErrorCode, message: string, issues?: readonly ApiIssue[]): Response =>
  errorResponse(status, code, message, issues === undefined ? {} : { issues });

export async function handleChatRequest(
  request: Request,
  getService: () => AirService,
  now: () => number,
  options: ChatHandlerOptions,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const json = body.json;

  const parsed = chatRequestSchema.safeParse(json);
  if (!parsed.success) {
    // Only field paths and fixed messages: the submitted text is never echoed.
    return fail(400, "INVALID_REQUEST", "The request is not valid. See the listed fields.", describeIssues(parsed.error));
  }
  const { cityId, profileId, message, history } = parsed.data;

  const gate = await applyRateLimit(request, options.getGate, {
    event: "chat.rate_limit_gate_failed",
    cityId,
    response: () => fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem."),
  });
  if (gate.kind === "blocked") return gate.response;
  const { degraded } = gate;

  let result: RecommendationResult;
  let air: NormalizedAirData;
  try {
    air = await getService().getAirData(cityId, degraded ? { allowUpstream: false } : {});
    const outcome = generateRecommendations({ air, profileId, preferences: undefined, nowMs: now() });
    if (!outcome.ok) {
      consoleSafeLogger.warn("chat.engine_rejected_validated_input", { cityId });
      return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
    }
    result = outcome.result;
  } catch {
    consoleSafeLogger.warn("chat.failed", { cityId });
    return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
  }

  let chat: ChatEnvelope;
  try {
    chat = await options.getChat().answer({ request, result, air, message, history: history ?? [] });
  } catch {
    // The chat service never throws; this guards the wiring so a bug there returns a controlled error.
    consoleSafeLogger.warn("chat.service_failed", { cityId });
    return fail(500, "INTERNAL_ERROR", "The assistant hit an unexpected problem.");
  }

  const success: ChatApiSuccess = { ok: true, chat };
  return Response.json(success, { status: 200, headers: { ...JSON_HEADERS, "X-AI-Status": chat.status, "X-AI-Provider": chat.provider } });
}
