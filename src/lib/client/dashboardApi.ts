import type { CityId } from "@/config/cities";
import type { ChatEnvelope, ChatTurn } from "@/lib/ai/chatTypes";
import type { AiEnvelope } from "@/lib/ai/types";
import type { RecommendationResult } from "@/lib/engine";
import type { ProfileId } from "@/lib/engine/types";
import type { NormalizedAirData } from "@/types/air";

import type * as ApiSchemas from "./apiSchemas";

/**
 * Browser-side calls to the three existing endpoints. Only a city ID, a profile ID, an `explain` flag and
 * (for chat) a short question are ever sent: the server computes every AQI, window and estimate, so
 * nothing numeric from the browser can influence a result. No key is involved; the browser never holds one.
 *
 * Each call returns a discriminated outcome instead of throwing, so the UI can show a precise state
 * (loading failed, rate limited, no data) and never invents a reading. Nothing the server sends is trusted
 * for its shape: every body is parsed against `apiSchemas` once, and only a value that passes reaches the UI.
 */

/** Imported as types only: no server code is pulled into the bundle. */
export type RecommendOutcomeData = { readonly result: RecommendationResult; readonly ai: AiEnvelope | null };

export type ApiFailureKind =
  /** The request never completed (offline, DNS, timeout). */
  | "network"
  /** 429: the per-client limit. `retryAfterSeconds` says when to retry. */
  | "rate-limited"
  /** 503 with an explicit "no data" state: nothing was ever received for this city. */
  | "unavailable"
  /** Anything else, including a body that does not look like an API response. */
  | "server";

/** What went wrong underneath `kind`, for tests and diagnostics. The UI shows only the fixed message. */
export type ApiFailureCause =
  | "network" // fetch itself failed or timed out
  | "http" // a non-2xx status with a well-formed error body
  | "invalid-json" // the body was not JSON (an HTML error page, an empty body)
  | "invalid-response" // JSON, but not the shape the contract promises
  | "service"; // a well-formed reply that carries no content (the assistant had no answer)

export interface ApiFailure {
  readonly kind: ApiFailureKind;
  /** Fixed, user-readable text. Never a raw server or provider message. */
  readonly message: string;
  readonly retryAfterSeconds: number | null;
  readonly cause: ApiFailureCause;
}

export type AirOutcome =
  | { readonly ok: true; readonly data: NormalizedAirData }
  | { readonly ok: false; readonly failure: ApiFailure; readonly data: NormalizedAirData | null };

export type RecommendOutcome =
  | { readonly ok: true; readonly data: RecommendOutcomeData }
  | { readonly ok: false; readonly failure: ApiFailure; readonly data: RecommendOutcomeData | null };

export const REQUEST_TIMEOUT_MS = 20_000;
/** An explanation may wait on a provider (up to its own timeout) and a second one after it. */
export const EXPLAIN_TIMEOUT_MS = 50_000;

const MESSAGES = {
  network: "We could not reach the server. It may be waking up after a quiet spell, or your connection may be down. Please try again in a moment.",
  "rate-limited": "Too many requests. Please wait a moment before trying again.",
  unavailable: "Air quality data is not available for this city right now, and no earlier reading exists.",
  server: "Something went wrong on our side. Please try again shortly.",
} as const satisfies Record<ApiFailureKind, string>;

type Schemas = typeof ApiSchemas;

/**
 * The validators (zod and the schemas) are only needed once a response arrives, so they are fetched on demand,
 * in parallel with the request itself, instead of weighing on the page's initial JavaScript. Cached after the
 * first load. If the chunk cannot be loaded (offline, a stale deployment) the call reports a network failure.
 */
const loadSchemas = (): Promise<Schemas | null> => import("./apiSchemas").catch(() => null);

const failure = (kind: ApiFailureKind, cause: ApiFailureCause, retryAfterSeconds: number | null = null): ApiFailure => ({
  kind,
  message: MESSAGES[kind],
  retryAfterSeconds,
  cause,
});

type Received =
  | { readonly outcome: "network" }
  | { readonly outcome: "not-json" }
  | { readonly outcome: "json"; readonly status: number; readonly body: unknown };

async function send(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Received> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    // A caller abort (a newer selection replaced this request) is re-thrown so it is never shown as an error.
    if (signal.aborted) throw error;
    return { outcome: "network" };
  }
  try {
    const body: unknown = await response.json();
    return { outcome: "json", status: response.status, body };
  } catch (error) {
    if (signal.aborted) throw error;
    return { outcome: "not-json" };
  }
}

/** The part of every error envelope the client reads. */
interface ErrorEnvelope {
  /** Loose objects keep unknown keys, such as the `data` and `ai` a 503 may carry. */
  readonly [key: string]: unknown;
  readonly error: { readonly code: string; readonly retryAfterSeconds?: number | undefined };
}
type ErrorSchema = { safeParse(value: unknown): { success: true; data: ErrorEnvelope } | { success: false } };

/** Classify a non-200 reply by its status; the body only supplies the code and the retry delay. */
function httpFailure(status: number, body: unknown, schema: ErrorSchema): { failure: ApiFailure; envelope: ErrorEnvelope | null } {
  const parsed = schema.safeParse(body);
  const envelope = parsed.success ? parsed.data : null;
  const cause: ApiFailureCause = envelope === null ? "invalid-response" : "http";
  const retry = envelope?.error.retryAfterSeconds ?? null;
  const code = envelope?.error.code;
  if (status === 429) return { failure: failure("rate-limited", cause, retry), envelope };
  if (status === 503 && (code === "AIR_DATA_UNAVAILABLE" || code === "RATE_LIMITING_UNAVAILABLE")) {
    return { failure: failure("unavailable", cause, retry), envelope };
  }
  return { failure: failure("server", cause, retry), envelope };
}

/** A reply that never reached a parsed body: the same failure for every endpoint. */
const unparsed = (received: Exclude<Received, { outcome: "json" }>): ApiFailure =>
  received.outcome === "network" ? failure("network", "network") : failure("server", "invalid-json");

/** GET /api/air?cityId=... */
export async function fetchAir(cityId: CityId, signal: AbortSignal): Promise<AirOutcome> {
  const [received, schemas] = await Promise.all([
    send(`/api/air?cityId=${encodeURIComponent(cityId)}`, { method: "GET" }, signal, REQUEST_TIMEOUT_MS),
    loadSchemas(),
  ]);
  if (schemas === null) return { ok: false, failure: failure("network", "network"), data: null };
  if (received.outcome !== "json") return { ok: false, failure: unparsed(received), data: null };

  if (received.status === 200) {
    const envelope = schemas.airSuccessSchema.safeParse(received.body);
    if (envelope.success && schemas.isAirReading(envelope.data.data)) return { ok: true, data: envelope.data.data };
    return { ok: false, failure: failure("server", "invalid-response"), data: null };
  }

  const { failure: classified, envelope } = httpFailure(received.status, received.body, schemas.airErrorSchema);
  // The explicit unavailable state travels with a 503; anything else in `data` is ignored.
  const carried = envelope === null ? null : schemas.unavailableAirSchema.safeParse(envelope["data"]);
  return { ok: false, failure: classified, data: carried?.success === true ? carried.data : null };
}

/** POST /api/recommend. With `explain: true` the response also carries the AI envelope. */
export async function fetchRecommendations(
  cityId: CityId,
  profileId: ProfileId,
  explain: boolean,
  signal: AbortSignal,
): Promise<RecommendOutcome> {
  const [received, schemas] = await Promise.all([
    send(
      "/api/recommend",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, profileId, explain }) },
      signal,
      explain ? EXPLAIN_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    ),
    loadSchemas(),
  ]);
  if (schemas === null) return { ok: false, failure: failure("network", "network"), data: null };
  if (received.outcome !== "json") return { ok: false, failure: unparsed(received), data: null };

  // The deterministic result and the AI envelope are checked separately: a malformed explanation must
  // never cost the user the recommendations, so it is dropped and the UI shows its "could not load" state.
  const withAi = (resultSource: unknown, aiSource: unknown): RecommendOutcomeData | null => {
    const result = schemas.recommendationResultSchema.safeParse(resultSource);
    if (!result.success) return null;
    const ai = aiSource === undefined ? null : schemas.aiEnvelopeSchema.safeParse(aiSource);
    return { result: result.data, ai: ai?.success === true ? ai.data : null };
  };

  if (received.status === 200) {
    const envelope = schemas.recommendSuccessSchema.safeParse(received.body);
    const data = envelope.success ? withAi(envelope.data.data, envelope.data.ai) : null;
    return data === null ? { ok: false, failure: failure("server", "invalid-response"), data: null } : { ok: true, data };
  }

  const { failure: classified, envelope } = httpFailure(received.status, received.body, schemas.recommendErrorSchema);
  const carried = envelope === null ? null : withAi(envelope["data"], envelope["ai"]);
  return { ok: false, failure: classified, data: carried };
}

export type ChatOutcome =
  | { readonly ok: true; readonly chat: ChatEnvelope }
  | { readonly ok: false; readonly failure: ApiFailure };

/** A chat answer may wait on a provider (up to its own timeout) and a second one after it. */
export const CHAT_TIMEOUT_MS = 50_000;

/**
 * POST /api/chat. Sends the city and profile IDs, the question, and at most a few earlier messages.
 * The server builds all context itself; nothing numeric from the browser can influence an answer.
 */
export async function fetchChat(
  cityId: CityId,
  profileId: ProfileId,
  message: string,
  history: readonly ChatTurn[],
  signal: AbortSignal,
): Promise<ChatOutcome> {
  const [received, schemas] = await Promise.all([
    send(
      "/api/chat",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, profileId, message, history }) },
      signal,
      CHAT_TIMEOUT_MS,
    ),
    loadSchemas(),
  ]);
  if (schemas === null) return { ok: false, failure: failure("network", "network") };
  if (received.outcome !== "json") return { ok: false, failure: unparsed(received) };

  if (received.status === 200) {
    const parsed = schemas.chatSuccessSchema.safeParse(received.body);
    return parsed.success ? { ok: true, chat: parsed.data.chat } : { ok: false, failure: failure("server", "invalid-response") };
  }
  return { ok: false, failure: httpFailure(received.status, received.body, schemas.chatErrorSchema).failure };
}
