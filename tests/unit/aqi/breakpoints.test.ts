import { describe, expect, it } from "vitest";

import {
  BREAKPOINTS,
  POLLUTANT_IDS,
  POLLUTANT_INFO,
  type PollutantId,
} from "@/lib/aqi";

/**
 * INDEPENDENT transcription of CPCB technical report Table 3.11 ("Breakpoints
 * for AQI Scale 0-500"), copied as the printed strings and parsed here, so the
 * test does not share code with src/lib/aqi/breakpoints.ts.
 * Source: https://airquality.cpcb.gov.in/ccr_docs/FINAL-REPORT_AQI_.pdf (p.35)
 * Column order: Good, Satisfactory, Moderate, Poor, Very poor, Severe.
 */
const PRINTED: Record<PollutantId, string[]> = {
  pm10: ["0-50", "51-100", "101-250", "251-350", "351-430", "430+"],
  pm25: ["0-30", "31-60", "61-90", "91-120", "121-250", "250+"],
  no2: ["0-40", "41-80", "81-180", "181-280", "281-400", "400+"],
  o3: ["0-50", "51-100", "101-168", "169-208", "209-748", "748+"],
  co: ["0-1.0", "1.1-2.0", "2.1-10", "10.1-17", "17.1-34", "34+"],
  so2: ["0-40", "41-80", "81-380", "381-800", "801-1600", "1600+"],
  nh3: ["0-200", "201-400", "401-800", "801-1200", "1201-1800", "1800+"],
  pb: ["0-0.5", "0.6-1.0", "1.1-2.0", "2.1-3.0", "3.1-3.5", "3.5+"],
};

const PRINTED_AQI = ["0-50", "51-100", "101-200", "201-300", "301-400", "401-500"];

const parseRange = (text: string): { low: number; high: number | null } => {
  if (text.endsWith("+")) return { low: Number(text.slice(0, -1)), high: null };
  const [low, high] = text.split("-").map(Number);
  return { low: low ?? Number.NaN, high: high ?? Number.NaN };
};

describe("breakpoint tables match CPCB Table 3.11", () => {
  it("covers all eight pollutants", () => {
    expect(Object.keys(BREAKPOINTS).sort()).toEqual([...POLLUTANT_IDS].sort());
    expect(POLLUTANT_IDS).toHaveLength(8);
  });

  for (const pollutant of POLLUTANT_IDS) {
    describe(pollutant, () => {
      const bands = BREAKPOINTS[pollutant].bands;

      it("has six bands in CPCB category order", () => {
        expect(bands.map((b) => b.category)).toEqual([
          "good",
          "satisfactory",
          "moderately_polluted",
          "poor",
          "very_poor",
          "severe",
        ]);
      });

      it("matches the printed concentration ranges", () => {
        PRINTED[pollutant].forEach((text, i) => {
          const expected = parseRange(text);
          expect(bands[i]?.concentrationLow).toBe(expected.low);
          expect(bands[i]?.concentrationHigh).toBe(expected.high);
        });
      });

      it("matches the printed AQI ranges (Table 3.2)", () => {
        PRINTED_AQI.forEach((text, i) => {
          const expected = parseRange(text);
          expect(bands[i]?.indexLow).toBe(expected.low);
          expect(bands[i]?.indexHigh).toBe(expected.high);
        });
      });

      it("has strictly increasing concentration endpoints", () => {
        const flat = bands.flatMap((b) => (b.concentrationHigh === null ? [b.concentrationLow] : [b.concentrationLow, b.concentrationHigh]));
        // Severe's published floor equals Very Poor's upper bound, so it is not strictly greater.
        const bounded = flat.slice(0, -1);
        bounded.slice(1).forEach((value, i) => expect(value).toBeGreaterThan(bounded[i] ?? Infinity));
        expect(flat[flat.length - 1]).toBe(bounded[bounded.length - 1]);
      });
    });
  }

  it("uses CPCB-specific values, not US EPA breakpoints", () => {
    // EPA's PM2.5 "Good" tops out at 9-12 ug/m3 and PM10 "Good" at 54; CPCB's are 30 and 50.
    expect(BREAKPOINTS.pm25.bands[0]?.concentrationHigh).toBe(30);
    expect(BREAKPOINTS.pm10.bands[0]?.concentrationHigh).toBe(50);
    expect(BREAKPOINTS.pm25.bands[2]).toMatchObject({ concentrationLow: 61, concentrationHigh: 90 });
  });

  it("uses Table 3.11's endpoints where About_AQI.pdf prints overlapping ones", () => {
    expect(BREAKPOINTS.pb.bands[1]?.concentrationLow).toBe(0.6); // About_AQI.pdf prints 0.5
    expect(BREAKPOINTS.co.bands[3]?.concentrationLow).toBe(10.1); // About_AQI.pdf prints 10
    expect(BREAKPOINTS.co.bands[4]?.concentrationLow).toBe(17.1); // About_AQI.pdf prints 17
    expect(BREAKPOINTS.nh3.bands[4]?.concentrationLow).toBe(1201); // About_AQI.pdf prints 1200
  });
});

describe("pollutant metadata (Table 3.11 header)", () => {
  it("uses 8-hour averages for O3 and CO, and 24-hour for the rest", () => {
    expect(POLLUTANT_INFO.o3.averagingHours).toBe(8);
    expect(POLLUTANT_INFO.co.averagingHours).toBe(8);
    for (const id of ["pm25", "pm10", "no2", "so2", "nh3", "pb"] as const) {
      expect(POLLUTANT_INFO[id].averagingHours).toBe(24);
    }
  });

  it("expresses CO in mg/m3 and everything else in ug/m3", () => {
    expect(POLLUTANT_INFO.co.unit).toBe("mg/m3");
    for (const id of POLLUTANT_IDS.filter((p) => p !== "co")) {
      expect(POLLUTANT_INFO[id].unit).toBe("ug/m3");
    }
  });
});

describe("derived scale (documented engine decisions)", () => {
  it("the gap between adjacent bands is uniform for each pollutant", () => {
    for (const pollutant of POLLUTANT_IDS) {
      const { bands, reportingStep } = BREAKPOINTS[pollutant];
      for (let i = 0; i < 4; i += 1) {
        const upper = bands[i]?.concentrationHigh ?? Number.NaN;
        const nextLow = bands[i + 1]?.concentrationLow ?? Number.NaN;
        expect(Number((nextLow - upper).toFixed(6))).toBe(reportingStep);
      }
    }
  });

  it("derives a step of 0.1 for CO and Pb and 1 for the rest", () => {
    expect(BREAKPOINTS.co.reportingStep).toBe(0.1);
    expect(BREAKPOINTS.pb.reportingStep).toBe(0.1);
    for (const id of ["pm25", "pm10", "no2", "so2", "o3", "nh3"] as const) {
      expect(BREAKPOINTS[id].reportingStep).toBe(1);
    }
  });

  it("builds a continuous scale: 11 linear segments, each starting where the last ended", () => {
    for (const pollutant of POLLUTANT_IDS) {
      const { segments } = BREAKPOINTS[pollutant];
      expect(segments).toHaveLength(11);
      segments.slice(1).forEach((segment, i) => {
        const previous = segments[i];
        expect(segment.concentrationLow).toBe(previous?.concentrationHigh);
        expect(segment.indexLow).toBe(previous?.indexHigh);
      });
      expect(segments[0]).toMatchObject({ concentrationLow: 0, indexLow: 0 });
    }
  });

  it("starts Severe one step above Very Poor and gives it Very Poor's concentration width", () => {
    for (const pollutant of POLLUTANT_IDS) {
      const { bands, segments, reportingStep } = BREAKPOINTS[pollutant];
      const veryPoor = bands[4];
      const severe = segments[segments.length - 1];
      const veryPoorHigh = veryPoor?.concentrationHigh ?? Number.NaN;
      const veryPoorLow = veryPoor?.concentrationLow ?? Number.NaN;
      expect(severe?.kind).toBe("severe");
      expect(severe?.concentrationLow).toBeCloseTo(veryPoorHigh + reportingStep, 9);
      expect((severe?.concentrationHigh ?? 0) - (severe?.concentrationLow ?? 0)).toBeCloseTo(
        veryPoorHigh - veryPoorLow,
        9,
      );
      expect(severe).toMatchObject({ indexLow: 401, indexHigh: 500 });
    }
  });

  it("is frozen so the tables cannot be mutated at runtime", () => {
    expect(Object.isFrozen(BREAKPOINTS)).toBe(true);
    expect(Object.isFrozen(BREAKPOINTS.pm25)).toBe(true);
    expect(Object.isFrozen(BREAKPOINTS.pm25.segments)).toBe(true);
  });
});
