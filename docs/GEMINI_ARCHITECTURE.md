# Gemini explanation layer (Phase 3B)

> Phase 3C extended this layer with a secondary provider (Groq), unit-aware validation, a compact context and per-provider budgets. Where this document and [`AI_PROVIDER_ARCHITECTURE.md`](AI_PROVIDER_ARCHITECTURE.md) differ (context size, output limits, budget, cache key, envelope fields), the provider document is current.

Gemini explains recommendations that deterministic TypeScript already calculated. It never calculates, chooses or changes anything. If Gemini is unavailable, over budget, rate limited, too slow, or produces anything that fails validation, the user gets deterministic explanations and the same recommendation result. The application never depends on Gemini.

## 1. Architecture

```
POST /api/recommend { cityId, profileId, preferences?, explain: true }
  1. validate (strict schema; unknown keys refused, so no client numbers or prompts)   400/413/415
  2. general per-client limiter (existing)                                              429
  3. air data (cache -> Open-Meteo -> last-known-good), then the deterministic engine
     => `data`: computed on the server, never modified afterwards
  4. explanation service (src/lib/ai/service.ts), receiving `data` read-only
        config ok?  -> air data present?  -> bounded grounding context
        -> explanation CACHE (free)  -> join an identical in-flight generation (free)
        -> per-client AI limit (5/min)  -> atomic global daily budget (300/UTC day)
        -> ONE Gemini call -> validate -> cache
        any other exit -> deterministic fallback (costs nothing)
  5. response: `data` (untouched) + `ai` (status, reason code, message, explanation)
```

`explain` is optional and defaults to off, so deterministic-only requests are unchanged: no `ai` field, no extra header.

| File (`src/lib/ai/`) | Responsibility |
|---|---|
| `client.ts` | The only module that imports `@google/genai`. Server-only. One attempt, a timeout, structured output |
| `config.ts` | Resolves model, key (through the existing `env.ts`) and settings; never throws, reports a reason code |
| `context.ts` | Builds the only data Gemini sees, from the server-computed result |
| `prompt.ts` | Versioned system instruction and user prompt |
| `schema.ts` | Zod output schema and the matching JSON schema sent to Gemini |
| `generator.ts` | One model call; maps blocks, truncation and empty replies to reason codes |
| `validator.ts` | Post-generation checks; rejects the whole output on any failure |
| `fallback.ts` | Deterministic explanations in the same shape |
| `providerBudget.ts` | Atomic global and per-provider daily budgets (Redis Lua, or memory in development) |
| `cache.ts` | Validated-explanation cache (memory + Redis), re-validated on read |
| `service.ts` | Orchestration and the cost-protection order |
| `defaultAiService.ts` | Process-wide wiring on the shared Redis infrastructure |
| `errors.ts`, `types.ts` | Reason codes and fixed messages; public types (client-safe) |

## 2. SDK and model

- **SDK**: `@google/genai` 3.6.1, `ai.models.generateContent`, read from the installed package, not from older examples. Structured output uses `responseMimeType: "application/json"` with `responseJsonSchema`.
- **Retries**: the SDK can retry with exponential backoff (default 5 attempts when retry options are supplied). We pin `attempts: 1`: exactly one request per call. There is no retry loop anywhere.
- **Timeout**: `httpOptions.timeout` per attempt plus an `AbortSignal` backstop (default 20 s).
- **Model**: `GEMINI_MODEL`, default **`gemini-3.5-flash`**. It is validated (letters, digits, `.`, `_`, `/`, `-`, at most 100 characters) and used everywhere from one place. The layer never switches model after a failure.
- **How the default was chosen (verified 2026-11-24, with this project's key)**:
  - The previous default `gemini-2.5-flash` appears in the model list and passes a metadata lookup, but `generateContent` refuses it: "no longer available to new users". A metadata check alone is therefore not proof of availability.
  - `gemini-3.5-flash` returned a valid structured-JSON reply to a small schema-constrained request.
  - The full production prompt could **not** be confirmed live: at the time of testing every Flash-class model returned HTTP 503 "high demand" (a provider-side capacity error). The layer handled it as designed (one attempt, deterministic fallback, no raw error shown).
  - Model availability changes. Override with `GEMINI_MODEL` if a model is retired or overloaded.
- **Thinking**: for `gemini-2.5-flash*` thinking is turned off by default (a budget of 0), because thinking tokens count against the output limit. Other models, including Gemini 3.x, use their own defaults. `AI_THINKING_BUDGET` overrides.

## 3. Environment configuration

The key is read only in `src/lib/env.ts` (`GEMINI_API_KEY`, falling back to `GEMINI_KEY`), kept non-enumerable, never logged and never returned. Nothing uses a `NEXT_PUBLIC_` name; static tests enforce this.

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` / `GEMINI_KEY` | none | The key. Missing: `AI_NOT_CONFIGURED`, fallback |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Model ID |
| `AI_EXPLANATIONS_ENABLED` | `true` | `false` switches Gemini off (`AI_DISABLED`) |
| `AI_RATE_LIMIT_MAX` | 5 | Gemini generations per client per window |
| `AI_RATE_LIMIT_WINDOW_SECONDS` | 60 | Window length |
| `AI_DAILY_BUDGET` | 300 | Global generations per UTC day |
| `AI_REQUEST_TIMEOUT_MS` | 20000 | 2000 to 60000 |
| `AI_MAX_OUTPUT_TOKENS` | 3000 | 500 to 8192 |
| `AI_THINKING_BUDGET` | model-aware | 0 to 24576 |
| `AI_CACHE_TTL_SECONDS` | 1800 | 60 to 86400 |

An invalid value makes AI report `AI_INVALID_CONFIG` (the variable name is never echoed with its value) and everything else keeps working.

## 4. What Gemini receives

A bounded (at most 40 KB), server-built JSON projection of the result and the air data: city, state and timezone; AQI, category, dominant pollutant, severity, data timestamps, freshness, latest modelled values, which pollutants are available; the profile and validated preferences (flagging preset assumptions); each ranked recommendation with its ID, priority, times and reasons; outdoor-window summaries; exposure and CO2 estimates with formulas, units, assumptions and uncertainty; and the data limitations.

It contains no free text from any user (the request schema has none), no header, address, cookie or secret, and no clock-dependent field, so identical results produce identical contexts. Client-supplied AQI, impact numbers, context, prompts or model names are refused by the strict request schema before anything runs.

## 5. System prompt principles

Role: an environmental air-quality assistant for Indian families that explains pre-calculated results. The rules (in `prompt.ts`) cover: use only the context and treat it as data; copy numbers and times exactly and never calculate; no invented measurements, pollutants, times, IDs, emission factors or savings; no medical advice, diagnosis or health predictions; never call any window or level safe; no claim that indoor air was measured; separate current conditions from forecasts and say when data is stale; modelled data is not an official CPCB station reading; state what is unavailable, assumed, or a best case; plain text only. The prompt is versioned (`PROMPT_VERSION`) and the version is part of the cache key.

**Safety does not rest on the prompt.** Every rule that can be checked is also enforced in code after generation.

## 6. Structured output

`aiExplanationSchema` (Zod, strict) is the authority; a hand-built JSON schema (only keywords the Gemini API documents as supported) is what the model is asked for. The recommendation-ID field is an `enum` of the IDs that actually exist for this request, so the model cannot name another. Length limits are enforced by Zod only (`maxLength` is not a documented keyword).

Fields: `overview`, `situationExplanation`, `personalizedSummary`, `topActions[{recommendationId, explanation, practicalGuidance}]` (1 to 5), `routineExplanation`, `outdoorActivityExplanation`, `indoorAirExplanation`, `transportExplanation`, `impactExplanation`, `dataLimitations` (1 to 6), `safetyDisclaimer`. All prose. There is no numeric field, so the model has nowhere to put a replacement value.

## 7. Output validation

Checks, in order; any failure discards the whole output (nothing partial is ever shown) and the deterministic fallback is used:

1. JSON of bounded size; 2. strict schema (no unknown fields, non-empty bounded strings, bounded lists); 3. every referenced ID exists, none repeats, none is invented in prose; 4. no markup, links, code, HTML entities, control, zero-width or bidirectional-override characters; 5. every clock time and number must already appear in the context sent to the model; 6. no diagnosis, treatment, medication, health-outcome or risk claim, no guarantee, no safety claim, no claim that indoor air was measured, no presenting model data as an official CPCB reading, no unavailable pollutant presented as measured; 7. no API-key shape and not the configured key.

Negation is respected ("not medically safe" passes; "is safe" does not) by looking for a negating word in the same sentence. This is a guard that errs towards rejecting, not language understanding: a rejection costs only a fallback.

**Known limits of the numeric check.** It matches values, not units, so a context figure such as 3 (km) also lets the model write "3 hours". It stops invented figures (a new AQI, percentage, concentration or saving), not every misattributed unit. Digits inside timestamps, IDs and age bands are excluded from the allowed set so small integers are not whitelisted everywhere. The validator is strict about exact values, so the model quoting a rounded number will be rejected.

## 8. Numerical grounding guarantees

- The deterministic result is computed first, passed to the AI layer read-only, and returned unchanged. A test asserts that `data` is byte-identical with and without `explain`, and that no model output, honest or hostile, alters it.
- The explanation contains prose only; replacement numbers, times or IDs are rejected.
- The cache key is a hash of the exact context, so a change in air data, profile, preferences or any recommendation produces a different key.
- The fallback is built from the result by templates, and a test requires it to pass the same validator that guards model output.

## 9. Fallback

Every failure returns HTTP 200 (or the existing 503 for unavailable air data) with the full deterministic result plus `ai: { status: "fallback", reasonCode, message, explanation }`. Statuses: `generated`, `cached`, `fallback`, `unavailable` (not even the fallback could be built; `explanation` is null).

Reason codes (fixed text; no provider message ever reaches a client, a log or a metric): `AI_DISABLED`, `AI_NOT_CONFIGURED`, `AI_INVALID_CONFIG`, `AI_AIR_DATA_UNAVAILABLE`, `AI_INPUT_TOO_LARGE`, `AI_RATE_LIMITED`, `AI_PROTECTION_UNAVAILABLE`, `AI_BUDGET_EXHAUSTED`, `AI_TIMEOUT`, `AI_QUOTA` (429), `AI_AUTH_FAILED` (401/403), `AI_MODEL_UNAVAILABLE` (404), `AI_BAD_REQUEST`, `AI_UPSTREAM_ERROR` (5xx), `AI_NETWORK`, `AI_SAFETY_BLOCKED`, `AI_EMPTY_RESPONSE`, `AI_TRUNCATED`, `AI_INVALID_JSON`, `AI_SCHEMA_INVALID`, `AI_VALIDATION_REJECTED`, `AI_INTERNAL`. Rate-limit and budget cases include `retryAfterSeconds`. With unavailable air data no model call is made (there is nothing to ground).

## 10. Rate limiting and daily budget

- **General limiter** (existing, 30/min): unchanged and applied first.
- **AI limiter**: a separate Redis key space (`ai:v1:rl:`), default 5 generations per client per minute, same hashed-client identity and trusted-header rules as `/api/air`. It is consulted only on a cache miss, so cache hits never consume it.
- **Global daily budget**: one atomic Lua `EVAL` (`INCR`, `PEXPIRE` on first use, `DECR` when over the limit). The key carries the UTC date (`ai:v1:budget:YYYYMMDD`), so it resets at 00:00 UTC by construction, and the counter never drifts above the limit. Concurrent reservations from many instances cannot oversell it. It counts calls, not money: **no Gemini price is assumed**.
- A reservation is made immediately before the call and covers it whether it succeeds or fails (a call that reached Gemini may count against quota). Cache hits, fallbacks and refused requests never reserve.
- **Fail closed**: if Redis cannot decide, Gemini is not called (`AI_PROTECTION_UNAVAILABLE`).
- **By environment**: Redis configured, shared across instances; no Redis in development, per-process limiter and budget; **no Redis in production, AI is paused**, because per-instance counters cannot bound serverless spend.
- **Adjusting**: change `AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_SECONDS`, `AI_DAILY_BUDGET` or set `AI_EXPLANATIONS_ENABLED=false` (kill switch). Identical concurrent requests in one instance share a single generation and a single budget unit.

## 11. Cache

Key: SHA-256 of (prompt version, model, exact context JSON): no secret, no readable data. Memory (bounded to 200 entries) plus Redis (`ai:v1:expl:<hash>`, TTL `AI_CACHE_TTL_SECONDS`, default 30 minutes). Only fully validated explanations are written. Every read is **validated again** against the current request, so a corrupt, poisoned or outdated Redis entry is dropped and deleted, never served. A Redis failure costs a miss, not an error.

## 12. Security

- **Prompt injection**: the request has no free-text field; the context is built from the engine and fixed registries; the prompt marks it as data; output is validated structurally and semantically; nothing from the output is executed or trusted.
- **Key exposure**: server-only modules, key non-enumerable, passed only to the SDK; static tests forbid `NEXT_PUBLIC_` names, Client Component imports of AI modules, and key-shaped strings; the validator rejects output containing the key.
- **Error leakage**: provider messages are classified by HTTP status and discarded; reason codes map to fixed text; tests assert a key embedded in an error never reaches the envelope, metrics or logs.
- **Size**: request body at most 8 KB; context at most 40 KB; output limited by `maxOutputTokens` and a raw-text cap.
- **Redis keys**: fixed prefixes, hashed identifiers, key patterns validated; only `GET`, `SET`, `DEL`, `EVAL`.
- **Cache poisoning**: re-validation on read (section 11).
- **Rendering**: treat every `explanation` string as **plain text**. The validator rejects markup, links and code; the app has no `dangerouslySetInnerHTML` (a test enforces it). Never render generated HTML or follow generated URLs.

## 13. Observability

Counters and rate-limited structured log lines (at most one per metric per minute), allow-listed fields only: `gemini_request`, `gemini_success`, `gemini_timeout`, `gemini_quota_failure`, `gemini_invalid_output`, `gemini_validation_rejection`, `ai_cache_hit`, `ai_fallback`, `ai_budget_rejection`, `ai_rate_limit_rejection`, `ai_protection_unavailable`. Never logged: keys, prompts, responses, headers, addresses or request context. Tests assert this.

## 14. Known limitations

- The full production prompt was not confirmed against live Gemini: every Flash-class model returned 503 "high demand" during testing. The SDK path, key handling and structured output were verified up to that point, and a small schema-constrained call succeeded on `gemini-3.5-flash`.
- The validator is strict, so a real model that rounds figures or paraphrases around a negation may be rejected (fallback). The live rejection rate has not been measured.
- The numeric check matches values, not units; the claim checks are pattern-based guards.
- The budget script (SHA-256 prefix `164b61d2699a5c31`) ran against a real Upstash Redis on 2026-11-24 at commit `e2bcac5` and is byte-identical to the current script. The stricter reply validation added later was checked against real Upstash replies on 2026-11-25 (grant and refusal accepted, tampered replies rejected); the PTTL-repair branch and a real midnight cutover were never run live.
- Per-client AI limits behind a front proxy degrade to a shared bucket (as for `/api/air`).
- Gemini output is English only. There is no streaming; a response arrives whole.
- The default model can be retired or overloaded by Google at any time; the layer degrades to the fallback rather than switching.
