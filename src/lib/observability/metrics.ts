/**
 * Operational metrics, deliberately small: in-process counters plus one
 * structured log line per notable event. No metrics platform, no dependency.
 *
 * Counters are per server instance (they reset on a cold start), so the log
 * lines are the durable signal: forward them from the host's log stream if you need history.
 *
 * Log volume is bounded: a metric writes at most ONE line per minute, carrying its
 * running total (`count`). Counting is never throttled. Without this, an outage or an
 * attack would write one line per request: costly, and a log-flooding vector itself.
 *
 * Safety: only the allow-listed field names below are ever emitted. Anything
 * else is dropped, so a raw IP address, header, token or key cannot reach the
 * logs through this module even if a caller passes one by mistake.
 */

export const AIR_METRIC_NAMES = [
  "cache_hit",
  "cache_miss",
  "stale_fallback",
  "refresh_paused",
  "provider_timeout",
  "provider_failure",
  "redis_failure",
  "cache_entry_corrupt",
  "rate_limit_rejection",
  "rate_limit_degraded",
  "client_identifier_unavailable",
  // Gemini explanation layer. Counts only: reason codes and rejection kinds are fixed tokens.
  "gemini_request",
  "gemini_success",
  "gemini_timeout",
  "gemini_quota_failure",
  "gemini_invalid_output",
  "gemini_validation_rejection",
  "ai_cache_hit",
  "ai_fallback",
  "ai_budget_rejection",
  "ai_rate_limit_rejection",
  "ai_protection_unavailable",
  // Provider-neutral AI metrics (Phase 3C). The `provider` field is `gemini` or `groq`.
  "ai_provider_request",
  "ai_provider_success",
  "ai_provider_failure",
  "ai_provider_fallback",
  "ai_cache_miss",
  "ai_latency_ms_total",
  "ai_tokens_input",
  "ai_tokens_output",
  "ai_tokens_total",
  "ai_tokens_unreported",
] as const;

export type AirMetricName = (typeof AIR_METRIC_NAMES)[number];

/** Metrics too frequent to log individually; they are counted only. */
const COUNT_ONLY: ReadonlySet<AirMetricName> = new Set(["cache_hit", "cache_miss", "ai_cache_miss", "ai_latency_ms_total", "ai_tokens_input", "ai_tokens_output", "ai_tokens_total", "ai_tokens_unreported"]);

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["cityId", "code", "status", "kind", "layer", "operation", "provider"]);

export type MetricFields = Readonly<Record<string, string | number | undefined>>;

export interface AirMetrics {
  /** `amount` defaults to 1; used for sums such as tokens and milliseconds. */
  increment(name: AirMetricName, fields?: MetricFields, amount?: number): void;
  /** Counts since this process started. */
  snapshot(): Readonly<Record<AirMetricName, number>>;
}

export const noopMetrics: AirMetrics = {
  increment() {},
  snapshot: () => emptyCounts(),
};

function emptyCounts(): Record<AirMetricName, number> {
  return Object.fromEntries(AIR_METRIC_NAMES.map((name) => [name, 0])) as Record<AirMetricName, number>;
}

/** Keep only allow-listed, scalar fields. */
export function sanitizeFields(fields: MetricFields | undefined): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  if (fields === undefined) return safe;
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key) && value !== undefined) safe[key] = value;
  }
  return safe;
}

/** At most one log line per metric per this interval. */
export const METRIC_LOG_INTERVAL_MS = 60_000;

/** `emit` receives one JSON line; the default writes it with `console.warn`. `now` is injectable for tests. */
export function createAirMetrics(
  emit: (line: string) => void = (line) => console.warn(line),
  now: () => number = () => Date.now(),
): AirMetrics {
  const counts = emptyCounts();
  const lastLoggedMs = new Map<AirMetricName, number>();
  return {
    increment(name, fields, amount = 1) {
      counts[name] += amount;
      if (COUNT_ONLY.has(name)) return;
      const nowMs = now();
      const last = lastLoggedMs.get(name);
      if (last !== undefined && nowMs - last < METRIC_LOG_INTERVAL_MS) return;
      lastLoggedMs.set(name, nowMs);
      emit(JSON.stringify({ level: "warn", event: "air.metric", metric: name, ...sanitizeFields(fields), count: counts[name] }));
    },
    snapshot: () => ({ ...counts }),
  };
}
