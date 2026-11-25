import type { AiReasonCode } from "./errors";
import { parseExplanation } from "./schema";
import type { AiExplanation } from "./types";

/**
 * Post-generation validation. The system prompt asks the model to behave; this file makes sure it
 * did. Anything that fails is DISCARDED WHOLE: nothing partially validated is ever shown, and the
 * caller falls back to deterministic text.
 *
 * Checks, in order:
 *  1. the text is JSON of bounded size;
 *  2. strict schema (Zod): no unknown fields, bounded non-empty strings and lists;
 *  3. recommendation IDs: every referenced ID exists, none repeats, none is invented in prose;
 *  4. text safety: no markup, links, code, control or bidirectional-override characters;
 *  5. numeric grounding: every time and number must already appear in the context sent to the model
 *     (small counting integers are tolerated only when no unit or % follows);
 *  6. claims: no diagnosis, treatment, guarantee, health-risk figure or safety claim; no claim that
 *     indoor air was measured or that the data is an official CPCB station reading; no missing
 *     pollutant presented as measured;
 *  7. no credential: no API-key shape and no configured secret value.
 *
 * The numeric check is UNIT-AWARE (Phase 3C). Every number in the context is indexed with a unit
 * class (percent, concentration, mass, grams of CO2, km, minutes, hours, AQI, unitless), taken from the
 * context key's unit suffix or from the unit written next to it in engine prose. A figure quoted by
 * the model must carry a unit class that the context gives that same value: "3 km" does not permit
 * "3 hours", a percentage is not a concentration, a gram figure must sit in a CO2 sentence, a
 * concentration must not sit in a CO2-only sentence, and "5 pm" is checked as the time 17:00. Where
 * the unit is ambiguous (a bare number the context only holds with a unit) the explanation is rejected.
 * Remaining limit: it does not understand what a number is ABOUT beyond its unit, so a percentage the
 * context attaches to one activity could still be attached by the model to another.
 *
 * Negation is respected ("not medically safe" is fine; "is safe" is not) by looking for a negating
 * word earlier in the same sentence. This is a guard, not a language-understanding system: it errs
 * on the side of rejecting, because a rejection costs only a fallback.
 */

export const MAX_RAW_TEXT_CHARS = 20_000;

export type RejectionReason =
  | "unknown-recommendation-id"
  | "duplicate-recommendation-id"
  | "invented-id-in-text"
  | "markup-or-link"
  | "control-characters"
  | "unsupported-number"
  | "unit-mismatch"
  | "unsupported-time"
  | "medical-claim"
  | "health-outcome-claim"
  | "guarantee"
  | "safety-claim"
  | "indoor-measurement-claim"
  | "official-reading-claim"
  | "missing-pollutant-claim"
  | "credential-leak";

export type ValidationOutcome =
  | { readonly ok: true; readonly value: AiExplanation }
  | { readonly ok: false; readonly code: Extract<AiReasonCode, "AI_INVALID_JSON" | "AI_SCHEMA_INVALID" | "AI_VALIDATION_REJECTED">; readonly rejection: RejectionReason | null };

export interface ValidationOptions {
  /** IDs that exist in the deterministic result. */
  readonly allowedIds: readonly string[];
  /** The exact context JSON that was sent to the model: the source of every permitted number and time. */
  readonly contextJson: string;
  /** Secret values that must not appear in the output (for example the API key). */
  readonly secrets?: readonly string[];
}

/* ---------------------------------------------------------------- helpers */

const NEGATION = /\b(not|never|no|nothing|none|cannot|can't|cant|isn't|aren't|doesn't|does not|don't|do not|won't|without|neither|nor|unable|unavailable|n't|rather than|instead of)\b/i;

/**
 * True if `re` matches somewhere WITHOUT a negating word in the same sentence.
 *
 * By default only words BEFORE the match count ("is not safe" is negated; "safe, not risky" is not).
 * With `looseTrailing`, words after the match in the same sentence also count, for claims where the
 * negation naturally follows ("NH3 is not provided by the data source").
 */
function hasUnnegatedMatch(text: string, re: RegExp, looseTrailing = false): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(global)) {
    const start = m.index ?? 0;
    const before = text.slice(0, start);
    const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
    let window = before.slice(sentenceStart).slice(-80);
    if (looseTrailing) {
      const after = text.slice(start + m[0].length);
      const sentenceEnd = after.search(/[.!?\n]/);
      window += ` ${(sentenceEnd === -1 ? after : after.slice(0, sentenceEnd)).slice(0, 80)}`;
    }
    if (!NEGATION.test(window)) return true;
  }
  return false;
}

function collectStrings(value: AiExplanation): string[] {
  return [
    value.overview,
    value.situationExplanation,
    value.personalizedSummary,
    ...value.topActions.flatMap((a) => [a.explanation, a.practicalGuidance]),
    value.routineExplanation,
    value.outdoorActivityExplanation,
    value.indoorAirExplanation,
    value.transportExplanation,
    value.impactExplanation,
    ...value.dataLimitations,
    value.safetyDisclaimer,
  ];
}

/* ------------------------------------------------------------ text safety */

const MARKUP = [/[<>]/, /https?:\/\//i, /\bwww\./i, /\]\(/, /`/, /\bjavascript:/i, /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i, /\bdata:[a-z]+\//i];
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/;

/* ----------------------------------------------------------------- claims */

const DIAGNOSIS: readonly RegExp[] = [
  /\bdiagnos(?:e|es|ed|is|ing)\b/i,
  /\b(?:you|your (?:child|children|kid|kids|mother|father|parents?|grandparents?|family member)|he|she|they)\s+(?:has|have|had|may have|might have|likely has|likely have|probably has|probably have|suffers? from|is suffering from|are suffering from)\s+(?:asthma|copd|bronchitis|pneumonia|emphysema|a respiratory|an? (?:lung|respiratory|heart)|lung|cancer|heart disease)/i,
  /\b(?:cures?|cured|prescri(?:be|bed|ption)|dosage|medication|inhalers?|steroids?|antibiotics?|treatment (?:for|of))\b/i,
];

const HEALTH_OUTCOMES: readonly RegExp[] = [
  /\b(?:increase[sd]?|reduce[sd]?|lower(?:s|ed)?|decrease[sd]?|cut|raise[sd]?|elevate[sd]?)\s+(?:your |the |their |any )?(?:risk|chance|chances|likelihood|odds)\b/i,
  /\b(?:asthma attacks?|heart attacks?|strokes?|hospitali[sz]ations?|premature deaths?|mortality|cancer|lung damage|lung disease|dies?|death)\b/i,
];

const GUARANTEES: readonly RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\bwill (?:definitely|certainly|always|surely|completely|fully)\b/i,
  /\bwill (?:protect|prevent|eliminate|cure|stop|remove|avoid|shield)\b/i,
  /\b(?:risk[- ]free|no (?:health )?risk|zero risk|completely (?:clean|healthy)|nothing to worry|harmless|no danger|all clear)\b/i,
  /\b100\s?%/,
];

const SAFETY = /\bsafe(?:ly|r|st)?\b/i;
const HEALTHY_CLAIM = /\b(?:perfectly|totally|completely) fine\b/i;

const INDOOR_MEASURED: readonly RegExp[] = [
  /\b(?:we|our (?:sensor|monitor)|the app|this app)\b[^.]{0,40}\b(?:measured|monitored|detected|sensed|checked)\b[^.]{0,40}\bindoor/i,
  /\bindoor (?:air|air quality|pm2\.5|levels?|pollution)\b[^.]{0,40}\b(?:was|were|is|are|has been|have been)\s+(?:measured|monitored|detected|checked)/i,
];

const OFFICIAL_READING = /\bofficial\s+(?:cpcb\s+|government\s+)?(?:monitoring[- ]station\s+|station\s+)?(?:readings?|measurements?|data|figures?)\b/i;

const MISSING_POLLUTANT = /\b(?:nh3|ammonia|pb)\b/i;

const KEY_SHAPE = /AIza[0-9A-Za-z_-]{20,}/;

/* --------------------------------------------------------------- numbers */

/** A clock time. A trailing colon or full stop is punctuation ("at 17:00: a drop"), not part of the time. */
const TIME = /(?<![\d:.])(\d{1,2}):(\d{2})(?!\d|:\d)/g;
const MERIDIEM = /(?<![\d:.])(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/gi;
const NUMBER = /\d+(?:\.\d+)?/g;
const POLLUTANT_NAMES = /\b(?:PM\s?2\.?5|PM\s?10|NO2|SO2|O3|CO2e?|CO)\b/gi;

export type Unit = "percent" | "concentration" | "mass_ug" | "grams" | "kg" | "km" | "minutes" | "hours" | "days" | "times" | "temperature" | "aqi" | "none";

/** The unit written immediately after a number (`after` is the text following it). */
function unitAfter(after: string, before: string): Unit {
  if (/^\s*(?:µg|μg|ug|mcg)\s*\/\s*m(?:³|3)/i.test(after)) return "concentration";
  if (/^\s*(?:µg|μg|ug|mcg)\b/i.test(after)) return "mass_ug";
  if (/^\s*(?:%|percent\b)/i.test(after)) return "percent";
  if (/^\s*(?:kg|kilograms?)\b/i.test(after)) return "kg";
  if (/^\s*(?:g\b|gCO2|grams?\b)/i.test(after)) return "grams";
  if (/^\s*(?:km|kilomet(?:er|re)s?)\b/i.test(after)) return "km";
  if (/^\s*(?:mins?|minutes?)\b/i.test(after)) return "minutes";
  if (/^\s*-?\s*(?:hours?|hrs?|h)\b/i.test(after)) return "hours";
  if (/^\s*(?:days?|weeks?)\b/i.test(after)) return "days";
  if (/^\s*times\b/i.test(after)) return "times";
  if (/^\s*(?:°|degrees?\b)/i.test(after)) return "temperature";
  if (/^\s*aqi\b/i.test(after) || /\baqi\s*(?:of|is|at|was|reading|:|=)?\s*$/i.test(before)) return "aqi";
  return "none";
}

/** The unit a context KEY promises, by its suffix (see the naming note in `context.ts`). */
function unitForKey(key: string): Unit {
  const k = key.toLowerCase();
  if (k === "aqi") return "aqi";
  if (k.endsWith("percent")) return "percent";
  if (k.endsWith("ugm3")) return "concentration";
  if (k.endsWith("ug")) return "mass_ug";
  if (k.endsWith("gco2")) return "grams";
  if (k.endsWith("km")) return "km";
  if (k.endsWith("min")) return "minutes";
  return "none";
}

const STRIP_NON_QUANTITY = (text: string): string =>
  text
    .replace(/\/m3\b/gi, "/m³")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/g, " ")
    .replace(/(?<![\d:.])\d{1,2}:\d{2}(?!\d|:\d)/g, " ")
    .replace(/\d+-<\d+/g, " ")
    .replace(/[A-Za-z_][A-Za-z0-9_.<>-]*\d[A-Za-z0-9_.<>-]*/g, " ")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");

export type Quantities = Map<Unit, Set<number>>;

function addQuantity(map: Quantities, unit: Unit, value: number): void {
  let set = map.get(unit);
  if (set === undefined) map.set(unit, (set = new Set()));
  set.add(value);
}

function addProse(map: Quantities, text: string): void {
  const clean = STRIP_NON_QUANTITY(text);
  for (const m of clean.matchAll(NUMBER)) {
    const index = m.index ?? 0;
    addQuantity(map, unitAfter(clean.slice(index + m[0].length), clean.slice(0, index)), Number(m[0]));
  }
}

/**
 * Index every number in the context with the unit class the context gives it. Numbers in prose take
 * the unit written beside them; numeric leaves take the unit promised by their key suffix.
 */
export function groundedQuantities(contextJson: string): Quantities {
  const map: Quantities = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return map;
  }
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "number") addQuantity(map, unitForKey(key), value);
    else if (typeof value === "string") addProse(map, value);
    else if (Array.isArray(value)) for (const item of value) walk(item, key);
    else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(parsed, "");
  return map;
}

/**
 * Numbers the model may repeat, ignoring units: the numeric values and prose figures in the context.
 * Digits that are only part of a timestamp, a clock time, an identifier or an age band are removed
 * first, otherwise small integers would be permitted everywhere and the check would prove nothing.
 */
export function groundedNumbers(contextJson: string): Set<number> {
  const out = new Set<number>();
  for (const m of STRIP_NON_QUANTITY(contextJson).matchAll(NUMBER)) out.add(Number(m[0]));
  return out;
}

const pad = (n: string): string => n.padStart(2, "0");

function timesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TIME)) out.add(`${pad(m[1] ?? "")}:${m[2] ?? "00"}`);
  return out;
}

/** 12-hour clock to 24-hour "HH:MM", or null if it is not a valid time. */
function meridiemTo24(hour: string, minute: string | undefined, suffix: string): string | null {
  const h = Number(hour);
  if (h < 1 || h > 12) return null;
  const h24 = (h % 12) + (suffix.toLowerCase() === "p" ? 12 : 0);
  return `${pad(String(h24))}:${minute ?? "00"}`;
}

const mentionsCo2 = (s: string): boolean => /CO2e?\b|\bcarbon\b/i.test(s);
const mentionsPm = (s: string): boolean => /\bPM\s?(?:2\.?5|10)\b|\bparticulate|\bexposure\b|\binhal/i.test(s);

interface NumericContext {
  readonly quantities: Quantities;
  readonly times: ReadonlySet<string>;
  readonly allValues: ReadonlySet<number>;
}

/** The reason a string contains an ungrounded time, number or unit, or null. */
function ungroundedNumber(text: string, ctx: NumericContext): RejectionReason | null {
  for (const m of text.matchAll(TIME)) {
    // "5:00 pm" is a 12-hour time, checked below as 17:00 (not as 05:00).
    if (/^\s*[ap]\.?m\b/i.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    if (!ctx.times.has(`${pad(m[1] ?? "")}:${m[2] ?? "00"}`)) return "unsupported-time";
  }
  for (const m of text.matchAll(MERIDIEM)) {
    const converted = meridiemTo24(m[1] ?? "", m[2], m[3] ?? "a");
    if (converted === null || !ctx.times.has(converted)) return "unsupported-time";
  }

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const scrubbed = sentence
      .replace(TIME, " ")
      .replace(MERIDIEM, " ")
      .replace(POLLUTANT_NAMES, " ")
      .replace(/(\d),(?=\d{3}\b)/g, "$1")
      .replace(/\/m3\b/gi, "/m³");
    for (const m of scrubbed.matchAll(NUMBER)) {
      const value = Number(m[0]);
      const index = m.index ?? 0;
      const after = scrubbed.slice(index + m[0].length);
      const unit = unitAfter(after, scrubbed.slice(0, index));

      if (unit === "none") {
        // A bare number must be a unitless figure the context holds (AQI, a count) or a small counting integer.
        if (ctx.quantities.get("none")?.has(value) === true || ctx.quantities.get("aqi")?.has(value) === true) continue;
        if (Number.isInteger(value) && value >= 1 && value <= 9) continue;
        return ctx.allValues.has(value) ? "unit-mismatch" : "unsupported-number";
      }
      if (unit === "hours" && (value === 24 || value === 12)) continue;
      if (ctx.quantities.get(unit)?.has(value) !== true) return ctx.allValues.has(value) ? "unit-mismatch" : "unsupported-number";

      // The unit is grounded for this value; check it is not attached to the wrong quantity.
      if ((unit === "grams" || unit === "kg") && !mentionsCo2(sentence)) return "unit-mismatch";
      if ((unit === "concentration" || unit === "mass_ug") && mentionsCo2(sentence) && !mentionsPm(sentence)) return "unit-mismatch";
    }
  }
  return null;
}

/* ------------------------------------------------------- per-string checks */

const numericContextOf = (contextJson: string): NumericContext => ({
  quantities: groundedQuantities(contextJson),
  times: timesIn(contextJson),
  allValues: groundedNumbers(contextJson),
});

const secretsOf = (options: ValidationOptions): string[] => (options.secrets ?? []).filter((s) => s.length >= 8);

/**
 * Every text-level rule, applied to ONE string: invented IDs, control characters, markup, credentials,
 * ungrounded numbers and times, and the medical, health-outcome, guarantee, safety, indoor-measurement,
 * official-reading and missing-pollutant claims. Returns the first rule broken, or null.
 */
function checkText(text: string, allowed: ReadonlySet<string>, numeric: NumericContext, secrets: readonly string[]): RejectionReason | null {
  for (const m of text.matchAll(/\b(?:ROUTINE|INDOOR|TRANSPORT|EXP)_[A-Za-z0-9_-]+/g)) {
    if (!allowed.has(m[0])) return "invented-id-in-text";
  }
  if (CONTROL.test(text)) return "control-characters";
  if (MARKUP.some((re) => re.test(text))) return "markup-or-link";
  if (KEY_SHAPE.test(text) || secrets.some((s) => text.includes(s))) return "credential-leak";

  const number = ungroundedNumber(text, numeric);
  if (number !== null) return number;

  if (DIAGNOSIS.some((re) => hasUnnegatedMatch(text, re))) return "medical-claim";
  if (HEALTH_OUTCOMES.some((re) => hasUnnegatedMatch(text, re))) return "health-outcome-claim";
  if (GUARANTEES.some((re) => hasUnnegatedMatch(text, re))) return "guarantee";
  if (hasUnnegatedMatch(text, SAFETY) || hasUnnegatedMatch(text, HEALTHY_CLAIM)) return "safety-claim";
  if (INDOOR_MEASURED.some((re) => hasUnnegatedMatch(text, re, true))) return "indoor-measurement-claim";
  if (hasUnnegatedMatch(text, OFFICIAL_READING, true)) return "official-reading-claim";
  if (hasUnnegatedMatch(text, MISSING_POLLUTANT, true)) return "missing-pollutant-claim";
  return null;
}

/**
 * The same text rules for free-form prose that is not an explanation (the chat answer). Returns the
 * rule broken, or null when the text may be shown. Never throws.
 */
export function validateAnswerText(text: string, options: ValidationOptions): RejectionReason | null {
  return checkText(text, new Set(options.allowedIds), numericContextOf(options.contextJson), secretsOf(options));
}

/* ------------------------------------------------------------------ main */

const reject = (rejection: RejectionReason): ValidationOutcome => ({ ok: false, code: "AI_VALIDATION_REJECTED", rejection });

/** Validate raw model text. Never throws. */
export function validateModelText(rawText: string, options: ValidationOptions): ValidationOutcome {
  if (rawText.length === 0) return { ok: false, code: "AI_INVALID_JSON", rejection: null };
  if (rawText.length > MAX_RAW_TEXT_CHARS) return { ok: false, code: "AI_SCHEMA_INVALID", rejection: null };
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, code: "AI_INVALID_JSON", rejection: null };
  }
  return validateExplanation(json, options);
}

/** Validate an already-parsed candidate (also used to re-check cached entries). Never throws. */
export function validateExplanation(candidate: unknown, options: ValidationOptions): ValidationOutcome {
  const parsed = parseExplanation(candidate);
  if (!parsed.ok) return { ok: false, code: "AI_SCHEMA_INVALID", rejection: null };
  const value = parsed.value;

  // 3. Recommendation IDs.
  const allowed = new Set(options.allowedIds);
  const seen = new Set<string>();
  for (const action of value.topActions) {
    if (!allowed.has(action.recommendationId)) return reject("unknown-recommendation-id");
    if (seen.has(action.recommendationId)) return reject("duplicate-recommendation-id");
    seen.add(action.recommendationId);
  }

  const strings = collectStrings(value);
  const numeric = numericContextOf(options.contextJson);
  const secrets = secretsOf(options);

  for (const text of strings) {
    const rejection = checkText(text, allowed, numeric, secrets);
    if (rejection !== null) return reject(rejection);
  }
  return { ok: true, value };
}
