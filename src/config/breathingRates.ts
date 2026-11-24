import type { ActivityIntensity, AgeGroup } from "@/lib/engine/types";

/**
 * Short-term inhalation rates by age group and activity level.
 * Source: U.S. EPA, "Exposure Factors Handbook: 2011 Edition", Chapter 6, Table 6-2
 * "Recommended Short-Term Exposure Values for Inhalation (males and females combined)",
 * mean and 95th percentile, in m3/MINUTE exactly as printed (read from the document, 2026-11-24).
 * https://www.epa.gov/sites/production/files/2015-09/documents/efh-chapter06.pdf
 *
 * The EPA activity levels are mapped as: light -> "Light Intensity", moderate -> "Moderate
 * Intensity", vigorous -> "High Intensity". The figures are US-derived population means, not
 * Indian measurements and not any individual's breathing rate. Only the six age bands the
 * engine uses are carried; the handbook lists more.
 */

export interface InhalationRate {
  /** m3 per minute, as printed in the handbook. */
  readonly meanPerMinute: number;
  readonly p95PerMinute: number;
}

type RateTable = Readonly<Record<ActivityIntensity, InhalationRate>>;

const r = (meanPerMinute: number, p95PerMinute: number): InhalationRate => ({ meanPerMinute, p95PerMinute });

export const INHALATION_RATES: Readonly<Record<AgeGroup, RateTable>> = {
  "3-<6": { light: r(1.1e-2, 1.4e-2), moderate: r(2.1e-2, 2.7e-2), vigorous: r(3.7e-2, 4.8e-2) },
  "6-<11": { light: r(1.1e-2, 1.5e-2), moderate: r(2.2e-2, 2.9e-2), vigorous: r(4.2e-2, 5.9e-2) },
  "21-<31": { light: r(1.2e-2, 1.6e-2), moderate: r(2.6e-2, 3.8e-2), vigorous: r(5.0e-2, 7.6e-2) },
  "31-<41": { light: r(1.2e-2, 1.6e-2), moderate: r(2.7e-2, 3.7e-2), vigorous: r(4.9e-2, 7.2e-2) },
  "61-<71": { light: r(1.2e-2, 1.6e-2), moderate: r(2.6e-2, 3.4e-2), vigorous: r(4.7e-2, 6.6e-2) },
  "71-<81": { light: r(1.2e-2, 1.5e-2), moderate: r(2.5e-2, 3.2e-2), vigorous: r(4.7e-2, 6.5e-2) },
};

export const BREATHING_RATE_SOURCE = {
  title: "Exposure Factors Handbook: 2011 Edition, Chapter 6 (Inhalation Rates), Table 6-2",
  publisher: "U.S. Environmental Protection Agency",
  year: 2011,
  url: "https://www.epa.gov/sites/production/files/2015-09/documents/efh-chapter06.pdf",
} as const;

/**
 * Respirator protection ceiling. A filtering facepiece or half-mask respirator has an OSHA
 * assigned protection factor of 10 (29 CFR 1910.134, Table 1), which holds only for fit-tested
 * wearers in a respiratory-protection programme: at most 1 - 1/10 = 90% reduction of the
 * concentration inhaled. NIOSH certifies N95 filter MEDIA at >= 95% (42 CFR Part 84), but
 * leakage around an unfitted facepiece is typically the limiting factor. The engine therefore
 * only ever reports the 90% figure as a BEST-CASE ceiling, never as an expected value.
 */
export const RESPIRATOR_BEST_CASE_REDUCTION = {
  fraction: 0.9,
  source: "OSHA 29 CFR 1910.134 Table 1 (assigned protection factor 10 for filtering facepiece / half-mask respirators)",
  url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.134",
  certification: "NIOSH 42 CFR Part 84 (N95 filter media efficiency of at least 95%)",
  certificationUrl: "https://www.ecfr.gov/current/title-42/chapter-I/subchapter-G/part-84",
} as const;
