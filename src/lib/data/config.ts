/** Air data service settings. Client-safe: contains no secrets. See `getAirServiceConfig` for env overrides. */

export interface AirServiceConfig {
  /** How long a fetched snapshot counts as fresh. Default 15 minutes. */
  readonly ttlSeconds: number;
  /** Oldest snapshot still served (marked stale) when the provider is down. Default 24 hours. */
  readonly maxStaleSeconds: number;
  /** After a provider failure, do not call it again for this long. Protects the free quota. */
  readonly failureBackoffSeconds: number;
  /** Per-request timeout for the provider call. */
  readonly upstreamTimeoutMs: number;
}

export const DEFAULT_AIR_SERVICE_CONFIG: AirServiceConfig = Object.freeze({
  ttlSeconds: 900,
  maxStaleSeconds: 86_400,
  failureBackoffSeconds: 60,
  upstreamTimeoutMs: 8_000,
});

/** Allowed ranges for the env-overridable settings. */
export const AIR_CONFIG_LIMITS = Object.freeze({
  ttlSeconds: { min: 60, max: 3_600 },
  maxStaleSeconds: { min: 60, max: 604_800 },
  failureBackoffSeconds: { min: 5, max: 3_600 },
  upstreamTimeoutMs: { min: 1_000, max: 30_000 },
});
