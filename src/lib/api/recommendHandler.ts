import type { AiEnvelope } from "@/lib/ai/types";
import type { ExplanationService } from "@/lib/ai/service";
import { AI_REASON_MESSAGES } from "@/lib/ai/errors";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { consoleAirLogger, type AirService } from "@/lib/data/airService";
import { describeIssues, generateRecommendations, recommendRequestSchema, type RecommendationResult } from "@/lib/engine";
import type { GateDecision, RateLimitGate } from "@/lib/ratelimit/gate";
import type { NormalizedAirData } from "@/types/air";

import { rateLimitedResponse } from "./airHandler";

/**
 * Request handling for POST /api/recommend. Thin by design: validate, rate-limit, fetch air data
 * through the existing service (cache -> provider -> last-known-good), run the deterministic engine,
 * return JSON. All recommendation logic lives in `src/lib/engine` and never touches the network.
 *
 * Input rules:
 *  - `Content-Type: application/json`, body at most 8 KB;
 *  - exactly `{ cityId, profileId, preferences? }`, strictly validated: unknown keys are refused;
 *  - no free-text field exists anywhere in the schema, so a request cannot carry instructions.
 * Error bodies are fixed text: no stack traces, no upstream detail, no echo of submitted values.
 *
 * Air data states: fresh and stale data yield recommendations (stale is flagged and uses only
 * forecast hours still in the future); unavailable data yields HTTP 503 with a result whose
 * air-dependent sections are explicitly unavailable.
 */

export const MAX_BODY_BYTES = 8 * 1024;

export type RecommendApiErrorCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "REQUEST_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "RATE_LIMITING_UNAVAILABLE"
  | "AIR_DATA_UNAVAILABLE"
  | "INTERNAL_ERROR";

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
    readonly issues?: readonly { readonly path: string; readonly message: string }[];
    readonly retryAfterSeconds?: number;
  };
  /** Present for AIR_DATA_UNAVAILABLE and RATE_LIMITING_UNAVAILABLE: the engine's explicit unavailable result. */
  readonly data?: RecommendationResult;
  readonly ai?: AiEnvelope;
}

export interface RecommendHandlerOptions {
  /** Builds the rate-limit gate. Omitted: no rate limiting (unit tests only). */
  readonly getGate?: () => RateLimitGate;
  /** Builds the Gemini explanation service. Omitted: `explain: true` yields an "unavailable" explanation. */
  readonly getExplainer?: () => ExplanationService;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

function fail(
  status: number,
  code: RecommendApiErrorCode,
  message: string,
  extra: { issues?: RecommendApiError["error"]["issues"]; retryAfterSeconds?: number; headers?: Record<string, string> } = {},
): Response {
  const body: RecommendApiError = {
    ok: false,
    error: {
      code,
      message,
      ...(extra.issues === undefined ? {} : { issues: extra.issues }),
      ...(extra.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: extra.retryAfterSeconds }),
    },
  };
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...extra.headers } });
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

/** The explanation layer never throws; this guards the wiring anyway so a bug there cannot lose the deterministic result. */
async function explainResult(
  getExplainer: (() => ExplanationService) | undefined,
  request: Request,
  result: RecommendationResult,
  air: NormalizedAirData,
): Promise<AiEnvelope> {
  const unavailable = (): AiEnvelope => ({
    status: "unavailable",
    reasonCode: "AI_INTERNAL",
    message: AI_REASON_MESSAGES.AI_INTERNAL,
    explanation: null,
    provider: "deterministic",
    model: null,
    promptVersion: PROMPT_VERSION,
    numbersFromEngine: true,
  });
  if (getExplainer === undefined) return unavailable();
  try {
    return await getExplainer().explain({ request, result, air });
  } catch {
    consoleAirLogger.warn("recommend.explainer_failed", { cityId: result.cityId });
    return unavailable();
  }
}

export async function handleRecommendRequest(
  request: Request,
  getService: () => AirService,
  now: () => number = () => Date.now(),
  options: RecommendHandlerOptions = {},
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

  const parsed = recommendRequestSchema.safeParse(json);
  if (!parsed.success) {
    return fail(400, "INVALID_REQUEST", "The request is not valid. See the listed fields.", { issues: describeIssues(parsed.error) });
  }
  const { cityId, profileId, preferences, explain } = parsed.data;

  let decision: GateDecision | null = null;
  if (options.getGate !== undefined) {
    try {
      decision = await options.getGate()(request);
    } catch {
      consoleAirLogger.warn("recommend.rate_limit_gate_failed", { cityId });
      return fail(500, "INTERNAL_ERROR", "The recommendation service hit an unexpected problem.");
    }
    if (decision.kind === "limited") return rateLimitedResponse(decision);
  }
  const degraded = decision?.kind === "degraded";

  let result: RecommendationResult;
  let air: NormalizedAirData;
  let freshness = "unavailable";
  try {
    air = await getService().getAirData(cityId, degraded ? { allowUpstream: false } : {});
    freshness = air.freshnessStatus;
    const outcome = generateRecommendations({ air, profileId, preferences, nowMs: now() });
    if (!outcome.ok) {
      consoleAirLogger.warn("recommend.engine_rejected_validated_input", { cityId });
      return fail(500, "INTERNAL_ERROR", "The recommendation service hit an unexpected problem.");
    }
    result = outcome.result;
  } catch {
    consoleAirLogger.warn("recommend.failed", { cityId });
    return fail(500, "INTERNAL_ERROR", "The recommendation service hit an unexpected problem.");
  }

  // The explanation is computed from the result the SERVER just produced. Nothing numeric from the
  // request is ever used, and the result is not modified by the explanation step.
  let ai: AiEnvelope | undefined;
  if (explain === true) ai = await explainResult(options.getExplainer, request, result, air);

  const common = {
    ...JSON_HEADERS,
    "X-Air-Freshness": freshness,
    "X-Recommendation-Engine": "deterministic",
    ...(ai === undefined ? {} : { "X-AI-Status": ai.status, "X-AI-Provider": ai.provider }),
  };

  if (result.status === "air-data-unavailable") {
    const code: RecommendApiErrorCode = degraded ? "RATE_LIMITING_UNAVAILABLE" : "AIR_DATA_UNAVAILABLE";
    const retryAfter = degraded ? 30 : 60;
    const errorBody: RecommendApiError = {
      ok: false,
      error: {
        code,
        message: degraded
          ? "Live air quality data cannot be refreshed right now and no earlier reading is available, so air-dependent recommendations are unavailable."
          : "Air quality data is temporarily unavailable for this city and no earlier reading exists, so air-dependent recommendations are unavailable.",
        retryAfterSeconds: retryAfter,
      },
      data: result,
      ...(ai === undefined ? {} : { ai }),
    };
    return Response.json(errorBody, { status: 503, headers: { ...common, "Retry-After": String(retryAfter) } });
  }

  const success: RecommendApiSuccess = { ok: true, data: result, ...(ai === undefined ? {} : { ai }) };
  return Response.json(success, { status: 200, headers: common });
}
