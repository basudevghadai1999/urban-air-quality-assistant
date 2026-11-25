import { z } from "zod";

import { CITY_IDS } from "@/config/cities";
import { applyRateLimit, errorResponse, JSON_HEADERS, unavailableRetryAfterSeconds } from "@/lib/api/common";
import { remainingFreshSeconds, type AirService } from "@/lib/data/airService";
import { consoleSafeLogger } from "@/lib/observability/logger";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { AirApiError, AirApiErrorCode, AirApiSuccess } from "@/types/air";

/**
 * Request handling for GET /api/air, kept out of `route.ts` so it can be tested
 * with injected collaborators (Next.js route files may only export route fields).
 *
 * Input rules: exactly one query parameter, `cityId`, which must be one of the
 * configured IDs. Latitude, longitude and any other parameter are rejected, so
 * the browser can never steer the upstream request. Error bodies are fixed
 * text: no stack traces, no upstream detail, no echo of user input.
 *
 * Order of work:
 *   1. validate the request (no I/O; invalid requests are not rate-limited, they cost nothing)
 *   2. rate-limit by client (cache hits count too; the key never includes the URL)
 *        limited  -> 429 + Retry-After, nothing else happens
 *        degraded -> the limiter cannot decide: serve cached data only, never call the provider
 *   3. serve fresh or stale data, or the explicit unavailable state (503)
 *
 * Rate-limit headers are deliberately NOT put on 200 responses: a fresh 200 may be
 * shared by a CDN, and per-client counters in a shared response would leak one
 * client's quota to others. CDN-served hits never reach this function, so they are
 * not counted.
 */

/** A valid request URL is under 100 characters; this bounds anything abusive. */
const MAX_URL_LENGTH = 512;

const cityIdSchema = z.enum(CITY_IDS);

export interface AirHandlerOptions {
  /** Builds the rate-limit gate. Omitted: no rate limiting (unit tests of the rest of the handler). */
  readonly getGate?: () => RateLimitGate;
}

export async function handleAirRequest(
  request: Request,
  getService: () => AirService,
  now: () => number = () => Date.now(),
  options: AirHandlerOptions = {},
): Promise<Response> {
  if (request.url.length > MAX_URL_LENGTH) {
    return errorResponse(414, "REQUEST_TOO_LARGE", "The request URL is too long.");
  }

  let params: URLSearchParams;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    return errorResponse(400, "INVALID_CITY_ID", "The request URL is not valid.", { validCityIds: CITY_IDS });
  }

  for (const name of params.keys()) {
    if (name !== "cityId") {
      return errorResponse(400, "UNSUPPORTED_PARAMETER", "Only the cityId query parameter is supported.");
    }
  }

  const values = params.getAll("cityId");
  if (values.length === 0) {
    return errorResponse(400, "MISSING_CITY_ID", "The cityId query parameter is required.", { validCityIds: CITY_IDS });
  }
  if (values.length > 1) {
    return errorResponse(400, "DUPLICATE_PARAMETER", "Provide cityId exactly once.");
  }

  const parsed = cityIdSchema.safeParse(values[0]);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_CITY_ID", "That city is not supported.", { validCityIds: CITY_IDS });
  }
  const cityId = parsed.data;

  const gate = await applyRateLimit(request, options.getGate, {
    event: "air.rate_limit_gate_failed",
    cityId,
    // Misconfiguration (for example an invalid rate-limit setting): refuse rather than run unprotected.
    response: () => errorResponse(500, "INTERNAL_ERROR", "The air quality service hit an unexpected problem."),
  });
  if (gate.kind === "blocked") return gate.response;
  const { degraded } = gate;

  let data;
  try {
    data = await getService().getAirData(cityId, degraded ? { allowUpstream: false } : {});
  } catch {
    // Reaching here means a bug or bad server configuration, not a provider problem
    // (those are absorbed by the service). Log the class only; reveal nothing.
    consoleSafeLogger.warn("air.route_failed", { cityId });
    return errorResponse(500, "INTERNAL_ERROR", "The air quality service hit an unexpected problem.");
  }

  if (data.freshnessStatus === "unavailable") {
    const code: AirApiErrorCode = degraded ? "RATE_LIMITING_UNAVAILABLE" : "AIR_DATA_UNAVAILABLE";
    const retryAfter = unavailableRetryAfterSeconds(degraded);
    const body: AirApiError = {
      ok: false,
      error: {
        code,
        message: degraded
          ? "Live air quality data cannot be refreshed right now, and no earlier reading is available."
          : "Air quality data is temporarily unavailable for this city, and no earlier reading exists.",
        retryAfterSeconds: retryAfter,
      },
      data,
    };
    return Response.json(body, {
      status: 503,
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfter),
        "X-Air-Freshness": "unavailable",
        "X-Air-Cache": "none",
        ...(data.cache.capability === undefined ? {} : { "X-Air-Cache-Capability": data.cache.capability }),
      },
    });
  }

  const body: AirApiSuccess = { ok: true, data };
  // A CDN may share a FRESH response, but only for the time left in its freshness window,
  // so a shared copy can never outlive the point at which it would be called stale.
  // Stale responses are never shared.
  const sharedSeconds = remainingFreshSeconds(data, now());
  return Response.json(body, {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "Cache-Control": sharedSeconds > 0 ? `public, max-age=0, s-maxage=${sharedSeconds}` : "no-store",
      "X-Air-Freshness": data.freshnessStatus,
      "X-Air-Cache": data.cache.status,
      ...(data.cache.capability === undefined ? {} : { "X-Air-Cache-Capability": data.cache.capability }),
    },
  });
}
