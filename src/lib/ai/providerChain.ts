import "server-only";

import type { AirMetrics } from "@/lib/observability/metrics";

import { isFailoverEligible, type AiReasonCode } from "./errors";
import type { ProviderTarget, ProviderTransport } from "./provider";
import type { ProviderBudget } from "./providerBudget";
import type { AiAttempt } from "./types";

/**
 * The provider order and its budget rules, shared by explanations and chat so the two cannot drift:
 *
 *   for each configured provider, in order:
 *     transport -> atomic daily budget (global + this provider) -> ONE attempt -> next provider only if the
 *     failure is failover-eligible.
 *
 * - Each provider is tried at most once: there is no retry here, and the transports pin one request per call.
 * - A reservation is charged BEFORE the call and never refunded: a failed call may still have reached (and
 *   been billed by) the provider. A provider that is never called is never charged: the transport is built
 *   first, so a transport that cannot be built costs nothing.
 * - The global cap ends the chain (every provider draws on it); a provider's own cap only skips that provider.
 * - A budget that cannot decide (Redis down) ends the chain: no provider is called.
 * - Total time: one deadline covers the whole chain (`chainDeadlineMs`). A later provider gets only the time
 *   left, and is not started (or charged) when less than `MIN_ATTEMPT_MS` remains; the answer is then the
 *   deterministic fallback.
 * - Cancellation: when the caller has gone, no later provider is started, and a failure that happened after it
 *   left is counted as `ai_cancelled`, not as a provider failure.
 * - What each attempt does (prompt, validator, cache, metrics) stays with the caller. This only decides who is
 *   called next and what a refusal means.
 */

/** The shortest provider timeout that can be configured (`AI_REQUEST_TIMEOUT_MS`): less time left than this is not worth a call. */
export const MIN_ATTEMPT_MS = 2_000;
/** Failover may add up to this much time, but the whole chain never gets less than one provider timeout. */
const FAILOVER_WINDOW_MS = 45_000;

/**
 * The most time a whole chain may take: two provider timeouts, capped at 45 s, and never below one provider
 * timeout. At the default 20 s that is 40 s (what two full attempts took before); at the 60 s maximum it is 60 s
 * (previously up to 120 s), so the first provider keeps its configured time and failover gets whatever is left.
 */
export const chainDeadlineMs = (timeoutMs: number): number => Math.max(timeoutMs, Math.min(2 * timeoutMs, FAILOVER_WINDOW_MS));

export type ProviderTry<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AiReasonCode; readonly rejection?: string | null };

export type ChainResult<T> =
  | { readonly kind: "answered"; readonly provider: ProviderTarget; readonly value: T; readonly attempts: readonly AiAttempt[] }
  | { readonly kind: "fallback"; readonly code: AiReasonCode; readonly attempts: readonly AiAttempt[]; readonly retryAfterSeconds?: number };

export interface ProviderChainOptions<T> {
  readonly providers: readonly ProviderTarget[];
  /** The configured per-provider timeout; the chain deadline is derived from it. */
  readonly timeoutMs: number;
  /** Milliseconds clock; injectable for tests. */
  readonly now?: () => number;
  readonly budget: ProviderBudget;
  readonly metrics: AirMetrics;
  readonly getTransport: (provider: ProviderTarget) => ProviderTransport;
  /** Called once a reservation was granted, just before the attempt. */
  readonly onRequest: (provider: ProviderTarget) => void;
  /** Called for every provider failure (never for budget refusals). */
  readonly onFailure: (provider: ProviderTarget, code: AiReasonCode, rejection: string | null) => void;
  /** Make the one attempt, within `call.timeoutMs`. Must return a failure rather than throw for anything the provider can do. */
  readonly attempt: (provider: ProviderTarget, transport: ProviderTransport, call: { readonly timeoutMs: number }) => Promise<ProviderTry<T>>;
  /** When true before a LATER provider, the chain stops: nobody is waiting, so no further budget is spent. */
  readonly isCancelled?: () => boolean;
}

export async function runProviderChain<T>(o: ProviderChainOptions<T>): Promise<ChainResult<T>> {
  const now = o.now ?? (() => Date.now());
  const deadline = now() + chainDeadlineMs(o.timeoutMs);
  const attempts: AiAttempt[] = [];
  let lastCode: AiReasonCode = "AI_NOT_CONFIGURED";
  let lastRetryAfter: number | undefined;

  for (const [index, provider] of o.providers.entries()) {
    const hasNext = index < o.providers.length - 1;
    /** Record a failed provider; true when the next one may be tried. */
    const failed = (code: AiReasonCode, rejection: string | null, transportFailure = false): boolean => {
      // Exactly one outcome per provider call: success, `ai_provider_failure` or `ai_cancelled`. A client that
      // could not be built made no call, so it has its own counter and never inflates the failure count.
      if (transportFailure) o.metrics.increment("ai_transport_failure", { provider: provider.id });
      else o.onFailure(provider, code, rejection);
      attempts.push({ provider: provider.id, reasonCode: code });
      lastCode = code;
      if (hasNext && (transportFailure || isFailoverEligible(code))) {
        o.metrics.increment("ai_provider_fallback", { provider: provider.id, code });
        return true;
      }
      return false;
    };
    const stop = (): ChainResult<T> => ({ kind: "fallback", code: lastCode, attempts });

    if (index > 0 && o.isCancelled?.() === true) return stop();
    if (index > 0 && deadline - now() < MIN_ATTEMPT_MS) {
      o.metrics.increment("ai_deadline_exceeded", { provider: provider.id });
      return stop();
    }

    // A transport that cannot be built is this provider's problem, not a reason to skip the others: failover is
    // forced (the code stays AI_INTERNAL, which is never failover-eligible on its own). Nothing has been charged.
    let transport: ProviderTransport;
    try {
      transport = o.getTransport(provider);
    } catch {
      if (failed("AI_INTERNAL", null, true)) continue;
      return stop();
    }

    let reservation;
    try {
      reservation = await o.budget.reserve(provider.id);
    } catch {
      o.metrics.increment("ai_protection_unavailable", { layer: "budget" });
      return { kind: "fallback", code: "AI_PROTECTION_UNAVAILABLE", attempts };
    }
    if (!reservation.allowed) {
      o.metrics.increment("ai_budget_rejection", { provider: provider.id, kind: reservation.deniedBy ?? "unknown" });
      lastRetryAfter = reservation.resetsInSeconds;
      if (reservation.deniedBy === "global") return { kind: "fallback", code: "AI_BUDGET_EXHAUSTED", attempts, retryAfterSeconds: reservation.resetsInSeconds };
      attempts.push({ provider: provider.id, reasonCode: "AI_BUDGET_EXHAUSTED" });
      lastCode = "AI_BUDGET_EXHAUSTED";
      continue;
    }

    o.onRequest(provider);
    // Time is measured again here: the budget check just took some. The first provider always keeps its full
    // configured timeout; a later one gets what is left (never under the threshold it was admitted with).
    const callMs = index === 0 ? o.timeoutMs : Math.min(o.timeoutMs, Math.max(deadline - now(), MIN_ATTEMPT_MS));
    const outcome = await o.attempt(provider, transport, { timeoutMs: callMs });
    if (outcome.ok) return { kind: "answered", provider, value: outcome.value, attempts };
    // An abort reaches us as AI_TIMEOUT (both transports abort with an AbortError the classifier maps to it). It
    // is the caller's doing when the caller's signal is already aborted, which also settles a tie between a
    // timeout and a disconnect in favour of "cancelled". Any other failure (an answer that failed validation, an
    // HTTP error) happened for its own reason and is counted as such, even if the caller has since left.
    if (outcome.code === "AI_TIMEOUT" && o.isCancelled?.() === true) {
      // The caller left while this call ran, so the abort is not the provider's fault.
      o.metrics.increment("ai_cancelled", { provider: provider.id });
      attempts.push({ provider: provider.id, reasonCode: outcome.code });
      lastCode = outcome.code;
      return stop();
    }
    if (failed(outcome.code, outcome.rejection ?? null)) continue;
    return stop();
  }

  return { kind: "fallback", code: lastCode, attempts, ...(lastCode === "AI_BUDGET_EXHAUSTED" && lastRetryAfter !== undefined ? { retryAfterSeconds: lastRetryAfter } : {}) };
}
