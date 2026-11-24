import { describe, expect, it } from "vitest";

import {
  CPCB_MIN_VALID_HOURS_24H,
  defaultWindowRequirement,
  parseTimestamp,
  rollingAverageSeries,
  windowAverage,
  type Observation,
} from "@/lib/aqi";

const END = "2025-01-15T12:00:00Z";
const END_MS = Date.parse(END);
const HOUR = 3_600_000;

/** ISO timestamp `hoursBefore` hours before END. */
const at = (hoursBefore: number): string => new Date(END_MS - hoursBefore * HOUR).toISOString();

/** `n` hourly observations: k = 0 is stamped END, k = 1 an hour earlier, and so on. */
const hourly = (n: number, value: (k: number) => number | null): Observation[] =>
  Array.from({ length: n }, (_, k) => ({ timestamp: at(k), value: value(k) }));

const opts24 = { windowHours: 24, endTime: END, minValidHours: 16 } as const;
const opts8 = { windowHours: 8, endTime: END, minValidHours: 6 } as const;

describe("parseTimestamp", () => {
  it.each([
    ["2025-01-15T12:00:00Z", END_MS],
    ["2025-01-15T12:00Z", END_MS],
    ["2025-01-15 12:00:00Z", END_MS],
    ["2025-01-15t12:00:00z", END_MS],
    ["2025-01-15T17:30:00+05:30", END_MS],
    ["2025-01-15T17:30:00+0530", END_MS],
    ["2025-01-15T07:00:00-05:00", END_MS],
    ["2025-01-15T12:00:00.250Z", END_MS + 250],
    ["2024-02-29T00:00:00Z", Date.UTC(2024, 1, 29)],
  ] as const)("accepts %s", (text, expected) => {
    expect(parseTimestamp(text)).toBe(expected);
  });

  it("accepts epoch milliseconds and valid Dates", () => {
    expect(parseTimestamp(END_MS)).toBe(END_MS);
    expect(parseTimestamp(new Date(END_MS))).toBe(END_MS);
  });

  it.each([
    ["date only", "2025-01-15"],
    ["no UTC offset (machine-dependent)", "2025-01-15T12:00:00"],
    ["February 30", "2025-02-30T00:00:00Z"],
    ["February 29 in a non-leap year", "2025-02-29T00:00:00Z"],
    ["April 31", "2025-04-31T00:00:00Z"],
    ["month 13", "2025-13-01T00:00:00Z"],
    ["month 0", "2025-00-10T00:00:00Z"],
    ["day 0", "2025-01-00T00:00:00Z"],
    ["hour 24", "2025-01-15T24:00:00Z"],
    ["hour 25", "2025-01-15T25:00:00Z"],
    ["minute 60", "2025-01-15T12:60:00Z"],
    ["second 60", "2025-01-15T12:00:60Z"],
    ["offset hour 24", "2025-01-15T12:00:00+24:00"],
    ["offset minute 60", "2025-01-15T12:00:00+05:60"],
    ["garbage", "not a time"],
    ["empty", ""],
  ] as const)("rejects %s", (_label, text) => {
    expect(parseTimestamp(text)).toBeNull();
  });

  it("rejects non-finite numbers, invalid Dates and other types", () => {
    expect(parseTimestamp(Number.NaN)).toBeNull();
    expect(parseTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseTimestamp(new Date("garbage"))).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp({})).toBeNull();
  });
});

describe("defaultWindowRequirement", () => {
  it("uses CPCB's stated 16 hours for 24-hour averages", () => {
    expect(defaultWindowRequirement(24)).toEqual({ minValidHours: 16, source: "CPCB" });
    expect(CPCB_MIN_VALID_HOURS_24H).toBe(16);
  });

  it("scales the 16/24 ratio to 6 of 8 hours and labels it an engine default", () => {
    expect(defaultWindowRequirement(8)).toEqual({ minValidHours: 6, source: "engine-default" });
  });
});

describe("windowAverage: complete windows", () => {
  it("averages a complete 24-hour window", () => {
    const result = windowAverage(hourly(24, (k) => k), opts24);
    expect(result.status).toBe("complete");
    expect(result.average).toBe(11.5); // mean of 0..23
    expect(result.stats).toMatchObject({
      windowHours: 24,
      validHours: 24,
      missingHours: 0,
      requiredValidHours: 16,
      windowEnd: "2025-01-15T12:00:00.000Z",
      windowStart: "2025-01-14T12:00:00.000Z",
    });
  });

  it("averages a complete 8-hour window", () => {
    const result = windowAverage(hourly(8, () => 10), opts8);
    expect(result).toMatchObject({ status: "complete", average: 10 });
    expect(result.stats.validHours).toBe(8);
  });

  it("uses only the newest 8 hours of a longer series for an 8-hour window", () => {
    const result = windowAverage(hourly(24, (k) => (k < 8 ? 10 : 1000)), opts8);
    expect(result.average).toBe(10);
    expect(result.stats.outsideWindow).toBe(16);
  });

  it("includes a value stamped exactly at the end and 23h earlier, but not 24h earlier", () => {
    const obs: Observation[] = [
      { timestamp: at(0), value: 10 },
      { timestamp: at(23), value: 20 },
      { timestamp: at(24), value: 999 },
    ];
    const result = windowAverage(obs, { ...opts24, minValidHours: 1 });
    expect(result.average).toBe(15);
    expect(result.stats).toMatchObject({ validHours: 2, outsideWindow: 1 });
  });

  it("honours a UTC offset when slotting", () => {
    const result = windowAverage([{ timestamp: "2025-01-15T17:30:00+05:30", value: 7 }], {
      ...opts24,
      minValidHours: 1,
    });
    expect(result.average).toBe(7);
  });

  it("counts sub-hourly readings in the same hour as one slot", () => {
    const obs: Observation[] = [
      { timestamp: new Date(END_MS - 10 * 60_000), value: 10 },
      { timestamp: new Date(END_MS - 40 * 60_000), value: 10 },
    ];
    const result = windowAverage(obs, { ...opts24, minValidHours: 1 });
    expect(result.stats).toMatchObject({ validHours: 1, duplicateSlotsCollapsed: 1 });
  });
});

describe("windowAverage: missing observations and completeness", () => {
  it("is complete at exactly the CPCB minimum of 16 valid hours", () => {
    const result = windowAverage(hourly(24, (k) => (k < 16 ? 30 : null)), opts24);
    expect(result.status).toBe("complete");
    expect(result.stats).toMatchObject({ validHours: 16, missingHours: 8 });
  });

  it("is incomplete at 15 valid hours and returns no average", () => {
    const result = windowAverage(hourly(24, (k) => (k < 15 ? 30 : null)), opts24);
    expect(result.status).toBe("incomplete");
    expect(result.average).toBeNull();
    expect(result.stats).toMatchObject({ validHours: 15, missingHours: 9 });
  });

  it("averages only the hours present: missing hours are never treated as zero", () => {
    // 16 valid hours of 30; if the 8 gaps were zero the mean would be 20.
    const result = windowAverage(hourly(24, (k) => (k < 16 ? 30 : null)), opts24);
    expect(result.average).toBe(30);
  });

  it("treats hours that are absent from the input the same as null values", () => {
    const result = windowAverage(hourly(16, () => 30), opts24);
    expect(result).toMatchObject({ status: "complete", average: 30 });
    expect(result.stats.missingHours).toBe(8);
  });

  it("is incomplete for an empty series", () => {
    const result = windowAverage([], opts24);
    expect(result.status).toBe("incomplete");
    expect(result.stats.validHours).toBe(0);
  });

  it("applies the 6-of-8 default boundary to 8-hour windows", () => {
    expect(windowAverage(hourly(8, (k) => (k < 6 ? 5 : null)), opts8).status).toBe("complete");
    expect(windowAverage(hourly(8, (k) => (k < 5 ? 5 : null)), opts8).status).toBe("incomplete");
  });

  it("supports a caller-specified minimum", () => {
    const strict = windowAverage(hourly(23, () => 1), { ...opts24, minValidHours: 24 });
    expect(strict.status).toBe("incomplete");
    const lenient = windowAverage(hourly(3, () => 1), { ...opts24, minValidHours: 3 });
    expect(lenient.status).toBe("complete");
  });
});

describe("windowAverage: duplicate timestamps", () => {
  it("collapses identical duplicates to one value", () => {
    const base = hourly(24, (k) => k);
    const result = windowAverage([...base, ...base], opts24);
    expect(result.average).toBe(11.5);
    expect(result.stats).toMatchObject({ validHours: 24, duplicateSlotsCollapsed: 24 });
  });

  it("excludes a slot whose duplicates disagree (default policy)", () => {
    const obs = [...hourly(24, () => 10), { timestamp: at(5), value: 50 }];
    const result = windowAverage(obs, opts24);
    expect(result.stats).toMatchObject({ validHours: 23, conflictingSlotsExcluded: 1 });
    expect(result.average).toBe(10);
  });

  it("with the 'last' policy keeps the newest timestamp in the slot", () => {
    const obs: Observation[] = [
      { timestamp: new Date(END_MS - 50 * 60_000), value: 20 },
      { timestamp: new Date(END_MS - 10 * 60_000), value: 99 },
      { timestamp: new Date(END_MS - 30 * 60_000), value: 55 },
    ];
    const result = windowAverage(obs, { ...opts24, minValidHours: 1, duplicatePolicy: "last" });
    expect(result.average).toBe(99);
    expect(result.stats.conflictingSlotsResolved).toBe(1);
  });

  it("breaks an exact timestamp tie by input order under 'last'", () => {
    const obs: Observation[] = [
      { timestamp: at(0), value: 1 },
      { timestamp: at(0), value: 2 },
    ];
    const result = windowAverage(obs, { ...opts24, minValidHours: 1, duplicatePolicy: "last" });
    expect(result.average).toBe(2);
  });
});

describe("windowAverage: ordering", () => {
  it("gives the same answer for unsorted input", () => {
    const sorted = hourly(24, (k) => k * 1.5);
    // Deterministic interleave: even positions first, then odd positions.
    const shuffled = [...sorted.filter((_, i) => i % 2 === 0), ...sorted.filter((_, i) => i % 2 === 1)];
    const reversed = [...sorted].reverse();
    const reference = windowAverage(sorted, opts24);
    expect(windowAverage(reversed, opts24)).toEqual(reference);
    expect(windowAverage(shuffled, opts24)).toEqual(reference);
  });

  it("'last' policy is independent of input order", () => {
    const obs: Observation[] = [
      { timestamp: new Date(END_MS - 10 * 60_000), value: 99 },
      { timestamp: new Date(END_MS - 50 * 60_000), value: 20 },
    ];
    const options = { ...opts24, minValidHours: 1, duplicatePolicy: "last" } as const;
    expect(windowAverage(obs, options).average).toBe(99);
    expect(windowAverage([...obs].reverse(), options).average).toBe(99);
  });
});

describe("windowAverage: invalid observations", () => {
  it("excludes and counts unparseable or offset-less timestamps", () => {
    const obs: Observation[] = [
      ...hourly(24, () => 10),
      { timestamp: "garbage", value: 1 },
      { timestamp: "2025-01-15T11:00:00", value: 1 },
      { timestamp: "2025-02-30T00:00:00Z", value: 1 },
      { timestamp: Number.NaN, value: 1 },
      { timestamp: new Date("garbage"), value: 1 },
    ];
    const result = windowAverage(obs, opts24);
    expect(result.stats.invalidTimestamps).toBe(5);
    expect(result.average).toBe(10);
  });

  it("excludes and counts negative, NaN, infinite and non-numeric values", () => {
    const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number];
    const obs: Observation[] = [
      ...hourly(20, () => 10),
      ...bad.map((value, i) => ({ timestamp: at(20 + i), value })),
    ];
    const result = windowAverage(obs, opts24);
    expect(result.stats.invalidValues).toBe(4);
    expect(result.stats.validHours).toBe(20);
    expect(result.average).toBe(10);
  });

  it("counts observations stamped after the window end and leaves them out", () => {
    const obs = [...hourly(24, () => 10), { timestamp: new Date(END_MS + HOUR), value: 5000 }];
    const result = windowAverage(obs, opts24);
    expect(result.stats.futureObservations).toBe(1);
    expect(result.average).toBe(10);
  });

  it("accepts zero as a real concentration", () => {
    const result = windowAverage(hourly(24, () => 0), opts24);
    expect(result).toMatchObject({ status: "complete", average: 0 });
  });
});

describe("windowAverage: configuration errors", () => {
  it.each([0, -8, 1.5, Number.NaN])("rejects windowHours %s", (windowHours) => {
    expect(() => windowAverage([], { ...opts24, windowHours })).toThrow(RangeError);
  });

  it.each([0, -1, 25, 2.5])("rejects minValidHours %s for a 24-hour window", (minValidHours) => {
    expect(() => windowAverage([], { ...opts24, minValidHours })).toThrow(RangeError);
  });

  it("rejects an unparseable end time", () => {
    expect(() => windowAverage([], { ...opts24, endTime: "2025-01-15T12:00:00" })).toThrow(RangeError);
  });
});

describe("rollingAverageSeries", () => {
  it("evaluates a window at each requested end time", () => {
    const obs = hourly(30, (k) => 100 - k); // value falls one unit per hour back in time
    const results = rollingAverageSeries(obs, {
      windowHours: 8,
      minValidHours: 6,
      endTimes: [at(0), at(1), at(10)],
    });
    // end = at(0): values 100..93 -> 96.5; end = at(1): 99..92 -> 95.5; end = at(10): 90..83 -> 86.5
    expect(results.map((r) => r.average)).toEqual([96.5, 95.5, 86.5]);
    expect(results.every((r) => r.status === "complete")).toBe(true);
  });

  it("marks windows with too little data as incomplete", () => {
    const results = rollingAverageSeries(hourly(10, () => 1), {
      windowHours: 8,
      minValidHours: 6,
      endTimes: [at(0), at(8)],
    });
    expect(results.map((r) => r.status)).toEqual(["complete", "incomplete"]);
  });

  it("passes the duplicate policy through", () => {
    const obs: Observation[] = [
      { timestamp: new Date(END_MS - 10 * 60_000), value: 99 },
      { timestamp: new Date(END_MS - 50 * 60_000), value: 20 },
    ];
    const [result] = rollingAverageSeries(obs, {
      windowHours: 1,
      minValidHours: 1,
      endTimes: [END],
      duplicatePolicy: "last",
    });
    expect(result?.average).toBe(99);
  });

  it("returns an empty array for no end times", () => {
    expect(rollingAverageSeries([], { windowHours: 8, minValidHours: 6, endTimes: [] })).toEqual([]);
  });
});
