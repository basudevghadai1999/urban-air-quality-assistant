import "server-only";

import { z } from "zod";

import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  GROQ_API_KEY_ENV_KEY,
  GROQ_MODEL_ENV_KEY,
  GEMINI_ENV_KEYS,
  GEMINI_MODEL_ENV_KEY,
} from "@/lib/constants";
import {
  AIR_CONFIG_LIMITS,
  DEFAULT_AIR_SERVICE_CONFIG,
  type AirServiceConfig,
} from "@/lib/data/config";
import { parseRedisConfig, type RedisConfig } from "@/lib/redis/config";
import {
  DEFAULT_RATE_LIMIT_POLICY,
  RATE_LIMIT_BOUNDS,
  type RateLimitPolicy,
} from "@/lib/ratelimit/types";

/**
 * Server-only environment access.
 *
 * - `import "server-only"` makes the build fail if a Client Component ever
 *   imports this module, so the Gemini key cannot reach the browser bundle.
 * - Nothing here reads a `NEXT_PUBLIC_*` variable; those are inlined into
 *   client JavaScript and must never carry secrets.
 * - Errors and logs name the variable, never its value.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type GeminiKeySource =
  (typeof GEMINI_ENV_KEYS)[keyof typeof GEMINI_ENV_KEYS];

export interface GeminiConfig {
  /** Gemini model identifier, e.g. "gemini-3.5-flash". */
  readonly model: string;
  /** Which variable the key was read from (the name only, never the value). */
  readonly keySource: GeminiKeySource;
  /**
   * The API key. Defined as NON-enumerable so JSON.stringify, object spread
   * and console.log of the config object omit it. Read it explicitly.
   */
  readonly apiKey: string;
}

/** Thrown when no usable Gemini key is configured. Never contains a value. */
export class MissingGeminiKeyError extends Error {
  constructor() {
    super(
      `Gemini API key is not configured. Set ${GEMINI_ENV_KEYS.primary} (preferred) or ${GEMINI_ENV_KEYS.fallback} in the server environment.`,
    );
    this.name = "MissingGeminiKeyError";
  }
}

/** Thrown when a non-secret setting (the model name) is malformed. */
export class InvalidEnvError extends Error {
  constructor(variable: string) {
    super(`Environment variable ${variable} is invalid.`);
    this.name = "InvalidEnvError";
  }
}

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

/** A variable counts as "set" only if it holds a non-whitespace string. */
function readNonBlank(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Select the Gemini key. `GEMINI_API_KEY` wins over `GEMINI_KEY`.
 *
 * A blank `GEMINI_API_KEY` (for example, copied verbatim from
 * `.env.example`) is treated as unset, so it falls back to `GEMINI_KEY`
 * instead of masking a valid key.
 */
export function resolveGeminiKey(env: EnvSource = process.env): {
  apiKey: string;
  source: GeminiKeySource;
} {
  const primary = readNonBlank(env, GEMINI_ENV_KEYS.primary);
  if (primary !== undefined) {
    return { apiKey: primary, source: GEMINI_ENV_KEYS.primary };
  }

  const fallback = readNonBlank(env, GEMINI_ENV_KEYS.fallback);
  if (fallback !== undefined) {
    return { apiKey: fallback, source: GEMINI_ENV_KEYS.fallback };
  }

  throw new MissingGeminiKeyError();
}

/** Non-throwing check, for health and status code. Returns no secret material. */
export function isGeminiConfigured(env: EnvSource = process.env): boolean {
  try {
    resolveGeminiKey(env);
    return true;
  } catch (error) {
    if (error instanceof MissingGeminiKeyError) return false;
    throw error;
  }
}

/** Full, validated Gemini configuration. Throws if the key is missing. */
export function getGeminiConfig(env: EnvSource = process.env): GeminiConfig {
  const { apiKey, source } = resolveGeminiKey(env);

  const rawModel = readNonBlank(env, GEMINI_MODEL_ENV_KEY);
  const model =
    rawModel === undefined
      ? DEFAULT_GEMINI_MODEL
      : parseModel(rawModel);

  const config = { model, keySource: source };
  Object.defineProperty(config, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(config) as GeminiConfig;
}

/** Environment variables that tune the air data service. None are secret. */
export const AIR_ENV_KEYS = {
  ttlSeconds: "AIR_CACHE_TTL_SECONDS",
  maxStaleSeconds: "AIR_MAX_STALE_SECONDS",
  failureBackoffSeconds: "AIR_FAILURE_BACKOFF_SECONDS",
  upstreamTimeoutMs: "AIR_UPSTREAM_TIMEOUT_MS",
} as const satisfies Record<keyof AirServiceConfig, string>;

function readBoundedInteger(
  env: EnvSource,
  setting: keyof AirServiceConfig,
): number {
  const name = AIR_ENV_KEYS[setting];
  const { min, max } = AIR_CONFIG_LIMITS[setting];
  const raw = readNonBlank(env, name);
  if (raw === undefined) return DEFAULT_AIR_SERVICE_CONFIG[setting];
  const result = z.coerce.number().int().min(min).max(max).safeParse(raw);
  // Only the variable NAME is reported, never its value.
  if (!result.success) throw new InvalidEnvError(name);
  return result.data;
}

/**
 * Air data service settings from the environment, falling back to defaults
 * (15-minute TTL). Throws `InvalidEnvError` naming the variable if a value is
 * out of range, never echoing it.
 */
export function getAirServiceConfig(env: EnvSource = process.env): AirServiceConfig {
  const config: AirServiceConfig = {
    ttlSeconds: readBoundedInteger(env, "ttlSeconds"),
    maxStaleSeconds: readBoundedInteger(env, "maxStaleSeconds"),
    failureBackoffSeconds: readBoundedInteger(env, "failureBackoffSeconds"),
    upstreamTimeoutMs: readBoundedInteger(env, "upstreamTimeoutMs"),
  };
  if (config.maxStaleSeconds < config.ttlSeconds) {
    throw new InvalidEnvError(AIR_ENV_KEYS.maxStaleSeconds);
  }
  return config;
}

/** Names of the Redis connection variables. Server-side only: never give them a NEXT_PUBLIC_ prefix. */
export const REDIS_ENV_KEYS = {
  url: "UPSTASH_REDIS_REST_URL",
  token: "UPSTASH_REDIS_REST_TOKEN",
} as const;

export type RedisSetting =
  | { readonly status: "not-configured" }
  | { readonly status: "configured"; readonly config: RedisConfig }
  /** A variable is missing or malformed. Only its NAME is reported, never its value. */
  | { readonly status: "invalid"; readonly variable: (typeof REDIS_ENV_KEYS)[keyof typeof REDIS_ENV_KEYS] };

/**
 * Redis (Upstash REST) settings. Never throws: an unusable setting must degrade the
 * app to memory-only operation, not take the API down. The caller decides how loudly
 * to report `invalid`.
 */
export function getRedisConfig(env: EnvSource = process.env): RedisSetting {
  const url = readNonBlank(env, REDIS_ENV_KEYS.url);
  const token = readNonBlank(env, REDIS_ENV_KEYS.token);
  if (url === undefined && token === undefined) return { status: "not-configured" };
  if (url === undefined) return { status: "invalid", variable: REDIS_ENV_KEYS.url };
  if (token === undefined) return { status: "invalid", variable: REDIS_ENV_KEYS.token };

  const parsed = parseRedisConfig(url, token);
  if (parsed.ok) return { status: "configured", config: parsed.config };
  return { status: "invalid", variable: parsed.problem === "url" ? REDIS_ENV_KEYS.url : REDIS_ENV_KEYS.token };
}

export const RATE_LIMIT_ENV_KEYS = {
  limit: "AIR_RATE_LIMIT_MAX",
  windowSeconds: "AIR_RATE_LIMIT_WINDOW_SECONDS",
} as const satisfies Record<keyof RateLimitPolicy, string>;

/**
 * Per-client rate limit for /api/air (default 30 requests per 60 seconds).
 * Throws `InvalidEnvError` naming the variable for an out-of-range value, never echoing it.
 */
export function getRateLimitPolicy(env: EnvSource = process.env): RateLimitPolicy {
  const read = (setting: keyof RateLimitPolicy): number => {
    const name = RATE_LIMIT_ENV_KEYS[setting];
    const { min, max } = RATE_LIMIT_BOUNDS[setting];
    const raw = readNonBlank(env, name);
    if (raw === undefined) return DEFAULT_RATE_LIMIT_POLICY[setting];
    const result = z.coerce.number().int().min(min).max(max).safeParse(raw);
    if (!result.success) throw new InvalidEnvError(name);
    return result.data;
  };
  return { limit: read("limit"), windowSeconds: read("windowSeconds") };
}

/** Environment variables that tune Gemini explanations. None are secret. */
export const AI_ENV_KEYS = {
  enabled: "AI_EXPLANATIONS_ENABLED",
  timeoutMs: "AI_REQUEST_TIMEOUT_MS",
  maxOutputTokens: "AI_MAX_OUTPUT_TOKENS",
  thinkingBudget: "AI_THINKING_BUDGET",
  rateLimitMax: "AI_RATE_LIMIT_MAX",
  rateLimitWindowSeconds: "AI_RATE_LIMIT_WINDOW_SECONDS",
  dailyBudget: "AI_DAILY_BUDGET",
  cacheTtlSeconds: "AI_CACHE_TTL_SECONDS",
  providerOrder: "AI_PROVIDER_ORDER",
  geminiDailyBudget: "AI_GEMINI_DAILY_BUDGET",
  groqDailyBudget: "AI_GROQ_DAILY_BUDGET",
} as const;

export const AI_PROVIDER_IDS = ["gemini", "groq"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AiSettings {
  /** Kill switch: false means no Gemini call is ever made. */
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** Null: leave the model's own thinking default alone (the generator applies a model-aware default). */
  readonly thinkingBudget: number | null;
  /** Per-client limit on Gemini GENERATIONS (cache hits and fallbacks do not count). */
  readonly rateLimit: RateLimitPolicy;
  /** Global provider CALLS (attempts) per UTC day, across every provider. */
  readonly dailyBudget: number;
  /** Per-provider calls per UTC day. A call counts against its provider AND the global budget. */
  readonly providerDailyBudget: Readonly<Record<AiProviderId, number>>;
  /** Providers to try, in order. Only providers that are configured are ever called. */
  readonly providerOrder: readonly AiProviderId[];
  readonly cacheTtlSeconds: number;
}

export const AI_SETTING_LIMITS = Object.freeze({
  timeoutMs: { min: 2_000, max: 60_000, default: 20_000 },
  maxOutputTokens: { min: 500, max: 8_192, default: 3_000 },
  thinkingBudget: { min: 0, max: 24_576 },
  rateLimitMax: { min: 1, max: 1_000, default: 5 },
  rateLimitWindowSeconds: { min: 1, max: 3_600, default: 60 },
  dailyBudget: { min: 1, max: 100_000, default: 300 },
  cacheTtlSeconds: { min: 60, max: 86_400, default: 1_800 },
  geminiDailyBudget: { min: 1, max: 100_000, default: 200 },
  groqDailyBudget: { min: 1, max: 100_000, default: 200 },
});

/** Default provider order: Gemini first, Groq second. */
export const DEFAULT_AI_PROVIDER_ORDER: readonly AiProviderId[] = Object.freeze(["gemini", "groq"] as const);

function parseProviderOrder(raw: string | undefined): readonly AiProviderId[] {
  if (raw === undefined) return DEFAULT_AI_PROVIDER_ORDER;
  const out: AiProviderId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!(AI_PROVIDER_IDS as readonly string[]).includes(id)) throw new InvalidEnvError(AI_ENV_KEYS.providerOrder);
    if (!out.includes(id as AiProviderId)) out.push(id as AiProviderId);
  }
  if (out.length === 0) throw new InvalidEnvError(AI_ENV_KEYS.providerOrder);
  return out;
}

/**
 * Gemini explanation settings. Throws `InvalidEnvError` naming the variable (never its value) for an
 * out-of-range or malformed setting. Defaults: 5 generations per client per minute, 300 per UTC day,
 * 20 s timeout, 3000 output tokens, 30-minute explanation cache.
 */
export function getAiSettings(env: EnvSource = process.env): AiSettings {
  const integer = (name: string, min: number, max: number, fallback: number): number => {
    const raw = readNonBlank(env, name);
    if (raw === undefined) return fallback;
    const result = z.coerce.number().int().min(min).max(max).safeParse(raw);
    if (!result.success) throw new InvalidEnvError(name);
    return result.data;
  };
  const L = AI_SETTING_LIMITS;

  const rawEnabled = readNonBlank(env, AI_ENV_KEYS.enabled);
  let enabled = true;
  if (rawEnabled !== undefined) {
    const lowered = rawEnabled.toLowerCase();
    if (lowered === "true" || lowered === "1") enabled = true;
    else if (lowered === "false" || lowered === "0") enabled = false;
    else throw new InvalidEnvError(AI_ENV_KEYS.enabled);
  }

  const rawThinking = readNonBlank(env, AI_ENV_KEYS.thinkingBudget);
  const thinkingBudget =
    rawThinking === undefined
      ? null
      : integer(AI_ENV_KEYS.thinkingBudget, L.thinkingBudget.min, L.thinkingBudget.max, 0);

  return {
    enabled,
    timeoutMs: integer(AI_ENV_KEYS.timeoutMs, L.timeoutMs.min, L.timeoutMs.max, L.timeoutMs.default),
    maxOutputTokens: integer(AI_ENV_KEYS.maxOutputTokens, L.maxOutputTokens.min, L.maxOutputTokens.max, L.maxOutputTokens.default),
    thinkingBudget,
    rateLimit: {
      limit: integer(AI_ENV_KEYS.rateLimitMax, L.rateLimitMax.min, L.rateLimitMax.max, L.rateLimitMax.default),
      windowSeconds: integer(AI_ENV_KEYS.rateLimitWindowSeconds, L.rateLimitWindowSeconds.min, L.rateLimitWindowSeconds.max, L.rateLimitWindowSeconds.default),
    },
    dailyBudget: integer(AI_ENV_KEYS.dailyBudget, L.dailyBudget.min, L.dailyBudget.max, L.dailyBudget.default),
    providerDailyBudget: {
      gemini: integer(AI_ENV_KEYS.geminiDailyBudget, L.geminiDailyBudget.min, L.geminiDailyBudget.max, L.geminiDailyBudget.default),
      groq: integer(AI_ENV_KEYS.groqDailyBudget, L.groqDailyBudget.min, L.groqDailyBudget.max, L.groqDailyBudget.default),
    },
    providerOrder: parseProviderOrder(readNonBlank(env, AI_ENV_KEYS.providerOrder)),
    cacheTtlSeconds: integer(AI_ENV_KEYS.cacheTtlSeconds, L.cacheTtlSeconds.min, L.cacheTtlSeconds.max, L.cacheTtlSeconds.default),
  };
}

/** True for a production deployment: any NODE_ENV=production run (`next start` sets it; Render's build and start commands use it). */
export function isProductionRuntime(env: EnvSource = process.env): boolean {
  return env.NODE_ENV === "production";
}

function parseModel(value: string): string {
  const result = modelSchema.safeParse(value);
  if (!result.success) throw new InvalidEnvError(GEMINI_MODEL_ENV_KEY);
  return result.data;
}


/* ------------------------------- Groq (secondary provider) ------------------------------- */

/** Thrown when no Groq key is configured. Never contains a value. */
export class MissingGroqKeyError extends Error {
  constructor() {
    super(`Groq API key is not configured. Set ${GROQ_API_KEY_ENV_KEY} in the server environment.`);
    this.name = "MissingGroqKeyError";
  }
}

export interface GroqConfig {
  readonly model: string;
  /** Non-enumerable: JSON.stringify, spread and console.log omit it. */
  readonly apiKey: string;
}

/** Non-throwing presence check. Returns no secret material. */
export function isGroqConfigured(env: EnvSource = process.env): boolean {
  return readNonBlank(env, GROQ_API_KEY_ENV_KEY) !== undefined;
}

/** Validated Groq configuration. Throws `MissingGroqKeyError` or `InvalidEnvError` (variable name only). */
export function getGroqConfig(env: EnvSource = process.env): GroqConfig {
  const apiKey = readNonBlank(env, GROQ_API_KEY_ENV_KEY);
  if (apiKey === undefined) throw new MissingGroqKeyError();
  const rawModel = readNonBlank(env, GROQ_MODEL_ENV_KEY);
  let model = DEFAULT_GROQ_MODEL;
  if (rawModel !== undefined) {
    const parsed = modelSchema.safeParse(rawModel);
    if (!parsed.success) throw new InvalidEnvError(GROQ_MODEL_ENV_KEY);
    model = parsed.data;
  }
  const config = { model };
  Object.defineProperty(config, "apiKey", { value: apiKey, enumerable: false, writable: false });
  return Object.freeze(config) as GroqConfig;
}
