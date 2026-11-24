import "server-only";

import {
  getAiSettings,
  getGeminiConfig,
  getGroqConfig,
  InvalidEnvError,
  MissingGeminiKeyError,
  MissingGroqKeyError,
  type AiProviderId,
  type AiSettings,
  type EnvSource,
} from "@/lib/env";

import type { AiReasonCode } from "./errors";
import type { ProviderTarget } from "./provider";

/**
 * Resolves everything the explanation layer needs, from the existing environment utilities, and never
 * throws: a bad setting becomes an `unavailable` result with a reason code, so the application keeps
 * serving deterministic recommendations.
 *
 * Providers: the configured order (`AI_PROVIDER_ORDER`, default `gemini,groq`) filtered to providers
 * that are actually usable. A provider with no key, or with an invalid model name, is SKIPPED, never
 * substituted: a missing Gemini key does not stop Groq, a missing Groq key does not stop Gemini, and
 * no provider that is not configured is ever called. If none is usable the result is `unavailable`
 * (AI_INVALID_CONFIG when a configured provider was invalid, otherwise AI_NOT_CONFIGURED).
 *
 * Models: `GEMINI_MODEL` (default `gemini-3.5-flash`) and `GROQ_MODEL` (default `openai/gpt-oss-20b`),
 * both validated by `env.ts`. The layer NEVER switches model after a failure: a model error is a
 * fallback to the next provider or to deterministic text, not a retry on another model. A metadata
 * lookup alone does not prove a model works for generation; defaults are confirmed with a real call.
 */
export interface AiRuntimeConfig {
  readonly status: "ready";
  /** Usable providers in call order. Never empty. Each `apiKey` is non-enumerable. */
  readonly providers: readonly ProviderTarget[];
  readonly settings: AiSettings;
}

export type AiConfigResult =
  | AiRuntimeConfig
  | { readonly status: "unavailable"; readonly reason: Extract<AiReasonCode, "AI_DISABLED" | "AI_NOT_CONFIGURED" | "AI_INVALID_CONFIG"> };

function target(id: AiProviderId, model: string, apiKey: string): ProviderTarget {
  const t = { id, model };
  Object.defineProperty(t, "apiKey", { value: apiKey, enumerable: false, writable: false });
  return Object.freeze(t) as ProviderTarget;
}

export function resolveAiConfig(env: EnvSource = process.env): AiConfigResult {
  let settings: AiSettings;
  try {
    settings = getAiSettings(env);
  } catch (error) {
    if (error instanceof InvalidEnvError) return { status: "unavailable", reason: "AI_INVALID_CONFIG" };
    throw error;
  }
  if (!settings.enabled) return { status: "unavailable", reason: "AI_DISABLED" };

  const providers: ProviderTarget[] = [];
  let sawInvalid = false;
  for (const id of settings.providerOrder) {
    try {
      if (id === "gemini") {
        const c = getGeminiConfig(env);
        providers.push(target("gemini", c.model, c.apiKey));
      } else {
        const c = getGroqConfig(env);
        providers.push(target("groq", c.model, c.apiKey));
      }
    } catch (error) {
      if (error instanceof MissingGeminiKeyError || error instanceof MissingGroqKeyError) continue;
      if (error instanceof InvalidEnvError) {
        sawInvalid = true;
        continue;
      }
      throw error;
    }
  }
  if (providers.length === 0) return { status: "unavailable", reason: sawInvalid ? "AI_INVALID_CONFIG" : "AI_NOT_CONFIGURED" };
  return Object.freeze({ status: "ready" as const, providers: Object.freeze(providers), settings });
}
