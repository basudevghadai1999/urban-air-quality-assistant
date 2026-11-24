import type { CityId } from "@/config/cities";
import type { ChatEnvelope, ChatTurn } from "@/lib/ai/chatTypes";
import type { AiEnvelope } from "@/lib/ai/types";
import type { ChatApiSuccess } from "@/lib/api/chatHandler";
import type { RecommendApiError, RecommendApiSuccess } from "@/lib/api/recommendHandler";
import type { RecommendationResult } from "@/lib/engine";
import type { ProfileId } from "@/lib/engine/types";
import type { AirApiError, AirApiSuccess, NormalizedAirData } from "@/types/air";

/**
 * Browser-side calls to the two existing endpoints. Only a city ID, a profile ID and an `explain`
 * flag are ever sent: the server computes every AQI, window and estimate, so nothing numeric
 * from the browser can influence a result. No key is involved; the browser never holds one.
 *
 * Each call returns a discriminated outcome instead of throwing, so the UI can show a precise
 * state (loading failed, rate limited, no data) and never invents a reading.
 */

/** Imported from the handlers as types only: no server code is pulled into the bundle. */
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

export interface ApiFailure {
  readonly kind: ApiFailureKind;
  /** Fixed, user-readable text. Never a raw server or provider message. */
  readonly message: string;
  readonly retryAfterSeconds: number | null;
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MESSAGES = {
  network: "We could not reach the server. It may be waking up after a quiet spell, or your connection may be down. Please try again in a moment.",
  "rate-limited": "Too many requests. Please wait a moment before trying again.",
  unavailable: "Air quality data is not available for this city right now, and no earlier reading exists.",
  server: "Something went wrong on our side. Please try again shortly.",
} as const satisfies Record<ApiFailureKind, string>;

const failure = (kind: ApiFailureKind, retryAfterSeconds: number | null = null): ApiFailure => ({ kind, message: MESSAGES[kind], retryAfterSeconds });

type Parsed = { readonly status: number; readonly body: Record<string, unknown> | null } | { readonly status: null };

async function send(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Parsed> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.any([signal, timeout]) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body: isRecord(body) ? body : null };
  } catch (error) {
    // A caller abort (a newer selection replaced this request) is re-thrown so it is never shown as an error.
    if (signal.aborted) throw error;
    return { status: null };
  }
}

function failureFrom(status: number, body: Record<string, unknown> | null): ApiFailure {
  const error = body !== null && isRecord(body.error) ? body.error : null;
  const retry = error !== null && typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : null;
  if (status === 429) return failure("rate-limited", retry);
  const code = error !== null && typeof error.code === "string" ? error.code : "";
  if (status === 503 && (code === "AIR_DATA_UNAVAILABLE" || code === "RATE_LIMITING_UNAVAILABLE")) return failure("unavailable", retry);
  return failure("server", retry);
}

/** GET /api/air?cityId=... */
export async function fetchAir(cityId: CityId, signal: AbortSignal): Promise<AirOutcome> {
  const sent = await send(`/api/air?cityId=${encodeURIComponent(cityId)}`, { method: "GET" }, signal, REQUEST_TIMEOUT_MS);
  if (sent.status === null) return { ok: false, failure: failure("network"), data: null };
  const body = sent.body;
  if (sent.status === 200 && body !== null && body.ok === true && isRecord(body.data)) {
    return { ok: true, data: (body as unknown as AirApiSuccess).data };
  }
  const carried = body !== null && isRecord(body.data) ? (body as unknown as AirApiError).data ?? null : null;
  return { ok: false, failure: failureFrom(sent.status, body), data: carried };
}

/** POST /api/recommend. With `explain: true` the response also carries the AI envelope. */
export async function fetchRecommendations(
  cityId: CityId,
  profileId: ProfileId,
  explain: boolean,
  signal: AbortSignal,
): Promise<RecommendOutcome> {
  const sent = await send(
    "/api/recommend",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, profileId, explain }) },
    signal,
    explain ? EXPLAIN_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  );
  if (sent.status === null) return { ok: false, failure: failure("network"), data: null };
  const body = sent.body;
  if (sent.status === 200 && body !== null && body.ok === true && isRecord(body.data)) {
    const ok = body as unknown as RecommendApiSuccess;
    return { ok: true, data: { result: ok.data, ai: ok.ai ?? null } };
  }
  const err = body as unknown as RecommendApiError | null;
  const carried = body !== null && isRecord(body.data) ? { result: err?.data as RecommendationResult, ai: err?.ai ?? null } : null;
  return { ok: false, failure: failureFrom(sent.status, body), data: carried };
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
  const sent = await send(
    "/api/chat",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, profileId, message, history }) },
    signal,
    CHAT_TIMEOUT_MS,
  );
  if (sent.status === null) return { ok: false, failure: failure("network") };
  const body = sent.body;
  if (sent.status === 200 && body !== null && body.ok === true && isRecord(body.chat)) {
    return { ok: true, chat: (body as unknown as ChatApiSuccess).chat };
  }
  return { ok: false, failure: failureFrom(sent.status, body) };
}
