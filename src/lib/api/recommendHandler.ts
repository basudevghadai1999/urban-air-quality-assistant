import type { AiEnvelope } from "@/lib/ai/types";
import type { ExplanationService } from "@/lib/ai/service";
import { AI_REASON_MESSAGES } from "@/lib/ai/errors";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import type { AirService } from "@/lib/data/airService";
import { consoleSafeLogger } from "@/lib/observability/logger";
import { describeIssues, generateRecommendations, recommendRequestSchema, type RecommendationResult } from "@/lib/engine";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { ApiIssue, RecommendApiError, RecommendApiErrorCode, RecommendApiSuccess } from "@/types/api";
import type { NormalizedAirData } from "@/types/air";

import { applyRateLimit, errorResponse, JSON_HEADERS, readJsonBody, unavailableRetryAfterSeconds } from "./common";

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

export interface RecommendHandlerOptions {
  /** Builds the rate-limit gate. Omitted: no rate limiting (unit tests only). */
  readonly getGate?: () => RateLimitGate;
  /** Builds the Gemini explanation service. Omitted: `explain: true` yields an "unavailable" explanation. */
  readonly getExplainer?: () => ExplanationService;
}

function fail(
  status: number,
  code: RecommendApiErrorCode,
  message: string,
  extra: { issues?: readonly ApiIssue[]; retryAfterSeconds?: number; headers?: Record<string, string> } = {},
): Response {
  return errorResponse(status, code, message, extra);
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
    consoleSafeLogger.warn("recommend.explainer_failed", { cityId: result.cityId });
    return unavailable();
  }
}

export async function handleRecommendRequest(
  request: Request,
  getService: () => AirService,
  now: () => number = () => Date.now(),
  options: RecommendHandlerOptions = {},
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const json = body.json;

  const parsed = recommendRequestSchema.safeParse(json);
  if (!parsed.success) {
    return fail(400, "INVALID_REQUEST", "The request is not valid. See the listed fields.", { issues: describeIssues(parsed.error) });
  }
  const { cityId, profileId, preferences, explain } = parsed.data;

  const gate = await applyRateLimit(request, options.getGate, {
    event: "recommend.rate_limit_gate_failed",
    cityId,
    response: () => fail(500, "INTERNAL_ERROR", "The recommendation service hit an unexpected problem."),
  });
  if (gate.kind === "blocked") return gate.response;
  const { degraded } = gate;

  let result: RecommendationResult;
  let air: NormalizedAirData;
  let freshness = "unavailable";
  try {
    air = await getService().getAirData(cityId, degraded ? { allowUpstream: false } : {});
    freshness = air.freshnessStatus;
    const outcome = generateRecommendations({ air, profileId, preferences, nowMs: now() });
    if (!outcome.ok) {
      consoleSafeLogger.warn("recommend.engine_rejected_validated_input", { cityId });
      return fail(500, "INTERNAL_ERROR", "The recommendation service hit an unexpected problem.");
    }
    result = outcome.result;
  } catch {
    consoleSafeLogger.warn("recommend.failed", { cityId });
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
    const retryAfter = unavailableRetryAfterSeconds(degraded);
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
