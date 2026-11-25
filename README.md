# Urban Air Intelligence

> Breathe Smarter. Live Safer.

GenAI-assisted urban air quality guidance for Indian families and communities living with severe winter smog. Built for PromptWars Virtual, Challenge 6.

## Project status

Built and verified: the CPCB Indian AQI engine, Open-Meteo integration with caching and last-known-good fallback, Upstash Redis cache, rate limiting and AI budgets (verified against a real database), the deterministic recommendation engine, validated Gemini and Groq explanations with a deterministic fallback, the dashboard (seven cities, four profiles), a question-and-answer chat assistant, and a Render Free blueprint. Not yet done: a real Render deployment, and a live re-check of the final Gemini prompts (Gemini has never been run live).

Open the app and pick a city and a profile. The page shows the plain-language explanation (generated on click), the air quality overview, outdoor windows, recommendations and impact estimates. The floating **Ask a question** button opens the chat assistant.

## Technology stack

| Concern | Choice (pinned exactly in `package.json`) |
|---|---|
| Framework | Next.js 16.4.6, App Router, Turbopack |
| UI | React 19.3.1, Tailwind CSS 4.3.5 (`@tailwindcss/postcss`) |
| Language | TypeScript 6.0.3, strict mode |
| GenAI | `@google/genai` 3.6.1 (server-side only) |
| Validation | Zod 4.6.7 |
| Tests | Vitest 5.1.1, Testing Library, jsdom, V8 coverage |
| Lint | ESLint 9.39.5 with `eslint-config-next` |
| Runtime | Node.js 22 LTS, npm |

Notes on version choices:

- **TypeScript 6, not 7**: `typescript-eslint` (used by `eslint-config-next`) supports TypeScript below 6.1.
- **ESLint 9, not 10**: `eslint-plugin-react`, `eslint-plugin-jsx-a11y` and `eslint-plugin-import` do not yet declare ESLint 10 support.
- **Vite 8** is an explicit devDependency because `@vitejs/plugin-react` 6 requires it as a peer.
- **System font stack**: no Google Fonts download, so builds work offline.

## Folder architecture

```
src/
├── app/                 Next.js App Router
│   ├── api/air/         GET /api/air?cityId=...  (thin wrapper)
│   ├── api/recommend/   POST /api/recommend  (thin wrapper)
│   ├── api/health/      Liveness probe (reveals no configuration)
│   ├── globals.css      Design tokens (light/dark) + Tailwind
│   ├── layout.tsx       Root layout, skip link, header/footer
│   └── page.tsx         Placeholder dashboard shell
├── components/          ui/, layout/, dashboard/ (placeholders)
├── config/
│   ├── cities.ts        City registry: the ONLY source of coordinates
│   ├── profiles.ts      The four evaluator preset profiles and their documented defaults
│   ├── emissionFactors.ts  Sourced transport emission factors (metro marked unavailable) and the recorded grid factor
│   ├── breathingRates.ts   EPA Table 6-2 inhalation rates; respirator best-case ceiling
│   ├── advisoryThresholds.ts  Window policy, advisory ceilings, confidence penalties
│   └── placeholders.ts  Placeholder UI content (city list derives from the registry)
├── lib/
│   ├── aqi/             CPCB Indian AQI engine (pure, deterministic, no network)
│   ├── api/             Request handling for /api/air and /api/recommend (testable without Next.js)
│   ├── engine/          Deterministic recommendation engine (pure: no network, clock, randomness or LLM)
│   ├── cache/           CacheAdapter interface; MemoryCache, UpstashCache (Redis), TieredCache, snapshot schema
│   ├── observability/   Safe logger and in-process metrics (allow-listed fields only)
│   ├── ratelimit/       Client IP trust, memory and Redis limiters, the per-request gate
│   ├── redis/           Minimal Upstash REST client, config validation, sanitized errors
│   ├── data/
│   │   ├── openMeteo/   client, schema (Zod), mapper, errors, types
│   │   ├── airData.ts   Normalized contract builders (pure)
│   │   ├── airService.ts   cache -> provider -> last-known-good orchestration
│   │   └── defaultAirService.ts   Process-wide instance (server-only)
│   ├── constants.ts     App identity, timezone, disclaimer, attribution (client-safe)
│   ├── env.ts           SERVER-ONLY environment access (Gemini, air service, Redis, rate limit)
│   ├── http.ts          Capped body reading and abort detection, shared by outbound clients
│   ├── time.ts          Timezone-explicit formatting helpers
│   └── utils.ts         cn, clamp, isBlank, roundHalfUp, roundToDecimals
└── types/               Shared types (`air.ts` = normalized air data contract)

tests/
├── unit/                aqi/, engine/, openMeteo/, redis/, cache/, ratelimit/, service, env, security checks
├── integration/         /api/air and /api/recommend handlers, route wiring, resilience scenarios, Redis over real local HTTP
├── fixtures/            Provider-shaped responses, one real recording, FakeRedis, snapshot builder
├── stubs/               Test stub for `server-only`
└── setup.ts
```

Layering rule: pure logic lives in `src/lib`, never imports from `components` or `app`, and stays unit-testable.

## Installation

Requires **Node.js 22** (`engines`: `>=22.22.2 <23`). An `.nvmrc` is provided.

```bash
nvm use            # or any tool that honours .nvmrc / engines
npm install
```

Other Node versions (for example 24 or 26) may work but are unsupported and will print an engines warning.

## Environment setup

Secrets are read **only on the server**, from `.env.local` or `.env` (both git-ignored). Copy the template and fill it in:

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | One of the two | Preferred name for the Gemini API key |
| `GEMINI_KEY` | One of the two | Supported fallback name |
| `GEMINI_MODEL` | No | Overrides the default model (`gemini-3.5-flash`) |
| `AIR_CACHE_TTL_SECONDS` | No | How long a fetched reading is fresh (default `900` = 15 min; range 60-3600) |
| `AIR_MAX_STALE_SECONDS` | No | Oldest reading still served, marked stale, if the provider is down (default `86400`; must be >= the TTL) |
| `AIR_FAILURE_BACKOFF_SECONDS` | No | Pause before retrying a failing provider (default `60`; range 5-3600) |
| `AIR_UPSTREAM_TIMEOUT_MS` | No | Provider request timeout (default `8000`; range 1000-30000) |
| `UPSTASH_REDIS_REST_URL` | **Production** | Upstash Redis REST URL. `https://` only (plain `http://` is accepted for `localhost` only). Set together with the token |
| `UPSTASH_REDIS_REST_TOKEN` | **Production** | Upstash Redis REST token. A **secret**: server-side only, never logged, never `NEXT_PUBLIC_` |
| `AIR_RATE_LIMIT_MAX` | No | Requests per client per window (default `30`; range 1-10000) |
| `AIR_RATE_LIMIT_WINDOW_SECONDS` | No | Rate-limit window (default `60`; range 1-3600) |

Open-Meteo's public endpoint needs **no API key**. The `AIR_*` settings are not secrets; an invalid value raises an error naming the variable (never echoing the value). An unusable Redis setting never crashes the app: it degrades to memory-only operation and logs the offending variable's NAME (never its value).

`.env.example` documents every variable with blank placeholders only.

Gemini key resolution rules (`src/lib/env.ts`):

1. `GEMINI_API_KEY` is used if it holds a non-blank value.
2. Otherwise `GEMINI_KEY` is used.
3. A blank or whitespace-only value counts as unset, so an empty `GEMINI_API_KEY=` line copied from `.env.example` does not hide a valid `GEMINI_KEY`.
4. If neither is usable, a `MissingGeminiKeyError` is thrown. Its message names the variables but never contains a value.

Never prefix these with `NEXT_PUBLIC_`: Next.js inlines such variables into browser JavaScript.

## Running locally

```bash
npm run dev        # development server at http://localhost:3000
npm run build      # production build
npm run start      # serve the production build
```

## Quality checks

```bash
npm run lint            # ESLint
npm run typecheck       # next typegen + tsc --noEmit
npm run test            # Vitest, single run
npm run test:watch      # Vitest, watch mode
npm run test:coverage   # Vitest with V8 coverage (90% threshold on src/lib)
```

Tests use obviously fake key values, never read your real `.env`, and never print secrets.

## Air quality data (Open-Meteo integration)

### Source

Data comes from the [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (`https://air-quality-api.open-meteo.com/v1/air-quality`), requested server-side only, with no API key.

- **It is atmospheric model output, not station measurements.** For India (outside the CAMS Europe domain) it is the CAMS *global* composition forecast. Open-Meteo's documentation lists that dataset as about 45 km resolution, **3-hourly native resolution**, updated every 12 hours. The hourly series is derived by Open-Meteo from that coarser output, so adjacent hours are not independent model runs. Requests pin `domains=cams_global` so a city can never silently switch to the Europe domain.
- **Terms and attribution.** The free API is **non-commercial only**, the data is CC BY 4.0, and Copernicus prescribes credit wording. The API returns all of it in `sourceInfo` (`attribution` and `attributionLinks`); **any UI that shows this data must display it.** Details, with what was verified and what was not, are in "Provider terms and attribution" below.

### Pollutants

| Pollutant | Provider variable | Provider unit | Status |
|---|---|---|---|
| PM2.5 | `pm2_5` | ug/m3 | Available |
| PM10 | `pm10` | ug/m3 | Available |
| NO2 | `nitrogen_dioxide` | ug/m3 | Available |
| SO2 | `sulphur_dioxide` | ug/m3 | Available |
| O3 | `ozone` | ug/m3 | Available |
| CO | `carbon_monoxide` | ug/m3 | Available (converted to mg/m3 for CPCB) |
| NH3 | n/a | n/a | **Not requested.** Open-Meteo documents ammonia as Europe-only; a live request for India returns all nulls. |
| Pb | n/a | n/a | **Not provided** by Open-Meteo at all. |

NH3 and Pb are always reported as unavailable. They are never inferred from other pollutants and never treated as zero. With six of CPCB's eight pollutants, every AQI is flagged as partial coverage (the true AQI could be higher).

The mapper verifies each series' reported unit against `hourly_units`. A series in an unexpected unit is excluded with a warning and is never converted by guesswork. The only conversion is CO, from ug/m3 to mg/m3, using the AQI engine's explicit `convertConcentration`, applied to the AQI input only; the datasets returned by the API keep the provider's source units.

### Cities and coordinates

`src/config/cities.ts` is the only place coordinates exist. Requests carry a city ID, never a latitude or longitude.

| ID | City | Coordinate (Wikidata `P625`, rounded to 4 dp) | Cross-check (GeoNames) |
|---|---|---|---|
| `delhi-ncr` | Delhi NCR (central Delhi) | 28.6139 N, 77.2089 E (Q987, New Delhi) | 1261481, 1.0 km apart |
| `mumbai` | Mumbai | 19.0758 N, 72.8775 E (Q1156) | 1275339, 0.6 km |
| `kolkata` | Kolkata | 22.5675 N, 88.3700 E (Q1348) | 1275004, 0.9 km |
| `bengaluru` | Bengaluru | 12.9791 N, 77.5913 E (Q1355) | 1277333, 0.8 km |
| `lucknow` | Lucknow | 26.8470 N, 80.9470 E (Q47916) | 1264733, 2.5 km |
| `patna` | Patna | 25.6100 N, 85.1414 E (Q80484) | 1260086, 1.9 km |
| `bhubaneswar` | Bhubaneswar (Odisha) | 20.2950 N, 85.8250 E (Q171771) | 1275817, 2.7 km |

All seven use `Asia/Kolkata` (UTC+05:30, no daylight saving; checked against the runtime's tz database in the tests). The coordinate only selects a model grid cell, which is far coarser than the point: the response reports the cell centre the provider actually used (`coordinates.grid`). **"Delhi NCR" is the grid cell over central Delhi, not the whole region.** Gurugram, Noida, Ghaziabad and Faridabad are not represented, and `dataLocation` says so.

### Technical note: four different kinds of "air quality"

These are kept in separate fields and must never be merged or described as one another.

| Kind | Field | What it is | Used for the current AQI? |
|---|---|---|---|
| **Current model conditions** | `currentConditions` | One snapshot the provider labels "current" (on a UTC-hour boundary). A single instant. | **No.** CPCB's AQI is an average, never a single instantaneous value. |
| **Historical hourly model data** | `historicalHourlyData` | Model values at instants at or before the reference time (up to 25 hours). | **Yes, and only this.** |
| **Future hourly forecast** | `forecastHourlyData` | Model predictions for the next 48 hours. | **No.** Never used for the current AQI, never called observed. |
| **Official CPCB station measurements** | not provided | Readings from CPCB's monitoring network. | n/a. We do not have them. Nothing here is one. |

**Reference time.** The reference time is the provider's `current.time`, capped at our own clock so no future data can ever count as past. The averaging window ends at the latest hourly instant at or before it (`dataTimestamp`). Values are instants, so the instant at 13:00 is already "completed" at 13:30.

**Request window.** `past_hours=24` and `forecast_hours=49`. `past_hours` counts hours before the current hour and `forecast_hours` includes the current hour (verified against the live API), so this yields up to 25 historical points (one hour of margin over CPCB's 24-hour window) and 48 strictly future ones.

**Timestamps.** Requests use `timeformat=unixtime`, so there is no parsing of offset-less local strings. Every timestamp in the API is ISO-8601 with an explicit offset (for example `2026-11-24T13:00:00+05:30`), and the response's timezone and UTC offset are verified against configuration.

### How the CPCB AQI is computed

`calculatedAqi` is the output of `calculateAqiFromTimeSeries` (see `src/lib/aqi`), fed with the historical series only: a 24-hour rolling average for PM2.5, PM10, NO2 and SO2, and an 8-hour one for O3 and CO.

- CPCB's completeness rules apply unchanged: at least 16 valid hours per 24-hour average, and at least 3 pollutants including PM2.5 or PM10. The 8-hour minimum (6 of 8) is an engine default, because CPCB states none.
- If the rules are not met, the result is `insufficient_data` or `incomplete_window`, with `aqi: null`. Missing hours are never filled with future values, and an AQI is never zero because data is missing.
- The result keeps the **methodology** (`calculatedAqi.methodology`, CPCB) and the **data source** (`source`, `sourceInfo`, `calculatedAqi.dataSource`, Open-Meteo) as separate, identifiable fields.
- Severe-band numbers above about 401 are an engine estimate (CPCB publishes no upper bound); this is flagged on the result.

Required disclaimer, returned verbatim as `disclaimer` on every response:

> Estimated Indian AQI calculated using CPCB methodology and Open-Meteo atmospheric model data. This is not an official CPCB monitoring-station reading.

### API: `GET /api/air?cityId=<id>`

| Status | Meaning |
|---|---|
| `200` | `{ ok: true, data }`: fresh or stale data (check `data.freshnessStatus`) |
| `400` | `INVALID_CITY_ID`, `MISSING_CITY_ID`, `UNSUPPORTED_PARAMETER` or `DUPLICATE_PARAMETER`. Only `cityId` is accepted; `latitude`, `longitude` and anything else are rejected. |
| `414` | URL too long |
| `429` | `RATE_LIMITED`: the client is over its limit. `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. No other work is done |
| `503` | `AIR_DATA_UNAVAILABLE`: the explicit unavailable state (`data` has no readings), with `Retry-After` |
| `503` | `RATE_LIMITING_UNAVAILABLE`: the limiter cannot decide (Redis down) and nothing cached can be served. The provider is not called. `Retry-After: 30` |
| `500` | `INTERNAL_ERROR` with fixed text only |
| `405` | Any method other than GET |

Error bodies never contain stack traces, upstream messages, URLs or an echo of the input.

Cache headers: a fresh response is `public, max-age=0, s-maxage=<seconds left in its freshness window>`, so a CDN can share it only until it would turn stale. Stale, unavailable, rate-limited and error responses are `no-store`. Diagnostic headers: `X-Air-Freshness` mirrors `freshnessStatus`, `X-Air-Cache` mirrors `cache.status`, and `X-Air-Cache-Capability` mirrors `cache.capability` (below). Per-client `RateLimit-*` headers appear only on 429s, never on a 200 that a CDN might share between clients.

### Freshness and stale fallback

| State | When | What you get |
|---|---|---|
| `fresh` | Fetched within the TTL (default 15 min), and the newest model data is less than 3 h older than the fetch | The data. `cache.status` is `miss` (just fetched) or `hit` |
| `stale` | The provider failed (or was deliberately not called) and an earlier reading exists (at most 24 h old), or the provider's newest data lags by over 3 h | The **last good reading, unchanged**: original `fetchedAt`, original `dataTimestamp`, original AQI. `ageSeconds` is computed from the original fetch time, and `STALE_DATA` plus `UPSTREAM_UNAVAILABLE` (or `REFRESH_PAUSED`) warnings explain it |
| `unavailable` | Nothing usable is cached and the provider cannot be used | HTTP 503, no readings, no timestamps, no AQI |

Serving old data never refreshes its timestamp. `fetchedAt` always means "when the provider answered". Only genuine readings are ever cached: an unavailable result is never written.

### Cache architecture

```
request -> TieredCache.get
             1. memory (this instance), if younger than the 15-minute TTL: serve it, no Redis call
             2. otherwise Redis (shared by every instance); keep the NEWER of {Redis, memory}
             3. Redis failing: fall back to whatever memory holds
           service: fresh? serve : refresh from Open-Meteo -> TieredCache.set (memory, then Redis)
```

| Layer | Class | Holds | Survives a cold start |
|---|---|---|---|
| Memory | `MemoryCache` | One snapshot per city, in this process (bounded at 64) | No |
| Durable | `UpstashCache` over the REST client | `air:v1:snapshot:<cityId>` = `{ v, storedAtMs, value }`, Redis TTL = maximum stale age (24 h) | Yes, and shared by all instances |

- **Freshness is decided by the service**, not by Redis: Redis keeps a snapshot for 24 h precisely so it can serve as the stale fallback after the 15-minute TTL.
- **Everything read from Redis is validated** (`snapshotSchema.ts`) before use. A corrupt, wrong-shaped, wrong-city, future-dated or internally inconsistent entry (for example a "valid" AQI that is not the maximum of its own sub-indices, or a number on a result that is not a valid estimate) is treated as a miss: counted, logged without its content, deleted, never served.
- **Redis failures never crash a request.** `TieredCache` catches them, counts them, logs at most once a minute (no payloads, no URLs), and degrades to memory.
- **`cache.capability` states what is actually true**: `persistent` (Redis configured and answering), `persistent-unavailable` (configured but failing now), or `memory-only` (not configured). In a production run anything other than `persistent` also sets `cache.degraded: true`, in the body and in `X-Air-Cache-Capability`, and a `air.durable_cache_not_configured` warning is logged at startup. It never claims durability that is not there.
- Next.js's own fetch cache is deliberately not used (`cache: "no-store"`): its stale-while-revalidate behaviour would hide provider failures and could make `fetchedAt` lie.

### Failure scenarios

| | Open-Meteo | Redis | Result |
|---|---|---|---|
| **A** | ok | ok | Fresh reading, stored in Redis with its original timestamp |
| **B** | fails | holds a valid reading | That reading, **stale**, original timestamps, true age, even from a cold instance |
| **C** | fails | no valid snapshot | `unavailable` (503); nothing is cached or invented |
| **D** | ok | cache reads or writes fail | Fresh reading served; sanitized failure logged and counted; the reading stays in memory |
| **E** | fails | fails | A valid in-memory snapshot as stale, else `unavailable` |
| **F** | not called | **down** (so the limiter cannot decide) | Cached data is served (a warm instance's memory); anything uncached is a controlled **503**. **The provider is never called without a rate-limit decision.** |

Scenarios D and F differ because they are different failures: D is the cache failing while the limiter still works; F is a total Redis outage, where rate limiting cannot be enforced. In F a cold instance with nothing in memory returns 503 even though Open-Meteo might be healthy: this is deliberate (see below).

### Rate limiting

**Policy: 30 requests per client per 60 seconds** (`AIR_RATE_LIMIT_MAX`, `AIR_RATE_LIMIT_WINDOW_SECONDS`), distributed across serverless instances through Redis.

- **Algorithm.** A fixed window per client, in one atomic Lua `EVAL` (`INCR`; on the first hit set the expiry; heal a counter that has none; return count and time left). Upstash documents that pipelines are **not** atomic, which is why a script is used. The window starts at a client's first request and is never extended, so retrying while blocked does not prolong the block. A client can burst up to twice the limit across a window boundary: a property of fixed windows.
- **What is counted.** Every request that passed input validation, including cache hits, keyed by **client only**: never by URL or query, so varying cities or parameters cannot create new buckets. Invalid (400) requests are not counted, since they do no work. 429 responses do no other work: no cache read, no provider call.
- **No CDN on Render.** Free Render instances have no edge caching (https://render.com/docs/free), so every request reaches the app and is counted. Do not put a caching CDN in front without re-checking how `Cache-Control` (`s-maxage`) on `/api/air` responses is handled: a cache would answer repeat requests before the limiter sees them.
- **Redis unavailable.** The limiter never fails open. The request is served from cache if possible (marked stale with `REFRESH_PAUSED` when it is older than the TTL) and **the provider is not called**; if nothing can be served, the answer is a controlled 503 `RATE_LIMITING_UNAVAILABLE`. When Redis is simply not configured, an in-memory limiter (per instance) is used instead, which is weaker but never unlimited.
- **Privacy.** A client's address is never logged or stored. It is reduced to an HMAC-SHA256 keyed hash (32 hex characters) before use as a Redis key, so keys cannot be brute-forced back to an IPv4 address. The key is the Redis token when there is one (already a secret we hold, identical on every instance), otherwise a per-process random value.

### Client IP trust

Forwarding headers are written by the sender, so they are trusted only where the platform sets them, and only when the operator says so. Render's own article on hosting PocketBase (https://render.com/articles/host-pocketbase-on-render) states that Cloudflare writes `CF-Connecting-IP` on requests to public web services and **overwrites** any value the caller sent, while `X-Forwarded-For` is appended to, so a caller controls its leftmost entry. Render's documentation does not say whether a service can be reached while skipping that proxy, so trust is never inferred: it is a server-side switch.

| Where | Trust | Behaviour |
|---|---|---|
| `TRUST_RENDER_CF_CONNECTING_IP=true` (set by the operator on the Render service; a request cannot influence it) | `render` | Read **only** `CF-Connecting-IP`, and only when it is exactly one bare IPv4 or IPv6 address |
| Anything else (flag unset or any other value: local dev, `next start`, any other host) | `none` | Trust **no** header, `CF-Connecting-IP` included. Clients are indistinguishable and share one bucket: limited, never unlimited |

`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `True-Client-IP` and `X-Vercel-Forwarded-For` are never read. A value that is a list (a repeated header is joined with a comma), or carries a port, brackets, a zone id, trailing text, or anything that is not an address, is rejected, and the client falls back to the shared bucket: there is no fall-through to another header. IPv4-in-IPv6 maps to the IPv4 client, and IPv6 clients are grouped by /64, so a subscriber cannot dodge the limit by rotating addresses inside their own subnet. Rate-limit keys are unchanged (the same hashed `v4:`/`v6:` identifier). Never set the flag on a host that is not behind Render's proxy: anyone could then choose their own limiter key.

### Observability

In-process counters plus one structured JSON log line per notable event, with no external platform. Counted: `cache_hit`, `cache_miss`, `stale_fallback`, `refresh_paused`, `provider_timeout`, `provider_failure`, `redis_failure`, `cache_entry_corrupt`, `rate_limit_rejection`, `rate_limit_degraded`, `client_identifier_unavailable`.

- Only allow-listed fields (`cityId`, `code`, `status`, `kind`, `layer`, `operation`) can ever be logged. Raw IPs, headers, tokens, URLs and payloads cannot be, even if a caller passes one by mistake (tested).
- A metric logs at most **one line per minute** with its running `count`, so an outage or attack cannot flood the logs; counting is exact.
- Counters are per instance and reset on a cold start: the log lines are the durable signal (Render's log stream shows them; free instances keep no logs beyond what the dashboard retains, so forward them elsewhere if you need history). `cache_hit` and `cache_miss` are counted only, never logged.

## Recommendation engine (Phase 3A)

`src/lib/engine` turns the real Open-Meteo data and a lifestyle profile into personalised, traceable guidance. **Everything is deterministic TypeScript**: the same inputs give the same outputs, with no network, clock, randomness or language model inside any calculation (a test enforces this against the source). Gemini is **not** integrated; Phase 3B will explain these results and never change them. The full method, sources and worked examples are in [`docs/ENVIRONMENTAL_IMPACT_METHODOLOGY.md`](docs/ENVIRONMENTAL_IMPACT_METHODOLOGY.md).

### Architecture

```
POST /api/recommend -> recommendHandler (validate, rate-limit, thin)
                    -> existing air service (cache -> Open-Meteo -> last-known-good)
                    -> generateRecommendations(air, profile, preferences, now)
                         profiles -> outdoorWindows -> routine -> indoor -> transport
                         -> exposure -> impact -> prioritization -> one typed result
```

### The four profiles (one-click presets)

| ID | Who | What the engine emphasises |
|---|---|---|
| `family_toddlers` | Family with toddlers or schoolchildren | School-run timing, planned outdoor play, indoor play alternatives, wet mopping and source reduction, filtration where feasible, trip chaining |
| `senior_respiratory` | Senior citizen with respiratory issues | Morning, afternoon and evening comparison, relatively lower windows for walks, indoor exercise alternatives, no indoor combustion, conditional ventilation. Never claims any level is medically safe |
| `two_wheeler_commuter` | Daily two-wheeler commuter | Commute window comparison, public transport and carpool alternatives, respirator guidance only as a best case, trip chaining. No route-level data is claimed |
| `student_athlete` | College student or outdoor athlete | Lower-pollution exercise windows under the strictest ceiling, indoor workouts, public transport versus own vehicle. A temporary dip is not an invitation to train hard outdoors |

All four work with only `cityId` and `profileId`. Defaults (times, durations, a commute distance, an age band) are illustrative **preset defaults**, flagged as assumed in the output until overridden. `listProfileOptions()` in `src/config/profiles.ts` gives the dashboard a stable selector list.

Optional validated preferences: wake-up time, work or school start, commute minutes and distance, commute days per week, preferred transport, vehicle occupancy, outdoor activity minutes, household size, cooking fuel, air purifier, ventilation preference, an age band, an activity schedule, and an optional PM2.5 reading from the user's own monitor. There is **no free-text field**, no name, address or age in years, and unknown keys are refused, so a request cannot carry instructions.

### Outdoor window method (summary)

Forecast hours still in the future are compared as time-weighted windows; the window indicator is the **highest CPCB sub-index** over the pollutants with complete data (so a window is never chosen because one pollutant falls while another rises); PM2.5 is required, other missing pollutants are excluded, disclosed and lower confidence. A window is called **"Relatively lower-pollution window"** only when it is under an effort- and sensitivity-dependent advisory ceiling and at least 15% below the median or the user's usual time. Otherwise the engine says there is no meaningful difference or no suitable window, and offers an indoor alternative. If the forecast is unavailable it says so and invents no time.

### Indoor rules (summary)

Source control first, then cleaning, filtration, conditional ventilation, lifestyle. Each intervention lists action, why it helps, priority, cost, feasibility, evidence category and limitations. The app has no indoor sensor and says so; ventilation is never advised blindly.

### Transport comparison (summary)

Private car, two-wheeler, metro, bus, carpool, walking, cycling, each on three separate axes: tailpipe CO2, qualitative exposure, convenience. A lower-carbon option is not automatically lower exposure: walking and cycling are held back when air quality is poor.

### PM2.5 exposure formula

`inhaled mass (ug) = C (ug/m3) x BR (m3/hour) x t (hours) x (1 - protection)`; reduction = baseline minus alternative. Breathing rates come from the US EPA Exposure Factors Handbook 2011, Table 6-2. Results are model estimates, never measured doses, each with its formula, inputs, units, uncertainty and data source, and are **unavailable** when an input (for example an indoor concentration) is missing.

### CO2 methodology and emission-factor references

Tailpipe CO2 only, India-specific fuel-based factors from the India GHG Program's *India Specific Road Transport Emission Factors* (Version 1.0, 2015, a stakeholder-consultation draft): two-wheeler 0.0319 and car 0.140 kg CO2 per vehicle-km (divided by occupancy), bus 0.015161 kg CO2 per passenger-km, walking and cycling zero by definition. **Metro is unavailable** (no primary-source energy-per-passenger-km figure could be retrieved). The factors exclude methane, nitrous oxide, fuel production and vehicle lifecycle, and the output says so. The CEA grid factor (0.823 and 0.716 t CO2/MWh, FY 2022-23, version 19.0) is recorded for a future metro comparison and used nowhere. Preset commute distances are assumptions and flagged.

### Confidence interpretation

Confidence is about the **input data**, not health. `score = 1 - penalties` (model data, stale data, missing pollutants, long lead time, forecast gaps, assumed inputs); high is 0.75 or more, medium 0.5 or more, otherwise low; `unavailable` means the result could not be computed.

### Prioritisation

Score = 0.30 severity + 0.20 vulnerability + 0.20 exposure reduction + 0.10 feasibility + 0.05 low cost + 0.15 confidence; high at 0.70, recommended at 0.45. "High" needs at least moderate pollution and at least medium confidence, so clean air never produces alarms.

### API: `POST /api/recommend`

```http
POST /api/recommend
Content-Type: application/json

{ "cityId": "delhi-ncr", "profileId": "senior_respiratory", "preferences": { "hasAirPurifier": true } }
```

`preferences` is optional. Body limit 8 KB.

| Status | When |
|---|---|
| 200 | `{ ok: true, data }`. Fresh or stale air data (stale is flagged and uses only forecast hours still in the future) |
| 400 | `INVALID_JSON` or `INVALID_REQUEST` (field paths listed, values never echoed) |
| 413 / 415 | Body over 8 KB / not `application/json` |
| 429 | `RATE_LIMITED` with `Retry-After`: the same per-client limit as `/api/air`, shared |
| 503 | `AIR_DATA_UNAVAILABLE` (or `RATE_LIMITING_UNAVAILABLE`) with `data.status = "air-data-unavailable"`: air-dependent sections are explicitly unavailable, general guidance remains, nothing is invented |
| 500 | `INTERNAL_ERROR`, fixed text |

`data` (`RecommendationResult`) contains: `profileId`, `cityId`, `generatedAt`, `dataFreshness`, `aqiContext`, `routine`, `outdoorWindows`, `indoor`, `transport`, `exposure`, `emissions`, `prioritized`, `assumptions`, `rules`, `warnings`, `confidence`, `limitations` and `provenance` (including the Open-Meteo attribution and the not-an-official-reading disclaimer). Responses are `Cache-Control: no-store`, with `X-Air-Freshness` and `X-Recommendation-Engine: deterministic`.

### Scientific limitations

Model values for a grid cell are not measurements at a station, road or home; the window indicator applies CPCB's scale to short windows (a ranking device, not an AQI); advisory ceilings are engine policy, not medical thresholds; breathing rates are US means; mode exposure is qualitative; emission factors are a 2015 draft; this is not medical advice. See the methodology document for the complete list.

## Gemini explanations (Phase 3B)

Gemini **explains** the deterministic recommendations; it never calculates, picks or changes anything. Add `"explain": true` to `POST /api/recommend` and the response gains an `ai` field next to the unchanged `data`. Without it, nothing changes. Full details: [`docs/GEMINI_ARCHITECTURE.md`](docs/GEMINI_ARCHITECTURE.md).

```http
POST /api/recommend
{ "cityId": "delhi-ncr", "profileId": "senior_respiratory", "explain": true }
```

`ai` is `{ status: "generated" | "cached" | "fallback" | "unavailable", reasonCode, message, explanation, model, promptVersion, retryAfterSeconds?, numbersFromEngine: true }`. `explanation` is prose only (overview, situation, personalised summary, up to five `topActions` that reference real recommendation IDs, routine, outdoor, indoor, transport and impact explanations, data limitations, a safety disclaimer). **Render every string as plain text.**

- **Grounding**: the server recomputes the result and sends Gemini only a bounded projection of it. Client-supplied AQI, impact numbers, prompts or model names are refused (strict schema).
- **Validation**: output is discarded whole if it has unknown fields or IDs, times or numbers not in the context, markup or links, medical, safety or guarantee claims, claims that indoor air was measured, or any key. The deterministic `data` is never altered (a test asserts byte-identical output).
- **Fallback**: on any failure (no key, 429, 5xx, timeout, malformed or rejected output, budget or rate limit) you get deterministic explanations built from the result, a sanitized `reasonCode` and a fixed message. The app never depends on Gemini.
- **Cost protection**: cache first (free), then 5 generations per client per minute, then an atomic global daily budget (default 300 per UTC day, counted in calls, no price assumed), then one call with a timeout and no retries. Redis down means no Gemini call; production without Redis pauses AI.
- **Model**: `GEMINI_MODEL`, default `gemini-3.5-flash`. The earlier default `gemini-2.5-flash` passes a metadata lookup but is refused for generation, so a model is only trusted after a real generation call. The layer never switches model after a failure.
- **Tuning**: `AI_EXPLANATIONS_ENABLED`, `AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_SECONDS`, `AI_DAILY_BUDGET`, `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_THINKING_BUDGET`, `AI_CACHE_TTL_SECONDS` (see `.env.example`).
- **Known gap**: the full production prompt has not yet been confirmed against live Gemini, because every Flash-class model returned HTTP 503 "high demand" when tested.

### Provider chain (Phase 3C): Gemini, then Groq, then deterministic

`ai.provider` is `gemini`, `groq` or `deterministic`, and the response header `X-AI-Provider` carries the same value. Gemini is tried first. If it fails in a way that a second provider can help with (timeout, 429, 5xx, network, key or model refused, malformed or rejected output), Groq is tried **once** with the same prompt, schema and validator. If both fail, the deterministic explanation is returned. Safety refusals, bad requests and internal errors never go to the second provider. A provider without a key is skipped, never replaced; with neither key set the app serves deterministic explanations.

- **Groq**: `GROQ_API_KEY` (already supported in `.env`; never exposed to the browser) and optional `GROQ_MODEL` (default `openai/gpt-oss-20b`). Plain `fetch`, no new dependency.
- **Budgets**: `AI_DAILY_BUDGET` is a global cap on provider **calls** across both providers; `AI_GEMINI_DAILY_BUDGET` and `AI_GROQ_DAILY_BUDGET` cap each one. One atomic Redis script charges both counters, so switching providers cannot get around the global cap. Redis down means no provider call. The 5-per-client-per-minute limit applies once per request.
- **Order**: `AI_PROVIDER_ORDER` (default `gemini,groq`).
- **Tokens**: the response `ai.tokenUsage` and the `ai_tokens_*` counters carry the provider-reported counts; a provider that reports none is recorded as unreported, never estimated.

Full details: [`docs/AI_PROVIDER_ARCHITECTURE.md`](docs/AI_PROVIDER_ARCHITECTURE.md).

## Chat assistant

A floating assistant lets a user ask a question about the air quality and the suggestions on the page ("Is it a good time for a walk?"). `POST /api/chat` takes `{ cityId, profileId, message, history? }` and returns `{ ok: true, chat }`, where `chat` is `{ status: generated | fallback | unavailable, answer, reasonCode, message, provider, model, promptVersion, retryAfterSeconds? }`.

- **Same grounding as explanations.** The model receives only the server-built context for the selected city and profile (the same compact projection the explanation uses), never raw readings from the browser. It cannot change any number on the page.
- **Free text is the only new risk, so it is bounded.** One question of at most 500 characters (whitespace collapsed; control and bidirectional-override characters refused), at most six earlier messages of at most 900 characters, a body of at most 8 KB, strict schema (unknown fields refused). The question and history reach the model only inside labelled untrusted blocks, with anything that imitates a marker removed. Error responses never echo what was submitted.
- **The answer is validated before it is shown.** It must be `{ "answer": string }` of at most 900 characters and pass the same text rules as explanations: no markup or links, no credential, no invented recommendation ID, no number or time that is not in the context, and none of the medical, health-outcome, guarantee, "safe", indoor-measurement or "official reading" claims. A rejected answer is replaced, never shown.
- **Fallback.** When AI is off, not configured, rate limited, over budget, slow, failing or rejected, the answer is a short deterministic reply picked from the already-written explanation sections by the question's topic (health questions get the not-medical-advice note). The reply says so and names the reason.
- **Cost protection is shared with explanations.** Chat uses the same per-client limit (5 per minute), the same atomic daily budgets (`AI_DAILY_BUDGET`, `AI_GEMINI_DAILY_BUDGET`, `AI_GROQ_DAILY_BUDGET`) and the same provider order and failover. It fails closed when Redis cannot decide, and in production without Redis AI is paused. Every question that reaches a provider spends budget, and answers are not cached.
- **UI.** A floating launcher opens a non-modal dialog (Escape closes it and returns focus to the launcher), with suggested questions, an `aria-live` conversation log, a character counter, Enter to send, and a visible source line on every answer. Text is always rendered as plain text. A conversation belongs to one city and profile: changing either starts a new one, and an answer that arrives late for the old selection is dropped. Nothing is stored.
- **Not covered.** Questions outside air quality are declined by the prompt and the deterministic reply, not by a separate classifier. The chat has not been run against a live model in tests; all tests use synthetic provider replies.

## Provider terms and attribution

Verified on 2026-11-24 from the documents themselves. **These are the providers' terms as I read them, not legal advice.**

| Topic | What the source says | Source |
|---|---|---|
| Free API use | "You may only use the free API services for non-commercial purposes." Under 10,000 calls a day, 5,000 an hour, 600 a minute. Open-Meteo may block misuse | Open-Meteo Terms |
| What counts as non-commercial | Examples: private or non-profit websites or apps with **no subscriptions or advertising**; personal home automation; public research at public institutions; educational content. Voluntary donations are permitted | Open-Meteo Terms |
| What counts as commercial | Websites or apps with subscriptions or advertisements; **commercial products or promotional activities**; undisclosed research at commercial entities | Open-Meteo Terms |
| Shared hosting | Rate limits apply by IP address and application; on Vercel, Netlify, Render and similar you "might be rate-limited earlier than expected" | Open-Meteo Terms |
| Data licence | CC BY 4.0: credit, a link to the licence, and an indication of changes. "You must include a link next to any location Open-Meteo data are displayed", for example `Weather data by Open-Meteo.com` linking to open-meteo.com | Open-Meteo Licence |
| Copernicus licence | Free, worldwide, perpetual; access "for any purpose in so far as it is lawful", including distribution and adaptation (clause 4). No commercial restriction | Licence to use Copernicus Products, rev. 12 |
| Copernicus attribution | "Generated using Copernicus Atmosphere Monitoring Service information [Year]"; where data is **adapted or modified**, "Contains modified Copernicus Atmosphere Monitoring Service information [Year]"; and a statement that neither the European Commission nor ECMWF is responsible for any use made of the information (clause 5.1) | same |
| The dataset itself | The CAMS global atmospheric composition forecasts entry in the Atmosphere Data Store lists its licence as CC-BY-4.0 | ADS catalogue |
| Redistribution | Nothing read restricts redistribution beyond attribution: CC BY allows sharing and adapting. This API re-serves modified data, so the "Contains modified" notice applies | Open-Meteo Licence, Copernicus licence |

**What the API returns** (`sourceInfo`): the full credit text with the verified wording and the year the data was obtained (`attribution`), and the links to show (`attributionLinks`: Open-Meteo, the CC BY 4.0 licence, Copernicus). The required `disclaimer` is unchanged. A UI must show both wherever data is displayed.

**Not determinable, and not assumed.**

- **Whether this prototype is "non-commercial".** The terms define it by examples. A free, ad-free, subscription-free, non-profit demo matches the first example, but "promotional activities" is listed as commercial and a competition entry might count. Confirm with Open-Meteo, or move to a paid Open-Meteo plan or self-host, before any public or commercial launch. Anything with ads or subscriptions is commercial by the terms' own examples.
- Open-Meteo's licence page links to a Copernicus licence PDF that returned **404** on the day of checking; the same licence (rev. 12) was read from the Copernicus Data Store instead.
- The ADS dataset page is rendered client-side, so the dataset's licence was read from the ADS catalogue API entry rather than the page.

## Deployment

**Nothing here has been deployed or run against a real Redis.** The Redis client and rate-limit script are tested against in-process stand-ins (including a real local HTTP server speaking the Upstash REST protocol); the Lua script has not been executed by a real Redis. Do the verification below after deploying.

### Local development

No Redis needed. With no `UPSTASH_*` variables the app uses per-instance memory for the cache and the limiter, reports `cache.capability: memory-only` (not `degraded`, because this is not production), and every client shares one rate-limit bucket (no trusted IP header unless `TRUST_RENDER_CF_CONNECTING_IP=true`). Run `npm run dev`.

To exercise the Redis path locally you may point `UPSTASH_REDIS_REST_URL` at a local REST-compatible proxy over plain `http://localhost:<port>`; any other `http://` host is refused.

### Redis setup (Upstash)

1. Create a Redis database in the Upstash console. Pick the region closest to your Render service (`singapore` in `render.yaml`).
2. Copy the database's REST URL and REST token (read-write) from its REST API details.
3. Treat the token as a secret: do not paste it into chat, issues or committed files.

### Deploying on Render (free instance)

`render.yaml` is a Blueprint for one **free** Node web service. It is **not deployed, and no repository is connected**. Build: `npm ci --include=dev && NODE_OPTIONS=--max-old-space-size=384 npx next build --webpack` (the lockfile is `package-lock.json`; devDependencies are needed for the build). **Memory risk:** a clean local build peaked at about 990 MB with the default Turbopack builder, 605 MB with `--webpack`, and 539 MB with `--webpack` and the 384 MB heap cap used here; the free instance has 512 MB, so a build killed for memory is possible and unverified until a real deploy (then build on a paid instance or elsewhere). Peak figures are macOS `maximum resident set size` of the largest process. Start: `npm start` (listens on Render's `PORT`). Health check: `/api/health`. Node: `NODE_VERSION=22.23.5`, inside `engines` (`>=22.22.2 <23`); on Render `NODE_VERSION` takes precedence over `engines` (https://render.com/docs/node-version). Sources: https://render.com/docs/deploy-nextjs-app, https://render.com/docs/blueprint-spec.

Secrets are `sync: false` in the Blueprint: Render asks for them in the Dashboard at first creation and ignores them on later syncs, so change them in the Dashboard. Never put a value in `render.yaml`. Environment changes need a redeploy.

| Variable | Where | Notes |
|---|---|---|
| `GEMINI_API_KEY` (or `GEMINI_KEY`) | Dashboard secret | Optional. `GEMINI_API_KEY` wins if both are set |
| `GROQ_API_KEY` | Dashboard secret | Optional. With neither AI key the deterministic explanation is served |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Dashboard secrets | **Required in production**: without both, air data is memory-only (`cache.degraded: true`), limits are per instance, and AI explanations are paused |
| `TRUST_RENDER_CF_CONNECTING_IP` | `render.yaml` (`true`) | Per-client limits on Render. See "Client IP trust" |
| `NODE_VERSION`, `NODE_ENV` | `render.yaml` | `22.23.5`, `production` |
| `AI_DAILY_BUDGET`, `AI_GEMINI_DAILY_BUDGET`, `AI_GROQ_DAILY_BUDGET` | `render.yaml` (100, 60, 60) | Conservative per-UTC-day call caps, below the code defaults (300, 200, 200) |
| `AIR_CACHE_TTL_SECONDS`, `AIR_MAX_STALE_SECONDS`, `AIR_FAILURE_BACKOFF_SECONDS`, `AIR_UPSTREAM_TIMEOUT_MS`, `AIR_RATE_LIMIT_MAX`, `AIR_RATE_LIMIT_WINDOW_SECONDS` | Optional | Defaults in `.env.example`. Invalid rate-limit values make `/api/air` answer 500 rather than run unprotected |
| `AI_EXPLANATIONS_ENABLED`, `AI_PROVIDER_ORDER`, `AI_RATE_LIMIT_MAX`, `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_THINKING_BUDGET`, `AI_CACHE_TTL_SECONDS`, `GEMINI_MODEL`, `GROQ_MODEL` | Optional | Defaults in `.env.example` |

No secret has a `NEXT_PUBLIC_` name. Do not set `VERCEL*`: nothing reads it.

#### What the free tiers mean (checked 2026-11-24; limits change, so re-check before relying on them)

| Component | Target | Limits that matter | Cost |
|---|---|---|---|
| Render web service | Free instance | Spins down after 15 min without traffic and takes about a minute to wake; 750 free instance hours per workspace per month, then free services are suspended until next month; 512 MB RAM, 0.1 CPU; one instance; ephemeral filesystem; not for production use (https://render.com/docs/free, https://render.com/docs/blueprint-spec) | Free, subject to those limits |
| Upstash Redis | Free plan, if compatible | 500K commands a month, about 250 MB, 10 GB monthly bandwidth, 1 database (https://upstash.com/pricing/redis). The REST docs list scripting as supported with no plan caveat (https://upstash.com/docs/redis/features/restapi); `EVAL` on the free plan is **unverified** until run. Exceeding the command quota is a plan matter to check on Upstash: do not add a card without reading it | Free, subject to quota |
| Gemini | Free quota if available | Not checked here: depends on your key, model and region. The app caps itself at 60 provider calls a day | Usage/quota dependent |
| Groq | Free quota if available | Not checked here: same. Capped at 60 a day | Usage/quota dependent |
| Open-Meteo | Free non-commercial tier | Terms below; separate from Render hosting | Subject to licensing and usage limits |

Render does not provide persistent Redis or a free managed database that fits: its free Key Value store is in-memory only and loses data on restart, and its free Postgres expires after 30 days. Use Upstash for the durable cache. Render hosting grants no Open-Meteo commercial rights.

Measured with the in-process Redis stand-in (not a real Redis): the first air request for a city sends 3 commands (`EVAL`, `GET`, `SET`), and repeat requests on a warm instance send 1 (`EVAL`, the rate limit), because the instance's memory answers cache hits. That is roughly 1 to 3 commands per air request, so 500K commands is on the order of 160,000 air requests a month at worst. AI explanations add a handful of commands each (not measured) and are capped at 100 provider calls a day.

#### Cold start and temporary unavailability

- The first page load after spin-down is held by Render (about a minute, with Render's own loading page); the app itself is not involved.
- If the service spins down while a page is open and the user then changes city or profile, the request can exceed the dashboard's 20-second timeout. The dashboard shows "We could not reach the server" with a **Retry** button instead of a blank screen, and retrying works once the instance is awake. The message mentions the connection, which is not the cause in this case.
- After a wake the instance's memory cache is empty. Air data is restored from Upstash, and the provider is called only when Redis has nothing fresh. Without Redis a cold instance calls Open-Meteo.
- Counters (`air.metric` lines) are per instance and reset on spin-down.
- To avoid spin-down you would need a paid instance or an external ping that keeps it awake, which spends the monthly free hours. Neither is configured.
- Not suited to free hosting: anything that must be always-on, or that needs more than 512 MB. Production use is discouraged by Render itself.

#### Open-Meteo licensing paths

The provider endpoint is the free one and no paid credential is supported yet (changing that is a code change, not done in this phase).

1. **Free, non-commercial educational or demo use**, subject to https://open-meteo.com/en/terms. The free API may be used only for non-commercial purposes: a free, ad-free, subscription-free, non-profit demo matches the terms' own examples, but "promotional activities" counts as commercial and a competition entry might. Confirm with Open-Meteo if unsure. Attribution is required (see above).
2. **Commercial use** needs an eligible paid subscription and its customer endpoint with an API key (https://open-meteo.com/en/pricing). Not configured here; it would need a small code change to the endpoint and key handling.

**Render shared IPs.** Open-Meteo's free limits apply per IP address and application, and its terms warn that shared hosting such as Render may be rate-limited earlier than expected. The cache, Redis snapshot and failure back-off reduce calls but cannot remove that risk. Render hosting itself does not change which Open-Meteo tier you may use.

### Verify the deployment

1. `curl -i "https://<your-domain>/api/air?cityId=mumbai"`: expect `200`, and in the body `cache.capability: "persistent"` and `cache.degraded: false`. `X-Air-Cache-Capability: memory-only` or `cache.degraded: true` means Redis is not working or not configured.
2. In the Upstash data browser, expect `air:v1:snapshot:mumbai` with a TTL near 86,400 s, and `air:v1:rl:c:<32 hex characters>` keys with a TTL of at most 60 s. This is the first time the Lua script runs on a real Redis: if no `air:v1:rl:` key appears, or the logs show `air.rate_limiter_unavailable`, investigate before relying on the limiter.
3. Check the function logs for `air.metric` lines with `redis_failure`, `rate_limit_degraded` or `cache_entry_corrupt`.
4. After a few minutes, request a different city from another network and confirm `X-Air-Cache` is `hit` on a fresh instance (a durable cache working across instances).
5. Check the per-client limit: send more than `AIR_RATE_LIMIT_MAX` requests in a minute and expect `429` with `Retry-After`. With `TRUST_RENDER_CF_CONNECTING_IP=true`, two networks should have separate allowances. If every client shares one bucket, the header is missing or invalid.

### Known limitations

- **Unverified against a real Redis** (see above), and **against a real Render deployment**, including the free instance's memory use and cold start.
- **A Redis outage means no live refresh for cold instances** (scenario F): by design the limiter never fails open, so a cold instance with nothing in memory answers 503 rather than calling Open-Meteo unmetered.
- **Fixed-window limiting** allows a burst of up to twice the limit across a window boundary.
- **Without `TRUST_RENDER_CF_CONNECTING_IP=true`**, or if `CF-Connecting-IP` is missing or invalid, per-client limiting degrades to one shared bucket. Render's documentation does not say whether a service can be reached without its proxy; the flag is the operator's assertion that it cannot.
- Two instances refreshing at once can each call the provider (single-flight is per instance), and the last writer wins in Redis.
- Counters are per instance; logs are the durable signal.
- Open-Meteo's own rate limits are per IP and application, and Render's shared egress IPs may hit them early; the cache and back-off reduce calls but cannot remove that risk.

## Security considerations

- **No SSRF surface.** The upstream URL is a constant; coordinates come only from the city registry, looked up by ID inside the client. Redirects are refused (`redirect: "error"`), a timeout bounds every call, and response bodies are size-capped (512 KB) while being read.
- **Validated input and output.** Query parameters are allow-listed (`cityId` only) and checked with Zod against the configured IDs; provider responses are validated with a Zod schema (array lengths, hourly timestamps, units present, nulls).
- **No provider leakage.** Provider bodies and `reason` strings are never read into errors, logs or responses; logs record only the failure class (`code`, HTTP status, city ID).
- **Server-only secrets**: `src/lib/env.ts` imports `server-only`, so importing it from a Client Component fails the build.
- **No key in logs or errors**: errors reference variable names only. The resolved config object keeps `apiKey` non-enumerable, so `JSON.stringify`, spread and `console.log` omit it.
- **Static guards**: `tests/unit/security-boundaries.test.ts` fails if a Gemini variable gains a `NEXT_PUBLIC_` name, a Client Component imports server-only modules, or a literal Google API key appears in `src/`. `security-boundaries-redis.test.ts` does the same for Redis variables, requires the Redis, limiter and wiring modules to be `server-only`, restricts the Redis client to the four commands used (`GET`, `SET`, `DEL`, `EVAL`), and checks that no log call can carry a token, header or address.
- **Git hygiene**: `.gitignore` excludes `.env*` (including `.env` and `.env.local`) and re-includes only `.env.example`. Never commit real keys.
- **Headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy` are set in `next.config.ts`; `X-Powered-By` is removed. A Content-Security-Policy is planned for a later phase.
- **Health endpoint** reports liveness only, not whether a key is configured.
- **Per-client rate limiting** (30 per minute by default), distributed through Redis, fail-closed for upstream calls, keyed by a hashed client identifier from `CF-Connecting-IP`, trusted only when `TRUST_RENDER_CF_CONNECTING_IP=true`. Upstream load is also bounded by the city allow-list, the cache, single-flight and the failure back-off. Add the same controls to any route that calls Gemini.
- **Redis credentials** are read only in `env.ts` from server variables, validated (https only, no credentials, path or query in the URL, token characters restricted so it cannot inject headers), sent only in the `Authorization` header, and never logged or returned. Errors from the Redis client carry fixed text only; Upstash error strings are discarded because they can echo command arguments. The client makes one attempt per command, with a timeout, no redirects and a response-size cap.
- **The cache is treated as untrusted input**: every entry read from Redis is schema-validated and integrity-checked before use.

## Accessibility and design

- Semantic landmarks, a skip link, visible focus rings, and reduced-motion support.
- Colours are semantic tokens in `globals.css` using `light-dark()`: the theme follows the OS and can be forced with `<html data-theme="light|dark">`.
- Text pairs meet WCAG AA (measured 6.5:1 or better); form-control borders meet 3:1.
- Status is always spelled out in text, never conveyed by colour alone.

## Roadmap

1. **Phase 2A** (done): foundation and tooling.
2. **Phase 2B** (done): CPCB Indian AQI engine with tests.
3. **Phase 2C** (done): Open-Meteo client, city registry, caching and last-known-good fallback.
4. **Phase 2D** (done): Upstash Redis persistent cache, per-client rate limiting, safe metrics, verified provider terms and attribution.
5. **Phase 3A** (done): deterministic recommendation engine and `POST /api/recommend`.
6. **Phase 3B** (done): Gemini explanations with validation, fallback, per-client limit, daily budget and cache.
7. Next: confirm the live prompt when Gemini capacity allows, then the dashboard UI (which must show the disclaimer and attribution), accessibility pass. Deploy and run "Verify the deployment" before any public use.
