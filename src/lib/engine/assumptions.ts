import { BREATHING_RATE_SOURCE, RESPIRATOR_BEST_CASE_REDUCTION } from "@/config/breathingRates";
import { INDIA_GHG_ROAD_TRANSPORT_2015 } from "@/config/emissionFactors";

import type { AssumptionRecord, Explanation, RuleRecord } from "./types";

/**
 * Registries behind every `assumptionIds` / `ruleIds` entry in the output. A test asserts that every
 * ID the engine emits resolves here, which is what makes each recommendation traceable to a
 * documented rule or a sourced / declared assumption.
 */

const a = (r: AssumptionRecord): [string, AssumptionRecord] => [r.id, r];

export const ASSUMPTIONS: Readonly<Record<string, AssumptionRecord>> = Object.fromEntries([
  a({ id: "ASM_WINDOW_CPCB_SCALE_INDICATOR", kind: "engine-policy", statement: "Windows are compared on the CPCB sub-index scale applied to window-mean hourly model concentrations; the highest pollutant sub-index is the window indicator. It is a comparison indicator, not an AQI (CPCB's AQI needs 24-hour averages and station data).", source: "CPCB AQI technical report, Table 3.11 (via the repository's AQI engine)", url: null }),
  a({ id: "ASM_HOURLY_VALUE_STEP", kind: "engine-policy", statement: "Each hourly model value is treated as representing the clock hour that begins at its timestamp; windows take a time-weighted mean of the hours they overlap.", source: null, url: null }),
  a({ id: "ASM_ADVISORY_CEILINGS_ARE_POLICY", kind: "engine-policy", statement: "The highest indicator for which a window may be called 'relatively lower-pollution' depends on activity effort and sensitivity (src/config/advisoryThresholds.ts). These are configurable engine policy, derived from CPCB category boundaries, not medical or dose-response thresholds, and no level is described as safe.", source: "CPCB AQI categories (Table 3.2)", url: null }),
  a({ id: "ASM_PRESET_SCHEDULE", kind: "preset-default", statement: "Activity times and durations come from the evaluator preset unless you supplied a schedule; they are illustrative, not observed behaviour.", source: null, url: null }),
  a({ id: "ASM_PRESET_DISTANCE", kind: "preset-default", statement: "The one-way commute distance is a preset default, not a measurement; CO2 figures that use it scale directly with it.", source: null, url: null }),
  a({ id: "ASM_PRESET_AGE_GROUP", kind: "preset-default", statement: "The breathing-rate age band comes from the preset unless you chose one. Individual breathing rates differ.", source: BREATHING_RATE_SOURCE.title, url: BREATHING_RATE_SOURCE.url }),
  a({ id: "ASM_EMISSION_FACTORS_TAILPIPE_CO2", kind: "sourced", statement: "Emission factors are India-specific, fuel-based TAILPIPE CO2 only: no methane or nitrous oxide, no fuel production, no vehicle lifecycle. The source document is a 2015 stakeholder-consultation draft. Tailpipe CO2, well-to-wheel CO2e and lifecycle emissions are never mixed.", source: `${INDIA_GHG_ROAD_TRANSPORT_2015.publisher}, ${INDIA_GHG_ROAD_TRANSPORT_2015.title}, ${INDIA_GHG_ROAD_TRANSPORT_2015.year}`, url: INDIA_GHG_ROAD_TRANSPORT_2015.url }),
  a({ id: "ASM_ACTIVE_MODES_ZERO_TAILPIPE", kind: "engine-policy", statement: "Walking and cycling burn no fuel, so tailpipe CO2 is zero by definition. Food and equipment lifecycle emissions are not counted.", source: null, url: null }),
  a({ id: "ASM_ACTIVE_TRAVEL_SPEEDS", kind: "engine-policy", statement: "Walking is assumed at 5 km/h and cycling at 15 km/h, and walking/cycling are treated as practical up to 3 km and 10 km one way. Typical-use assumptions, not measurements.", source: null, url: null }),
  a({ id: "ASM_CARPOOL_OCCUPANCY", kind: "engine-policy", statement: "A carpool alternative assumes at least three occupants unless the household states more. Carpooling divides the same vehicle emissions among occupants; it does not change them.", source: null, url: null }),
  a({ id: "ASM_MODE_EXPOSURE_QUALITATIVE", kind: "engine-policy", statement: "Mode exposure is compared qualitatively (open vs enclosed travel, breathing rate). No route-level or in-vehicle pollution data is available, so mode exposure is never quantified.", source: null, url: null }),
  a({ id: "ASM_NO_INDOOR_SENSOR", kind: "engine-policy", statement: "No indoor air quality sensor is connected. The app neither measures nor estimates indoor air quality, so indoor advice is general and conditional.", source: null, url: null }),
  a({ id: "ASM_INDOOR_READING_USER_REPORTED", kind: "engine-policy", statement: "An indoor PM2.5 figure, when present, was typed in by the user. It is unverified and not an app measurement.", source: null, url: null }),
  a({ id: "ASM_VENTILATION_ADVANTAGE_MARGIN", kind: "engine-policy", statement: "Brief ventilation is only suggested when the forecast outdoor PM2.5 is below 80% of the reported indoor reading.", source: null, url: null }),
  a({ id: "ASM_NO_CHAINING_CO2", kind: "engine-policy", statement: "No CO2 or exposure saving is claimed for trip chaining: errand distances are unknown.", source: null, url: null }),
  a({ id: "ASM_BREATHING_RATES_EPA", kind: "sourced", statement: "Breathing rates are US-population means by age band and activity level (EPA Exposure Factors Handbook 2011, Table 6-2); they are not Indian measurements and not any individual's rate.", source: BREATHING_RATE_SOURCE.title, url: BREATHING_RATE_SOURCE.url }),
  a({ id: "ASM_AMBIENT_NOT_PERSONAL", kind: "engine-policy", statement: "Ambient model PM2.5 is not personal exposure: indoor infiltration, microenvironments and local sources differ, and the forecast is a grid-cell model estimate.", source: null, url: null }),
  a({ id: "ASM_RESPIRATOR_BEST_CASE", kind: "sourced", statement: "A respirator is credited with at most a 90% reduction (OSHA assigned protection factor 10 for filtering facepiece / half-mask respirators, for fit-tested wearers). This is a best-case ceiling, not an expected value; poor fit can reduce protection to little.", source: RESPIRATOR_BEST_CASE_REDUCTION.source, url: RESPIRATOR_BEST_CASE_REDUCTION.url }),
].map((r) => r));

const r = (rule: RuleRecord): [string, RuleRecord] => [rule.id, rule];

export const RULES: Readonly<Record<string, RuleRecord>> = Object.fromEntries([
  r({ id: "RULE_WINDOW_COMPARISON", statement: "A window is 'relatively lower-pollution' only if it is under the advisory ceiling for the activity and at least 15% below the median candidate window; otherwise the engine says there is no meaningful difference or no suitable window.", basis: "Engine policy (advisoryThresholds.ts)" }),
  r({ id: "RULE_NEVER_CALL_SAFE", statement: "No window, level or action is described as safe. 'Relatively lower-pollution' is a comparison with other times, never a health claim.", basis: "Scientific-integrity principle of the engine" }),
  r({ id: "RULE_DIP_IS_NOT_AN_INVITATION", statement: "A temporary forecast dip is not a reason to do vigorous outdoor exercise: the ceiling for vigorous effort is the strictest, and indoor alternatives are offered.", basis: "Higher breathing rate during vigorous activity (EPA Exposure Factors Handbook, Table 6-2)" }),
  r({ id: "RULE_TRIP_CHAINING", statement: "Two or more errand-type activities are combined into one journey placed in the lowest available window, within the overlap of their allowed times.", basis: "Fewer separate trips means fewer separate outdoor exposures and vehicle trips" }),
  r({ id: "RULE_TRANSPORT_THREE_AXES", statement: "Transport options are compared separately on environmental impact, personal exposure and convenience; they are not merged into one score.", basis: "A lower-carbon option is not automatically lower exposure" }),
  r({ id: "RULE_ACTIVE_MODE_HELD_BACK_WHEN_POOR", statement: "Walking and cycling are not put forward when severity is high or very high, although they emit no tailpipe CO2.", basis: "Effort raises the breathing rate (EPA Table 6-2)" }),
  r({ id: "RULE_SOURCE_CONTROL_FIRST", statement: "Reducing indoor sources comes before filtration or ventilation advice.", basis: "U.S. EPA Introduction to Indoor Air Quality; EPA Guide to Air Cleaners in the Home" }),
  r({ id: "RULE_COMBUSTION_FUEL_SOURCE", statement: "Biomass and kerosene cooking trigger source-control advice at a minimum of 'recommended' priority.", basis: "WHO guidelines for indoor air quality: household fuel combustion (2014)" }),
  r({ id: "RULE_CLEAN_WITHOUT_RESUSPENSION", statement: "Prefer wet cleaning to dry sweeping; on poor-air days avoid dry sweeping altogether.", basis: "Engineering principle: dry sweeping resuspends settled dust" }),
  r({ id: "RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL", statement: "Air purifiers supplement, and do not replace, source control; purifiers must not deliberately emit ozone.", basis: "U.S. EPA Guide to Air Cleaners in the Home" }),
  r({ id: "RULE_VENTILATION_IS_CONDITIONAL", statement: "Opening windows is never recommended blindly. Without an indoor reading the engine only suggests brief ventilation in a relatively lower outdoor window and tells the user it cannot compare indoor and outdoor air.", basis: "Outdoor air is not necessarily cleaner than indoor air" }),
  r({ id: "RULE_SEVERITY_ESCALATES_ADVICE", statement: "Advice that reacts to pollution (closing up, postponing dry cleaning, trimming outdoor time) is added only when severity is moderate or worse (or unknown, for closing up).", basis: "Avoid exaggerated warnings on low-pollution days" }),
  r({ id: "RULE_TIMING_SHIFT_EXPOSURE", statement: "The exposure saving of moving an activity is the PM2.5 inhaled mass at the usual window minus at the suggested window, same breathing rate and duration, from forecast window means.", basis: "Exposure formula in exposure.ts" }),
  r({ id: "RULE_RESPIRATOR_CONDITIONAL", statement: "A respirator is mentioned for open-air two-wheeler commutes only when severity is at least moderate, and its benefit is given only as a best-case ceiling.", basis: "OSHA 29 CFR 1910.134; NIOSH 42 CFR Part 84" }),
  r({ id: "RULE_PRIORITY_SCORE", statement: "Priority = weighted severity, vulnerability, exposure reduction, feasibility, cost and confidence; 'high' needs at least moderate severity and medium confidence.", basis: "prioritization.ts" }),
].map((x) => x));

/** Look up the records behind a set of explanations. Unknown IDs are returned separately so a test can fail on them. */
export function resolveReferences(explanations: readonly Explanation[]): {
  assumptions: AssumptionRecord[];
  rules: RuleRecord[];
  unknownIds: string[];
} {
  const assumptionIds = new Set<string>();
  const ruleIds = new Set<string>();
  for (const e of explanations) {
    for (const id of e.assumptionIds) assumptionIds.add(id);
    for (const id of e.ruleIds) ruleIds.add(id);
  }
  const unknown: string[] = [];
  const assumptions: AssumptionRecord[] = [];
  const rules: RuleRecord[] = [];
  for (const id of [...assumptionIds].sort()) {
    const rec = ASSUMPTIONS[id];
    if (rec === undefined) unknown.push(id);
    else assumptions.push(rec);
  }
  for (const id of [...ruleIds].sort()) {
    const rec = RULES[id];
    if (rec === undefined) unknown.push(id);
    else rules.push(rec);
  }
  return { assumptions, rules, unknownIds: unknown };
}
