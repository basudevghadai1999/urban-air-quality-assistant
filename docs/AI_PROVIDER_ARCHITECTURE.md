# AI provider architecture (Phase 3C)

Gemini is the primary explanation provider, Groq is the secondary, and deterministic templates are the final fallback. Providers only **explain** results that deterministic TypeScript already calculated. They never calculate, choose or change anything, and the application never depends on either of them.

## 1. Flow

```
POST /api/recommend { ..., explain: true }
  validate -> general limiter -> air data -> deterministic engine  =>  `data` (never modified afterwards)
  AI layer (src/lib/ai/service.ts), read-only on `data`:
    config      providers = AI_PROVIDER_ORDER filtered to those with a usable key and model
    context     compact grounding context (<= 18 000 bytes, typically ~13 000)
    cache       for each provider in order: lookup, re-validated on read          free
    single-flight   identical concurrent requests share one chain                  free
    client limit    5 generation requests per client per minute, ONCE per request
    for each provider in order:
        budget      one atomic reservation: global counter + that provider's counter
        ONE call    no retries; timeout; bounded output tokens
        validate    the SAME validator for every provider
        cache       only a fully validated explanation
    deterministic fallback  (never costs budget)
  response: { ok, data, ai: { status, provider, model, reasonCode, attempts?, tokenUsage?, explanation } }
```

`ai.status` is `generated`, `cached`, `fallback` or `unavailable`. `ai.provider` is `gemini`, `groq` or `deterministic`; the same value is sent as `X-AI-Provider`. `ai.attempts` lists providers that failed or were skipped first, each with a sanitized reason code. No raw provider error is ever returned or logged.

### What was reused from Phase 3B (unchanged in role)
`schema.ts` (Zod), `validator.ts`, `fallback.ts`, `cache.ts`, `errors.ts` (taxonomy), `prompt.ts`, the rate-limit gate, Redis client and `FakeRedis`, metrics. Modified: `config.ts` (provider list), `generator.ts` (provider-neutral), `service.ts` (chain), `context.ts` (compact), `client.ts` (token usage). New: `provider.ts`, `groqClient.ts`, `providerBudget.ts`.

## 2. Provider selection and failure classification

| Failure | Next provider? | Why |
|---|---|---|
| timeout, 429, 5xx, network error | yes | the provider is unavailable |
| 401/403 (key refused), 404 (model gone) | yes | this provider is unusable; the other has its own key and model |
| empty answer, truncated, malformed JSON, schema failure | yes | output unusable; recoverable |
| validation rejection (invented figure, unit mismatch, unsafe claim) | yes | the same validator gates the next provider, so rejected text is never shown |
| safety refusal (`SAFETY`, blocked prompt) | **no** | a refusal is a decision, not an outage |
| 4xx bad request | **no** | our request is wrong; resending repeats the bug |
| internal error, disabled, not configured, no air data, input too large, rate limited, budget exhausted, protection unavailable | **no** | not provider outages; most are not provider failures at all |

A provider without a key is **skipped**, never substituted: a missing Gemini key does not stop Groq and a missing Groq key does not stop Gemini. With neither, the deterministic explanation is returned (`AI_NOT_CONFIGURED`). An invalid `GROQ_MODEL` disables only Groq. The code is `isFailoverEligible` in `errors.ts`, and a test pins the table.

## 3. Environment

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` / `GEMINI_KEY` | none | secret, server only |
| `GEMINI_MODEL` | `gemini-3.5-flash` | |
| `GROQ_API_KEY` | none | secret, server only. Never `NEXT_PUBLIC_` |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | |
| `AI_PROVIDER_ORDER` | `gemini,groq` | comma list; unknown names are an invalid config |
| `AI_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` | 5 / 60 | per client, per request |
| `AI_DAILY_BUDGET` | 300 | **global** provider calls per UTC day |
| `AI_GEMINI_DAILY_BUDGET` | 200 | Gemini calls per UTC day |
| `AI_GROQ_DAILY_BUDGET` | 200 | Groq calls per UTC day |
| `AI_REQUEST_TIMEOUT_MS` | 20000 | per provider call. The whole chain also has one deadline, `max(timeout, min(2 x timeout, 45 s))` (40 s at the default, 60 s at the 60 s maximum): a later provider gets only the time left and is not started, or charged, when under 2 s remains. The answer is then the deterministic fallback. |
| `AI_MAX_OUTPUT_TOKENS` | 3000 | per call (thinking tokens on Gemini 2.5, and Groq reasoning tokens, count against it) |
| `AI_CACHE_TTL_SECONDS` | 1800 | |
| `AI_EXPLANATIONS_ENABLED` | true | kill switch for both providers |

Tuning: raise the per-provider budgets only up to the provider's own quota; the global budget is the ceiling on total calls and should be at most the sum of the two. Set `AI_PROVIDER_ORDER=groq` to use Groq alone. Nothing here is secret except the two keys; `.env.example` documents all of it and `.env` is never modified by the app.

## 4. Models and evidence

**Groq: `openai/gpt-oss-20b`.** Groq's documentation (console.groq.com/docs/structured-outputs and /docs/models, read 2026-11-24) lists `openai/gpt-oss-20b` and `openai/gpt-oss-120b` as the only **production** models with strict `json_schema` output (`strict: true` constrained decoding). The 20B model is the cheaper (about $0.075 input / $0.30 output per million tokens as listed, a figure from Groq's page, not an app assumption) and faster of the two, with a 131k context. Groq's older Llama production models are past their announced shutdown date and support only best-effort JSON mode; the Qwen 3.8 and Muse Spark models that also support strict mode are listed as preview. The default is therefore the 20B model. The docs pages disagree with each other on rate limits (30 RPM / 8K TPM in one table, 250K TPM in another), so check the account's own limits page before relying on throughput.

**Live check.** One real, schema-constrained call with the full production prompt and a real context was made on 2026-11-24 using the existing key (never printed). It returned in about 1.7 s with 4 473 input and 888 output tokens, and strict mode produced a complete JSON object. **The explanation then failed my Zod schema check** (`AI_SCHEMA_INVALID`). Every field I could see was within its limit; the failing field was beyond the part of the output I kept, so the cause is not confirmed, but the likely ones are a list longer than allowed or an over-long limitation, because Groq's schema subset does not document `maxLength`, `minItems` or `maxItems`, so those limits cannot be enforced during generation. After that I clarified the schema descriptions, tightened the prompt, and compacted the context. **That final prompt has not been re-run against Groq** (the brief allowed one call). Gemini was not called in Phase 3C.

**Gemini: `gemini-3.5-flash`** is unchanged from Phase 3B. It was verified with a small structured request, but every Flash-class model later returned 503, so the production prompt was never confirmed live on Gemini either.

## 5. Shared validation and numerical grounding

Both providers get the same system instruction, user prompt and response schema, and their output goes through the same `validateModelText`. Nothing a provider writes can change `data`: it is computed first, passed read-only, and a test asserts it is byte-identical with and without `explain`, for all four profiles, under honest, hostile and failing providers.

Phase 3C makes the numeric check **unit-aware**. Each number in the context is indexed with a unit class, taken from the key's suffix (`Percent`, `Km`, `Min`, `Ug`, `UgM3`, `gCo2`, `aqi`) or from the unit written beside it in engine prose. A figure in the model's text must carry a unit class the context gives that value:

- `3 km` does not authorise `3 hours` or `3 minutes`.
- a percentage is not a concentration; a concentration is not a mass (`µg/m³` vs `µg`).
- a bare number the context holds only with a unit is rejected, and an AQI is not a duration.
- a time is not converted: `5 pm` is checked as `17:00`; `5:00 pm` is not read as `05:00`.
- a gram figure must sit in a CO2 sentence; a concentration may not sit in a CO2-only sentence.

Any failure discards the whole explanation (`unit-mismatch`, `unsupported-number`, `unsupported-time`). **Limit:** the check knows a number's unit, not what it is about, so a percentage the context attaches to one activity could still be attached to another. The prompt also tells the model to use words instead of figures, which makes this rare.

## 6. Token optimisation

| | Phase 3B | Phase 3C |
|---|---|---|
| Context per request (4 profiles) | 26 113 to 28 621 bytes | 12 376 to 13 641 bytes (about 52% smaller, measured) |
| Recommendations sent | up to 40 | up to 12 |
| System instruction | 2 040 characters | 1 471 (concise, no field list) |
| Top actions | up to 5 | up to 3 |
| Paragraph limit | 1 000 characters | 420 |

Removed from the context: raw hourly readings, ISO forecast timestamps, formulas and uncertainty text, assumption statements, per-pollutant availability lists, duplicated city and profile metadata, unused preferences, per-mode CO2 rows (already inside the transport recommendations) and the PM2.5 baseline and alternative masses. Added: a one-line list of every routine item's suggested time (so any time the fallback quotes is grounded) and warnings are listed before limitations so that a stale-data warning is never the one cut. Numeric keys now end in a unit suffix.

The model is told not to repeat readings, percentages or CO2 figures, because the dashboard shows them from deterministic data. The fallback templates follow the same rule.

**Measured tokens (one real Groq call, before the final prompt tuning):** 4 473 in, 888 out, 5 361 total. These came from the provider's `usage` object. Gemini returned none because it was not called. A provider that reports no usage is recorded as `ai_tokens_unreported`, never estimated.

## 7. Budgets and rate limits

- **Per client**: 5 generation requests per minute (existing), checked once per request on a cache miss. A failover inside one request does not consume a second client unit.
- **Global budget** counts **call attempts**, not successes: a reservation is made immediately before a provider call and kept even if the call fails, because a request that reached a provider may use its quota, and so that a failing primary cannot silently double spend through the secondary.
- **Per provider** caps are enforced by the same reservation.
- **Atomic**: one Lua script reads both counters, refuses if either is full, otherwise increments both, so concurrent instances cannot exceed either cap and a refused call charges neither. A test runs 60 concurrent reservations across three instances against caps of 7 total, 4 and 5 and checks all three.
- **Reset** at 00:00 UTC (the date is in the key).
- **Skipping**: a full provider cap skips that provider and tries the next; a full global cap ends the chain.
- **Free**: cache hits, deterministic fallbacks, rate-limited and disabled requests reserve nothing.
- **Fail closed**: Redis down means no provider call. In production without Redis AI is paused (`AI_PROTECTION_UNAVAILABLE`); in development a per-process budget is used.

The budget never converts to money: no price is assumed.

## 8. Cache

Key: SHA-256 of prompt version, **provider, model**, and the exact context (which carries the profile, city, resolved preferences, recommendations and data timestamp). Lookups try each configured provider's key in order, so a Groq explanation is reused while Gemini is down and Gemini's is preferred when both exist. Only fully validated explanations are written; every read is validated again against the current request, and a corrupt or poisoned entry is deleted. A failing provider writes nothing, so it cannot poison an entry. Identical concurrent requests share one chain.

## 9. Observability

`ai_provider_request`, `ai_provider_success`, `ai_provider_failure` (with `provider` and `code`), `ai_provider_fallback`, `ai_fallback` (deterministic usage), `ai_cancelled` (the caller left during a call; not a provider failure), `ai_deadline_exceeded` (the chain ran out of time before a later provider), `ai_transport_failure` (a provider client could not be built: no call, no charge), `ai_cache_hit`, `ai_cache_miss`, `ai_budget_rejection` (`provider`, `kind`), `ai_latency_ms_total`, `ai_tokens_input|output|total|unreported`, plus the Phase 3B counters. Only allow-listed fields (`provider`, `code`, `kind`, `layer`, `status`, `cityId`, `operation`) are emitted. A static test forbids logging prompts, context, explanations, keys or provider messages.

## 10. Security

Server only (`server-only`); no `NEXT_PUBLIC_` key; keys in the Authorization header or the SDK only, non-enumerable on config objects, and checked for in output. Groq errors carry a status and never a body; redirects are refused; success bodies are size-capped. Output is plain text and the validator rejects markup and links. The request schema has no free text, so there is nothing to inject beyond fixed fields.

## 11. Deployment

Set `GEMINI_API_KEY` and/or `GROQ_API_KEY` (either is enough), `UPSTASH_REDIS_REST_URL` and `_TOKEN` (required for AI in production), and optionally the variables above. Re-run one live call per provider after deploying: the final prompt has not been seen by a real model.

## 12. Known limitations

- The final prompt and schema have not been run against Groq or Gemini; the one Groq call preceded tuning and failed the schema check. The real rejection rate is unmeasured, and the deterministic fallback absorbs any rejection.
- A 20B reasoning model tends to restate figures despite instructions. The validator rejects the ones it cannot ground, which costs a fallback, not safety.
- The budget script (SHA-256 prefix `164b61d2699a5c31`) ran against a real Upstash Redis on 2026-11-24 at commit `e2bcac5` (concurrency, caps, TTLs, UTC reset with an injected clock) and is byte-identical to the current script. The stricter reply validation added later was checked against real Upstash replies on 2026-11-25 (grant and refusal accepted, tampered replies rejected); the PTTL-repair branch and a real midnight cutover were never run live.
- A second provider means a second provider's data handling; Groq receives the same compact, non-personal context as Gemini.
- Groq's published rate limits are inconsistent across its own pages.
- Failover can add the first provider's latency (up to the timeout) before Groq is tried.
