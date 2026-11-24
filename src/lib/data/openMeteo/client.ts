import { getCityById, type City } from "@/config/cities";
import { INDIA_TIMEZONE } from "@/lib/constants";
import { BodyTooLargeError, isAbortError, readTextCapped } from "@/lib/http";

import { OpenMeteoError } from "./errors";
import { openMeteoErrorEnvelopeSchema, openMeteoResponseSchema, summarizeIssues, type OpenMeteoResponse } from "./schema";
import {
  DEFAULT_TIMEOUT_MS,
  FORECAST_HOURS,
  MAX_RESPONSE_BYTES,
  OPEN_METEO_AIR_QUALITY_URL,
  PAST_HOURS,
  PROVIDER_DOMAIN,
  PROVIDER_POLLUTANT_IDS,
  PROVIDER_VARIABLES,
} from "./types";

/**
 * Open-Meteo Air Quality HTTP client.
 *
 * Security properties:
 * - The URL host/path is a constant. Coordinates come ONLY from the city
 *   registry, looked up by ID here, so a caller cannot make us query an
 *   arbitrary location or host.
 * - Redirects are refused, so a response cannot bounce us to another host.
 * - A timeout bounds every request; the response body is size-capped while read.
 * - Provider bodies and `reason` strings are never copied into errors or logs.
 * - Caching is controlled by us (`cache: "no-store"`): Next.js's fetch cache is
 *   not relied on, so `fetchedAt` always means "when the provider answered".
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Injectable for tests; defaults to global `fetch`. Never taken from a request. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Request URL for a configured city. Exposed for tests and documentation. */
export function buildRequestUrl(city: City): URL {
  const url = new URL(OPEN_METEO_AIR_QUALITY_URL);
  const variables = PROVIDER_POLLUTANT_IDS.map((id) => PROVIDER_VARIABLES[id]).join(",");
  url.searchParams.set("latitude", String(city.latitude));
  url.searchParams.set("longitude", String(city.longitude));
  url.searchParams.set("hourly", variables);
  url.searchParams.set("current", variables);
  url.searchParams.set("timezone", INDIA_TIMEZONE);
  // Unambiguous absolute timestamps; avoids parsing offset-less local-time strings.
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("domains", PROVIDER_DOMAIN);
  url.searchParams.set("past_hours", String(PAST_HOURS));
  url.searchParams.set("forecast_hours", String(FORECAST_HOURS));
  return url;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.floor(seconds), 3_600);
}

function classifyStatus(response: Response): OpenMeteoError {
  const status = response.status;
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    return new OpenMeteoError("UPSTREAM_RATE_LIMITED", {
      status,
      detail: "HTTP 429",
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 400 && status < 500) return new OpenMeteoError("UPSTREAM_REJECTED", { status, detail: `HTTP ${status}` });
  if (status >= 500) return new OpenMeteoError("UPSTREAM_SERVER_ERROR", { status, detail: `HTTP ${status}` });
  return new OpenMeteoError("UPSTREAM_HTTP", { status, detail: `HTTP ${status}` });
}

/**
 * Fetch and validate the air quality response for a configured city.
 * Throws `OpenMeteoError` for every failure mode; never returns unvalidated data.
 */
export async function fetchOpenMeteoAirQuality(
  cityId: string,
  options: FetchOptions = {},
): Promise<OpenMeteoResponse> {
  const city = getCityById(cityId);
  if (city === undefined) throw new OpenMeteoError("UNKNOWN_CITY", { detail: "city id not in registry" });

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const url = buildRequestUrl(city);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new OpenMeteoError("UPSTREAM_TIMEOUT", { detail: `no response within ${timeoutMs} ms` });
    }
    const name = error instanceof Error ? error.name : "";
    throw new OpenMeteoError("UPSTREAM_NETWORK", { detail: name || "fetch failed" });
  }

  if (!response.ok) {
    // Drain nothing: the body (which may echo internal details) is deliberately never read.
    await response.body?.cancel().catch(() => undefined);
    throw classifyStatus(response);
  }

  let text: string;
  try {
    text = await readTextCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new OpenMeteoError("UPSTREAM_TOO_LARGE", { detail: "response body over the size limit" });
    }
    if (isAbortError(error)) throw new OpenMeteoError("UPSTREAM_TIMEOUT", { detail: "timed out reading body" });
    throw new OpenMeteoError("UPSTREAM_NETWORK", { detail: "failed reading body" });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OpenMeteoError("UPSTREAM_INVALID_RESPONSE", { detail: "body is not valid JSON" });
  }

  if (openMeteoErrorEnvelopeSchema.safeParse(json).success) {
    throw new OpenMeteoError("UPSTREAM_REJECTED", { detail: "provider returned an error envelope" });
  }

  const parsed = openMeteoResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenMeteoError("UPSTREAM_INVALID_RESPONSE", { detail: summarizeIssues(parsed.error) });
  }
  return parsed.data;
}
