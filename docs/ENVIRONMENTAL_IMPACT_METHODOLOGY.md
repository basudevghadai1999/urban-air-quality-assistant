# Environmental impact and exposure methodology

Phase 3A recommendation engine, `src/lib/engine`. Everything here is deterministic TypeScript: the same inputs give the same outputs, with no network, clock, randomness or language model inside any calculation. Sources were read from the primary documents on 2026-11-24. Where a figure could not be verified, this document says so and the engine reports "unavailable" rather than estimating.

This is general information, not medical advice. No window, level or action is described as medically safe.

## 1. What the engine can and cannot claim

| It can say | It never says |
|---|---|
| A time of day is **relatively lower-pollution** compared with other times in the next 24 hours (model forecast) | That a time, level or air is safe, or that an activity carries no risk |
| A move would change **estimated inhaled PM2.5 mass** by about N micrograms (model estimate, formula and inputs shown) | That this is a measured or personal dose, or a change in health risk |
| A mode emits **N g of tailpipe CO2** per passenger over the trip (sourced factor, stated basis) | That a lower-carbon mode is lower exposure, or that figures are lifecycle or CO2e |
| Indoor advice is general and conditional | That the app measures indoor air (it has no indoor sensor) |
| A respirator can give **at most** a 90% reduction (best case) | That a respirator will achieve it |

Every number carries its basis, assumptions and a confidence. Confidence describes how well the **input data** supports a result; it says nothing about health outcomes.

## 2. Outdoor window method (`outdoorWindows.ts`, `config/advisoryThresholds.ts`)

1. Take the hourly **forecast** hours (`forecastHourlyData`) that are still in the future. History is never reused as forecast; forecast is never read as an observation.
2. Choose the pollutants usable for the whole 24-hour horizon: every hour present and non-null. **PM2.5 is required.** A pollutant with any gap is excluded from every window (so windows are compared on one basis), disclosed, and lowers confidence. A missing value is never treated as zero. NH3 and Pb are not provided by the data source and are always disclosed as such.
3. Candidate windows: every start on a 30-minute grid inside the horizon whose local clock time (IST, fixed UTC+05:30) lies between the activity's earliest and latest allowed start, with every overlapped forecast hour present. Windows over a missing hour are skipped, not interpolated.
4. Window concentration for each pollutant = time-weighted mean of the overlapped hourly values (each hourly value is treated as representing the clock hour that begins at its timestamp).
5. **Window indicator** = the highest CPCB sub-index over the usable pollutants, computed with the repository's existing CPCB breakpoint code (`calculateSubIndex`; no duplicated AQI arithmetic). A window is never favoured because one pollutant falls while another rises: the worst pollutant governs. This is a comparison indicator, **not an AQI**: CPCB's AQI needs 24-hour averages (8-hour for O3 and CO) and station data.
6. Best window = lowest indicator, ties to the earliest. Status:
   - `no-suitable-window`: the best window exceeds the ceiling for this effort and sensitivity.
   - `no-meaningful-difference`: the best is under the ceiling but less than 15% below **both** the median candidate **and** the user's usual time.
   - `recommended`: under the ceiling and at least 15% below the median or the usual time. Only then is the wording "Relatively lower-pollution window" used.
7. Also reported: up to three non-overlapping lower windows and higher-exposure windows, an alternative (next-best, non-overlapping), the pollutant responsible, comparison with the median and the usual time, a trend (first four versus last four of the next 12 hours, ±10%), and morning (05:00-11:00), afternoon (11:00-17:00) and evening (17:00-22:00) summaries (a part of the day needs at least half its hours covered).

**Advisory ceilings** (engine policy, configurable, **not medical thresholds**), as the highest window indicator for which a window may be called relatively lower:

| Effort | General | Sensitive groups (family with children, senior with respiratory issues) |
|---|---|---|
| Light | 200 | 150 |
| Moderate | 150 | 100 |
| Vigorous | 100 | 75 |

They are anchored to CPCB's AQI category boundaries (Good 0-50, Satisfactory 51-100, Moderately Polluted 101-200, Poor 201-300; CPCB technical report Table 3.2). The mapping from effort and sensitivity to a ceiling is the engine's own policy: harder breathing and sensitive groups get a stricter ceiling.

**Essential trips.** A commute cannot be skipped like a walk. If every start time is above the ceiling but one is at least 15% lower than the others, the engine still suggests it, states that all times are above the advisory level, and does not call the air acceptable. Optional activities (walks, sport, play, errands) are simply not scheduled in that case, and an indoor alternative is offered.

**Confidence factors** (score = max(0, 1 - sum of penalties); high at 0.75 or more, medium at 0.5 or more, otherwise low): model data (0.05), stale data (0.25), PM10 missing (0.15), each other missing gas (0.04), a suggested window more than 12 hours ahead (0.10) or 24 hours (0.20), forecast gaps in the next day (0.15), an assumed (preset) input (0.10).

## 3. PM2.5 exposure model (`exposure.ts`)

```
inhaled mass (ug) = C (ug/m3) x BR (m3/hour) x t (hours) x (1 - protection)
reduction = baseline inhaled mass - alternative inhaled mass
```

- **C**: window-mean forecast PM2.5 (Open-Meteo / CAMS global model), not a personal measurement.
- **BR**: US EPA, *Exposure Factors Handbook: 2011 Edition*, Chapter 6, **Table 6-2** (short-term inhalation rates by age band and activity level), mean values, printed in m3/minute and converted by x60. https://www.epa.gov/sites/production/files/2015-09/documents/efh-chapter06.pdf

  | Age band | Light (m3/h) | Moderate | Vigorous ("High Intensity") |
  |---|---|---|---|
  | 3 to <6 | 0.66 | 1.26 | 2.22 |
  | 6 to <11 | 0.66 | 1.32 | 2.52 |
  | 21 to <31 | 0.72 | 1.56 | 3.00 |
  | 31 to <41 | 0.72 | 1.62 | 2.94 |
  | 61 to <71 | 0.72 | 1.56 | 2.82 |
  | 71 to <81 | 0.72 | 1.50 | 2.82 |

  The 95th-percentile values are carried too and reported as a **sensitivity to the breathing rate only**, not a full uncertainty bound. These are US population means, not Indian measurements, and not any individual's rate. Only six age bands are carried; presets pick one and say so (`ASM_PRESET_AGE_GROUP`).
- **protection**: 0 by default. A respirator is credited only as a **best-case ceiling of 0.9**: OSHA 29 CFR 1910.134 Table 1 gives an assigned protection factor of 10 for filtering facepiece and half-mask respirators, valid for fit-tested wearers in a respiratory-protection programme (1 - 1/10 = 90%). NIOSH certifies N95 filter *media* at 95% or more (42 CFR Part 84), but leakage around an unfitted facepiece is typically the limit, so 95% is never used. The OSHA page returned HTTP 403 to automated access, so the table was not re-read on 2026-11-24; the figure is from the published standard and should be checked by a reader.
- **Indoor** concentrations are not modelled. Without an indoor sensor the indoor alternative is **unavailable**; if the user types in a PM2.5 reading, it is used and labelled "entered by the user (unverified)".

**Worked example** (adult 61 to <71, light activity, 45-minute walk): usual 06:00 forecast PM2.5 of 90 ug/m3 versus 20 ug/m3 in a lower window. BR = 0.012 x 60 = 0.72 m3/h; t = 0.75 h. Baseline = 90 x 0.72 x 0.75 = 48.6 ug. Alternative = 20 x 0.72 x 0.75 = 10.8 ug. Reduction = 37.8 ug (77.8%). (Synthetic numbers, as in the tests.)

**Every exposure result states**: baseline and alternative scenarios, the formula, each input with unit and source, the units, an uncertainty statement, the data source, and whether it is a best case. It is **unavailable**, never estimated, when a concentration is missing or invalid, a duration is outside 0 to 24 hours, a breathing-rate override is outside 0.05 to 6 m3/h, or a protection fraction is not in [0, 1).

**Limitations**: ambient model PM2.5 is not personal exposure; breathing rates vary widely; indoor infiltration is unknown; respirator performance depends on fit and use; a hourly model grid cell is not a street.

## 4. CO2 emissions (`impact.ts`, `config/emissionFactors.ts`)

```
g CO2 per passenger = factor (kg CO2/vehicle-km) x distance (km) x 1000 / occupancy      (cars, two-wheelers, carpool)
g CO2 per passenger = factor (kg CO2/passenger-km) x distance (km) x 1000                 (bus, walking, cycling)
saving = baseline emissions - alternative emissions
```

A saving is reported as a **direction** (reduction, increase, no change) with a **non-negative** magnitude, so a negative saving cannot occur.

### Emission factors and sources

| Mode | Factor | Unit | Vehicle category | Source |
|---|---|---|---|---|
| Two-wheeler | 0.0319 | kg CO2 / vehicle-km | Motorcycle <125 cc, petrol (with the paper's 10% real-world uplift; 0.0290 without) | India GHG Program, summary table |
| Private car | 0.140 | kg CO2 / vehicle-km | Hatchback <1400 cc, petrol (with 8% uplift; 0.130 without) | same |
| Carpool | 0.140 divided by occupants | kg CO2 / vehicle-km | same vehicle | same |
| Bus | 0.015161 | kg CO2 / passenger-km | Intra-city bus, State Road Transport Undertaking average | same, section 5.4 |
| Walking, cycling | 0 | | Human-powered | Definition: no fuel burned |
| **Metro** | **unavailable** | | | See below |

**Source**: India GHG Program (WRI India, CII, TERI), *India Specific Road Transport Emission Factors*, Version 1.0, 2015, **"For Stakeholder Consultation"**, a draft rather than a final standard. https://indiaghgp.org/sites/default/files/Road%20Transport%20Technical%20Paper.pdf (the figures above were read from the tables in the PDF on 2026-11-24).

- **Geography**: India national averages, not city-specific.
- **Basis**: fuel-based **tailpipe CO2 only** (published fuel efficiency raised by an uplift, times a fuel CO2 factor). It includes **no methane or nitrous oxide** (so true CO2e is somewhat higher), **no fuel production** (well-to-tank), and **no vehicle manufacture or road building** (lifecycle). The three categories (tailpipe CO2, well-to-wheel CO2e, lifecycle) are different quantities and are never mixed; every result says "tailpipe CO2" and the response carries `gas: "CO2"` and `basis: "tailpipe-co2"`.
- **Occupancy**: the paper gives none for cars and two-wheelers, so the engine divides by an explicit occupancy (default 1 for a two-wheeler, the household's stated value otherwise, and at least 3 for a carpool alternative: an engine assumption). The bus factor already reflects undertaking-wide loading and, per the paper, does not apply to BRT or intercity services.
- **Which class is used** (motorcycle <125 cc, hatchback <1400 cc) is an engine choice among the paper's many classes; a different class changes the numbers.
- **Walking and cycling** are zero by definition; food and equipment lifecycle emissions are not counted.
- **Metro: unavailable.** An electricity-based factor needs an energy-per-passenger-km figure from a primary source (for example an operator's traction energy and passenger-km). One could not be retrieved from a primary document: a search surfaced a secondary calculation of about 0.041 kWh per passenger-km from a TERI table of unstated year, which was **not used**. The engine therefore marks metro CO2 comparisons unavailable instead of estimating them.
- **Grid factor on record, not used**: CEA, *CO2 Baseline Database for the Indian Power Sector*, User Guide Version 19.0 (December 2023), Table S-1 and S-2, financial year 2022-23: 0.823 t CO2/MWh (weighted average excluding renewables) and 0.716 t CO2/MWh (including renewables and captive injection); CO2 only, generation-side. Newer versions exist (20.0 to 22.0 were listed) but could not be retrieved, so the figure may be superseded. https://cea.nic.in/api/cdm-report-version/view-pdf/en/74
- The CO2 saving of **trip chaining is never claimed**: errand distances are unknown.
- **Preset distances** (4, 3, 14 and 8 km) are illustrative defaults, flagged as assumed in every response until the user supplies a distance; CO2 figures scale linearly with distance. Weekly figures assume two trips per commuting day times the commute days per week.

### Worked example

Two-wheeler (rider only) to bus over 14 km one way:
two-wheeler = 0.0319 x 1000 x 14 / 1 = 446.6 g; bus = 0.015161 x 1000 x 14 = 212.3 g; reduction = 234.3 g (52.5%) per passenger one way; with five commuting days and two trips per day, 2343 g per week.

Solo car to a three-person carpool over 10 km: 0.140 x 1000 x 10 / 1 = 1400 g versus 0.140 x 1000 x 10 / 3 = 466.7 g; reduction 933.3 g.

## 5. Transport comparison (`transport.ts`)

Each option is described on three separate axes and never merged into one score:

1. **Environmental impact**: tailpipe CO2 per passenger (above), or unavailable.
2. **Personal exposure**: a **qualitative direction only** (lower, higher, unknown). No route-level or in-vehicle pollution data exists in this system, so mode exposure is never quantified and no road-specific claim is made. Open versus enclosed travel and the higher breathing rate of walking and cycling drive the direction; each carries a rationale and the caveat.
3. **Convenience**: the user's own commute time for the current mode; for walking (5 km/h) and cycling (15 km/h) an estimate labelled as an engine assumption; otherwise "not assessed" (service frequency and routes are unknown).

A lower-carbon option is not automatically lower exposure: walking and cycling emit no tailpipe CO2 but are **not put forward when severity is high or very high**, and are marked infeasible beyond 3 km and 10 km one way.

## 6. Indoor air (`indoor.ts`)

Source control comes first (no incense, mosquito coils or smoking indoors; kitchen exhaust; managing frying; a cleaner-fuel step for biomass and kerosene), then cleaning (wet mopping and damp dusting; no dry sweeping on poor-air days), filtration (how to run and maintain a purifier, or how to choose one by CADR and avoid ozone generators), conditional ventilation, and lifestyle steps. Every intervention states the action, why it helps, priority, cost level, feasibility, an evidence category and its limitations.

Evidence categories are honest labels, not study counts: `agency-guidance` (stated in agency guidance), `engineering-principle` (follows from how particles and air move), `limited-evidence`. References actually read: U.S. EPA *Guide to Air Cleaners in the Home* (https://www.epa.gov/indoor-air-quality-iaq/guide-air-cleaners-home) and *Introduction to Indoor Air Quality* (https://www.epa.gov/indoor-air-quality-iaq/introduction-indoor-air-quality), and WHO *guidelines for indoor air quality: household fuel combustion* (https://www.who.int/publications/i/item/9789241548885; linked and cited for the fuel-combustion step, not re-read in full). The EPA guide notes that health improvements from HEPA air cleaners are typically small, and the engine repeats that limitation.

**Ventilation is never blind.** With no indoor reading, the engine never assumes outdoor air is cleaner: it suggests brief ventilation only in a relatively lower outdoor window and says it cannot compare indoor and outdoor air. With a user-typed indoor PM2.5 reading it compares that with the forecast: ventilation is suggested only when outdoor is below 80% of the indoor figure (engine policy).

## 7. Prioritisation (`prioritization.ts`)

```
score = 0.30 severity + 0.20 vulnerability + 0.20 exposure reduction + 0.10 feasibility + 0.05 low cost + 0.15 data confidence
high >= 0.70, recommended >= 0.45, optional otherwise
```

Severity maps from the CPCB category of the estimated AQI (unknown 0.30, low 0.10, moderate 0.45, high 0.75, very high 1.0). Exposure reduction saturates at 40 ug inhaled; actions whose benefit is real but not quantified score a neutral 0.3. **Guards against exaggeration**: "high" needs at least moderate severity and at least medium data confidence; qualitative transport suggestions and trip chaining are capped at "recommended"; an item can carry a floor or ceiling tier. Order: tier, then score, then ID, so the ranking is deterministic.

## 8. Traceability

Every recommendation has an `explanation` (what, why, triggering data, assumption IDs, rule IDs, impact, confidence). Assumption IDs resolve to `RecommendationResult.assumptions` (each marked `sourced`, `engine-policy` or `preset-default`, with source and URL where one exists), and rule IDs to `RecommendationResult.rules`. A test asserts that every ID resolves.

## 9. Scientific limitations

- All pollution values are CAMS global model output at roughly 0.4 degree resolution, not station, road or home measurements; they can differ greatly from local conditions.
- The window indicator applies CPCB's sub-index scale to short windows, which CPCB does not define; it is a ranking device.
- Advisory ceilings and the 15% margin are engine policy, not clinical findings.
- Breathing rates are US means; real rates vary substantially between people and with fitness.
- No indoor, in-vehicle or route measurements exist; those comparisons are qualitative or unavailable.
- Emission factors are a 2015 consultation draft, CO2-only and tailpipe-only; metro is unavailable; the grid factor may be superseded.
- The free Open-Meteo API is for non-commercial use; whether this prototype qualifies has not been determined (see the main README).

## 10. Reproducing the numbers

All constants live in `src/config` (`breathingRates.ts`, `emissionFactors.ts`, `advisoryThresholds.ts`, `profiles.ts`). Tests in `tests/unit/engine` check each worked example above against the code.
