import { CONFIDENCE_PENALTY } from "@/config/advisoryThresholds";

import { buildConfidence } from "./confidence";
import { prioritize, type PriorityResult } from "./prioritization";
import type {
  Confidence,
  ConfidenceFactor,
  CostLevel,
  DataRef,
  Explanation,
  Feasibility,
  PriorityTier,
  ProfilePreset,
  ResolvedPreferences,
  SeverityLevel,
} from "./types";

/**
 * Indoor air quality interventions. The app has NO indoor sensor: nothing here is a measurement of
 * indoor air. The only indoor number the engine can see is a PM2.5 reading the user typed in, and
 * it is always labelled as user-reported. Advice that depends on whether indoor or outdoor air is
 * cleaner is therefore conditional, and the engine never assumes outdoor air is the cleaner one.
 *
 * Every intervention states the action, why it helps, priority, cost level, feasibility, evidence
 * category and limitations. Evidence categories (an honest label, not a study count):
 *   agency-guidance        stated in guidance from a public-health or environmental agency
 *   engineering-principle  follows from how particles and air move; no specific study is claimed
 *   limited-evidence       plausible and commonly advised, but weakly supported or variable
 */

export type InterventionCategory = "source-control" | "cleaning" | "filtration" | "ventilation" | "lifestyle";
export type EvidenceCategory = "agency-guidance" | "engineering-principle" | "limited-evidence";

export interface Reference {
  readonly title: string;
  readonly url: string;
}

export interface IndoorIntervention {
  readonly id: string;
  readonly category: InterventionCategory;
  readonly action: string;
  readonly whyItHelps: string;
  readonly priority: PriorityTier;
  readonly priorityDetail: PriorityResult;
  readonly costLevel: CostLevel;
  readonly feasibility: Feasibility;
  readonly evidenceCategory: EvidenceCategory;
  readonly limitations: readonly string[];
  /** When this advice applies; present for conditional advice. */
  readonly conditions: readonly string[];
  readonly references: readonly Reference[];
  readonly explanation: Explanation;
}

export interface IndoorMeasurement {
  readonly status: "no-indoor-sensor" | "user-reported";
  readonly pm25UgM3: number | null;
  readonly note: string;
}

export interface IndoorSection {
  readonly measurement: IndoorMeasurement;
  readonly interventions: readonly IndoorIntervention[];
}

/** The relatively lower-pollution outdoor window used to time brief ventilation, if one exists. */
export interface VentilationOutlook {
  readonly startLocal: string;
  readonly endLocal: string;
  readonly pm25MeanUgM3: number;
  readonly forecastHours: readonly string[];
}

export interface IndoorInput {
  readonly preset: ProfilePreset;
  readonly preferences: ResolvedPreferences;
  readonly severity: SeverityLevel;
  readonly aqiRef: DataRef | null;
  readonly outlook: VentilationOutlook | null;
  readonly stale: boolean;
  readonly dataAvailable: boolean;
}

/** Indoor reading must exceed the outdoor outlook by this factor before ventilation is suggested. Engine policy. */
export const VENTILATION_ADVANTAGE_FACTOR = 0.8;

const EPA_GUIDE: Reference = {
  title: "U.S. EPA: Guide to Air Cleaners in the Home (2nd edition)",
  url: "https://www.epa.gov/indoor-air-quality-iaq/guide-air-cleaners-home",
};
const EPA_IAQ: Reference = {
  title: "U.S. EPA: Introduction to Indoor Air Quality",
  url: "https://www.epa.gov/indoor-air-quality-iaq/introduction-indoor-air-quality",
};
const WHO_HOUSEHOLD_FUEL: Reference = {
  title: "WHO guidelines for indoor air quality: household fuel combustion (2014)",
  url: "https://www.who.int/publications/i/item/9789241548885",
};

interface Draft {
  readonly id: string;
  readonly category: InterventionCategory;
  readonly action: string;
  readonly whyItHelps: string;
  readonly costLevel: CostLevel;
  readonly feasibility: Feasibility;
  readonly evidenceCategory: EvidenceCategory;
  readonly limitations: readonly string[];
  readonly conditions?: readonly string[];
  readonly references?: readonly Reference[];
  readonly minTier?: PriorityTier;
  readonly maxTier?: PriorityTier;
  readonly ruleIds: readonly string[];
  readonly assumptionIds?: readonly string[];
  readonly triggers: readonly DataRef[];
  readonly extraFactors?: readonly ConfidenceFactor[];
  readonly impact?: string;
  /** True when the advice reacts to forecast data (as opposed to being general good practice). */
  readonly dataDriven: boolean;
}

export function buildIndoorSection(input: IndoorInput): IndoorSection {
  const { preset, preferences: prefs, severity } = input;
  const drafts: Draft[] = [];
  const generalTrigger = (ref: string): DataRef => ({ kind: "rule", ref });
  const poor = severity === "high" || severity === "very-high";
  const elevated = poor || severity === "moderate";
  const combustionFuel = prefs.cookingFuel === "biomass" || prefs.cookingFuel === "kerosene";

  // A. Source control
  drafts.push({
    id: "IND_AVOID_INDOOR_SMOKE",
    category: "source-control",
    action: "Avoid burning incense, dhoop, mosquito coils, candles and cigarettes indoors, especially in the rooms where people spend the most time.",
    whyItHelps: "These produce fine particles inside the home, where they stay close to you. Removing a source works regardless of what the outdoor air is doing.",
    costLevel: "none",
    feasibility: "high",
    evidenceCategory: "agency-guidance",
    limitations: ["Cultural and religious practices may matter to the household; a smaller amount, or burning where air can leave the home, still reduces build-up.", "Does not change pollution that enters from outdoors."],
    references: [EPA_IAQ],
    minTier: "recommended",
    ruleIds: ["RULE_SOURCE_CONTROL_FIRST"],
    triggers: [generalTrigger("RULE_SOURCE_CONTROL_FIRST")],
    dataDriven: false,
  });
  drafts.push({
    id: "IND_COOKING_EXHAUST",
    category: "source-control",
    action: "Use the kitchen chimney or exhaust fan whenever you cook, and keep the kitchen door closed so cooking smoke does not spread to bedrooms and play areas.",
    whyItHelps: "Cooking is a major indoor source of particles. Capturing it at the source is more effective than cleaning the air afterwards.",
    costLevel: "low",
    feasibility: "medium",
    evidenceCategory: "agency-guidance",
    limitations: ["Only helps if an exhaust exists and vents outdoors.", "Running an exhaust pulls in outdoor air; on very poor days pair it with the closed-windows advice."],
    references: [EPA_IAQ],
    minTier: prefs.cookingFuel === "electric" ? undefined : "recommended",
    ruleIds: ["RULE_SOURCE_CONTROL_FIRST"],
    triggers: [generalTrigger("RULE_SOURCE_CONTROL_FIRST"), { kind: "preference", ref: "cookingFuel", detail: prefs.cookingFuel }],
    dataDriven: false,
  });
  drafts.push({
    id: "IND_FRYING_AND_HIGH_HEAT",
    category: "source-control",
    action: "Manage frying and high-heat cooking: use lids, keep the exhaust on, and avoid leaving oil smoking.",
    whyItHelps: "Frying and smoking oil release large amounts of fine particles in a short time.",
    costLevel: "none",
    feasibility: "high",
    evidenceCategory: "engineering-principle",
    limitations: ["Practical limits depend on the dishes you cook."],
    maxTier: "recommended",
    ruleIds: ["RULE_SOURCE_CONTROL_FIRST"],
    triggers: [generalTrigger("RULE_SOURCE_CONTROL_FIRST")],
    dataDriven: false,
  });
  if (combustionFuel) {
    drafts.push({
      id: "IND_CLEANER_COOKING_FUEL",
      category: "source-control",
      action: `Cooking with ${prefs.cookingFuel === "biomass" ? "wood, dung or crop residue" : "kerosene"} gives off large amounts of smoke indoors. Where it is available and affordable, move towards LPG, piped gas or electric cooking, and until then cook in a well-ventilated space away from sleeping and play areas.`,
      whyItHelps: "Household combustion of solid fuels and kerosene is one of the largest indoor sources of fine particles.",
      costLevel: "high",
      feasibility: "low",
      evidenceCategory: "agency-guidance",
      limitations: ["Depends on fuel access, cost and household circumstances that this app cannot see or arrange.", "A fuel change is a long-term step, not a same-day fix."],
      references: [WHO_HOUSEHOLD_FUEL],
      minTier: "recommended",
      ruleIds: ["RULE_SOURCE_CONTROL_FIRST", "RULE_COMBUSTION_FUEL_SOURCE"],
      triggers: [{ kind: "preference", ref: "cookingFuel", detail: prefs.cookingFuel }, generalTrigger("RULE_COMBUSTION_FUEL_SOURCE")],
      dataDriven: false,
    });
  }

  // B. Cleaning
  drafts.push({
    id: "IND_WET_MOP_DAMP_DUST",
    category: "cleaning",
    action: "Wet-mop floors and damp-dust surfaces instead of dry sweeping or dry dusting.",
    whyItHelps: "Dry sweeping lifts settled dust back into the air you breathe; a damp cloth traps it.",
    costLevel: "none",
    feasibility: "high",
    evidenceCategory: "engineering-principle",
    limitations: ["Removes settled dust, not particles already floating in the air.", "Avoid soaking floors; damp surfaces should dry to prevent mould."],
    ruleIds: ["RULE_CLEAN_WITHOUT_RESUSPENSION"],
    triggers: [generalTrigger("RULE_CLEAN_WITHOUT_RESUSPENSION")],
    dataDriven: false,
  });
  if (poor) {
    drafts.push({
      id: "IND_NO_DRY_SWEEPING",
      category: "cleaning",
      action: "While outdoor air is poor, do not dry-sweep or beat carpets and cushions indoors; postpone it or clean damp.",
      whyItHelps: "On poor-air days indoor dust is already likely to carry outdoor particles that settled; stirring it up adds to what you breathe.",
      costLevel: "none",
      feasibility: "high",
      evidenceCategory: "engineering-principle",
      limitations: ["Only matters on days when particle levels are elevated."],
      ruleIds: ["RULE_CLEAN_WITHOUT_RESUSPENSION", "RULE_SEVERITY_ESCALATES_ADVICE"],
      triggers: [...(input.aqiRef === null ? [] : [input.aqiRef]), generalTrigger("RULE_SEVERITY_ESCALATES_ADVICE")],
      dataDriven: true,
    });
  }

  // C. Filtration
  if (prefs.hasAirPurifier) {
    drafts.push({
      id: "IND_RUN_PURIFIER",
      category: "filtration",
      action: "Run your air purifier in the room where you spend the most time (for children or seniors, their main room or bedroom), with doors and windows closed, and at a setting suited to the room's size.",
      whyItHelps: "A HEPA-type purifier can remove fine particles from the air in the room; a larger room needs a higher clean-air delivery rate (CADR).",
      costLevel: "none",
      feasibility: "high",
      evidenceCategory: "agency-guidance",
      limitations: ["Agency guidance notes that the health improvements seen in studies are typically small.", "Works only in the room it serves and only with doors and windows kept mostly closed.", "Does not remove gases unless it has a suitable carbon filter."],
      references: [EPA_GUIDE],
      ruleIds: ["RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL"],
      triggers: [{ kind: "preference", ref: "hasAirPurifier", detail: "true" }, generalTrigger("RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL")],
      dataDriven: false,
    });
    drafts.push({
      id: "IND_PURIFIER_MAINTENANCE",
      category: "filtration",
      action: "Check and replace the purifier's filters on the manufacturer's schedule, more often in dusty months, and keep its intake clear.",
      whyItHelps: "A dirty, overloaded filter cleans poorly and can restrict airflow.",
      costLevel: "low",
      feasibility: "high",
      evidenceCategory: "agency-guidance",
      limitations: ["Replacement intervals vary by model and by how polluted your air is."],
      references: [EPA_GUIDE],
      maxTier: "recommended",
      ruleIds: ["RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL"],
      triggers: [{ kind: "preference", ref: "hasAirPurifier", detail: "true" }],
      dataDriven: false,
    });
  } else {
    drafts.push({
      id: "IND_CONSIDER_HEPA_PURIFIER",
      category: "filtration",
      action: "If it is affordable, consider a portable HEPA air purifier sized for the room you use most (check its CADR against the room size), and avoid devices that deliberately produce ozone.",
      whyItHelps: "Filtration can supplement source control by removing fine particles from the room's air.",
      costLevel: "high",
      feasibility: "low",
      evidenceCategory: "agency-guidance",
      limitations: ["Cost, running electricity and filter replacement are real barriers.", "Agency guidance notes health improvements are typically small; source control comes first.", "Ozone-emitting 'air purifiers' can irritate the lungs."],
      references: [EPA_GUIDE],
      maxTier: "recommended",
      ruleIds: ["RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL"],
      triggers: [{ kind: "preference", ref: "hasAirPurifier", detail: "false" }, generalTrigger("RULE_FILTRATION_SUPPLEMENTS_SOURCE_CONTROL")],
      dataDriven: false,
    });
  }

  // D. Ventilation: conditional, never blind.
  drafts.push(ventilationDraft(input));
  if (elevated || severity === "unknown") {
    drafts.push({
      id: "IND_DOORS_AND_WINDOWS",
      category: "ventilation",
      action: "In the hours the forecast shows the highest pollution, keep doors and windows mostly closed and close obvious gaps; avoid propping the main door open.",
      whyItHelps: "Outdoor fine particles enter through open doors, windows and gaps; closing them slows that.",
      costLevel: "low",
      feasibility: "medium",
      evidenceCategory: "engineering-principle",
      limitations: ["Homes are rarely airtight, so this slows rather than stops entry.", "Closing up also traps indoor sources, so avoid indoor smoke while sealed."],
      ruleIds: ["RULE_VENTILATION_IS_CONDITIONAL"],
      triggers: [...(input.aqiRef === null ? [] : [input.aqiRef]), { kind: "preference", ref: "ventilationPreference", detail: prefs.ventilationPreference }],
      dataDriven: true,
    });
  }

  // E. Lifestyle
  if (preset.id === "family_toddlers") {
    drafts.push({
      id: "IND_CHILD_AREA_AWAY_FROM_SOURCES",
      category: "lifestyle",
      action: "Set up children's play and sleep areas away from the kitchen, incense and any smoke source, and keep them in the room that has the purifier if you have one.",
      whyItHelps: "Children spend long hours at home and breathe more air for their size; distance from sources lowers what they inhale.",
      costLevel: "none",
      feasibility: "high",
      evidenceCategory: "engineering-principle",
      limitations: ["Layout limits what is possible in a small home."],
      ruleIds: ["RULE_SOURCE_CONTROL_FIRST"],
      triggers: [{ kind: "profile", ref: preset.id }, generalTrigger("RULE_SOURCE_CONTROL_FIRST")],
      dataDriven: false,
    });
  }
  if (elevated) {
    drafts.push({
      id: "IND_REDUCE_UNNECESSARY_OUTDOOR_TIME",
      category: "lifestyle",
      action: "On poor-air days, trim or postpone outdoor time that is not necessary, and do it in the lower-pollution part of the day where the forecast shows one.",
      whyItHelps: "Less time outdoors in higher-pollution air means less inhaled; this is the single choice entirely in your control.",
      costLevel: "none",
      feasibility: "medium",
      evidenceCategory: "limited-evidence",
      limitations: ["Some outdoor trips cannot be avoided.", "Indoor air also carries outdoor particles; staying in is not the same as being protected."],
      ruleIds: ["RULE_SEVERITY_ESCALATES_ADVICE"],
      triggers: [...(input.aqiRef === null ? [] : [input.aqiRef]), generalTrigger("RULE_SEVERITY_ESCALATES_ADVICE")],
      dataDriven: true,
    });
  }

  const interventions = drafts.map((draft) => finish(draft, input));
  return {
    measurement: measurement(prefs),
    interventions: interventions.sort((a, b) => {
      const order = { high: 0, recommended: 1, optional: 2 } as const;
      return order[a.priority] - order[b.priority] || b.priorityDetail.score - a.priorityDetail.score || (a.id < b.id ? -1 : 1);
    }),
  };
}

function measurement(prefs: ResolvedPreferences): IndoorMeasurement {
  if (prefs.indoorPm25UgM3 === null) {
    return {
      status: "no-indoor-sensor",
      pm25UgM3: null,
      note: "No indoor air quality sensor is connected, so this app does not measure or estimate indoor air quality. Indoor advice is general and conditional.",
    };
  }
  return {
    status: "user-reported",
    pm25UgM3: prefs.indoorPm25UgM3,
    note: "A PM2.5 reading you entered. The app did not measure it and cannot verify it.",
  };
}

function ventilationDraft(input: IndoorInput): Draft {
  const { preferences: prefs, severity, outlook } = input;
  const indoor = prefs.indoorPm25UgM3;
  const conditions = [
    "Only if you have a way to tell that outdoor air is not worse than indoor air (for example a PM2.5 monitor).",
    "Keep it brief, and never while a strong outdoor source (smoke, construction dust, heavy traffic) is next to the home.",
  ];
  const base = {
    id: "IND_VENTILATION_CONDITIONAL",
    category: "ventilation" as const,
    costLevel: "none" as const,
    feasibility: "high" as const,
    evidenceCategory: "agency-guidance" as const,
    references: [EPA_IAQ],
    maxTier: "recommended" as const,
    ruleIds: ["RULE_VENTILATION_IS_CONDITIONAL"],
    dataDriven: true,
  };
  const windowText = outlook === null ? null : `${outlook.startLocal} to ${outlook.endLocal}`;
  const outlookRefs: DataRef[] =
    outlook === null ? [] : [{ kind: "forecast-window", ref: outlook.forecastHours[0] ?? outlook.startLocal, detail: `forecast PM2.5 mean about ${outlook.pm25MeanUgM3} ug/m3 (${windowText})` }];

  if (indoor !== null && outlook !== null) {
    const advantage = outlook.pm25MeanUgM3 < indoor * VENTILATION_ADVANTAGE_FACTOR;
    return {
      ...base,
      action: advantage
        ? `Your reported indoor PM2.5 (${indoor} ug/m3) is higher than the forecast outdoor level for ${windowText} (about ${outlook.pm25MeanUgM3} ug/m3). A short ventilation in that window may bring indoor particles down; check your monitor afterwards and close up if it rises.`
        : `Your reported indoor PM2.5 (${indoor} ug/m3) is not clearly higher than the forecast outdoor level (about ${outlook.pm25MeanUgM3} ug/m3 in the best window). Keep windows closed and reduce indoor sources instead.`,
      whyItHelps: "Ventilation helps only when outdoor air is cleaner than indoor air; this compares your own reading with the model forecast.",
      limitations: ["The outdoor figure is a model estimate for a grid cell, not what is outside your window.", "Your indoor reading is self-reported and unverified.", "Forecast levels can change."],
      conditions,
      triggers: [...outlookRefs, { kind: "preference", ref: "indoorPm25UgM3", detail: "user-reported" }, { kind: "rule", ref: "RULE_VENTILATION_IS_CONDITIONAL" }],
      assumptionIds: ["ASM_VENTILATION_ADVANTAGE_MARGIN", "ASM_INDOOR_READING_USER_REPORTED"],
      impact: undefined,
    };
  }
  const poor = severity === "high" || severity === "very-high";
  return {
    ...base,
    action: poor
      ? "Outdoor air is forecast to be poor. Do not open windows to 'air out' the house; keep them mostly closed and rely on source control and, if you have one, a purifier. If cooking smoke builds up, use the exhaust and open a window only briefly."
      : windowText === null
        ? "Keep windows mostly closed and open them only briefly, for example while cooking or to clear stale air, and do not assume outdoor air is cleaner: the app cannot compare indoor and outdoor air without an indoor sensor."
        : `If you need to air out the house, do it briefly during the relatively lower-pollution window (${windowText}, forecast PM2.5 about ${outlook?.pm25MeanUgM3} ug/m3), not at the highest-pollution hours. The app cannot tell whether indoor air is cleaner or dirtier than this.`,
    whyItHelps: "Brief ventilation can clear cooking by-products and moisture, but it also lets outdoor particles in, so timing it to relatively lower outdoor levels limits the trade-off.",
    limitations: ["No indoor sensor is connected, so indoor and outdoor air cannot be compared.", "Outdoor figures are model estimates for a grid cell, not at your window.", "Relatively lower is not the same as low or safe."],
    conditions,
    triggers: [...outlookRefs, ...(input.aqiRef === null ? [] : [input.aqiRef]), { kind: "preference", ref: "ventilationPreference", detail: prefs.ventilationPreference }, { kind: "rule", ref: "RULE_VENTILATION_IS_CONDITIONAL" }],
    assumptionIds: ["ASM_NO_INDOOR_SENSOR"],
  };
}

function finish(draft: Draft, input: IndoorInput): IndoorIntervention {
  const factors: ConfidenceFactor[] = [...(draft.extraFactors ?? [])];
  if (draft.dataDriven && !input.dataAvailable) {
    factors.push({ id: "air-data-unavailable", penalty: 0.4, detail: "Air quality data is unavailable, so advice that reacts to it cannot be justified." });
  }
  if (draft.dataDriven && input.stale) {
    factors.push({ id: "stale-data", penalty: CONFIDENCE_PENALTY.staleData, detail: "The air quality data is an earlier fetch." });
  }
  factors.push({
    id: "evidence-" + draft.evidenceCategory,
    penalty: draft.evidenceCategory === "limited-evidence" ? 0.2 : draft.evidenceCategory === "engineering-principle" ? 0.05 : 0,
    detail: `Evidence category: ${draft.evidenceCategory}.`,
  });
  const confidence: Confidence = buildConfidence(factors);

  const priorityDetail = prioritize({
    id: draft.id,
    severity: draft.dataDriven && !input.dataAvailable ? "unknown" : input.severity,
    vulnerability: input.preset.vulnerability,
    exposureReductionUg: null,
    feasibility: draft.feasibility,
    cost: draft.costLevel,
    confidence,
    ...(draft.minTier === undefined ? {} : { minTier: draft.minTier }),
    ...(draft.maxTier === undefined ? {} : { maxTier: draft.maxTier }),
  });

  const explanation: Explanation = {
    what: draft.action,
    why: draft.whyItHelps,
    triggeredBy: draft.triggers,
    assumptionIds: draft.assumptionIds ?? [],
    ruleIds: draft.ruleIds,
    impact: draft.impact ?? null,
    confidence,
  };

  return {
    id: draft.id,
    category: draft.category,
    action: draft.action,
    whyItHelps: draft.whyItHelps,
    priority: priorityDetail.tier,
    priorityDetail,
    costLevel: draft.costLevel,
    feasibility: draft.feasibility,
    evidenceCategory: draft.evidenceCategory,
    limitations: draft.limitations,
    conditions: draft.conditions ?? [],
    references: draft.references ?? [],
    explanation,
  };
}
