import { describe, expect, it } from "vitest";

import { IST_UTC_OFFSET_SECONDS } from "@/lib/constants";
import { ageSeconds, formatIsoWithOffset, formatUtcOffset, msUntilNextUtcMidnight, secondsUntilUtcReset, utcDayKey } from "@/lib/time";

describe("formatUtcOffset", () => {
  it.each([
    [19_800, "+05:30"],
    [0, "+00:00"],
    [-10_800, "-03:00"],
    [3_600, "+01:00"],
    [-12_600, "-03:30"],
  ])("%i -> %s", (seconds, expected) => {
    expect(formatUtcOffset(seconds)).toBe(expected);
  });
});

describe("formatIsoWithOffset", () => {
  it("renders an instant in IST with an explicit offset", () => {
    // 2026-11-24T07:30:00Z is 13:00 in India.
    expect(formatIsoWithOffset(Date.UTC(2026, 10, 24, 7, 30), IST_UTC_OFFSET_SECONDS)).toBe("2026-11-24T13:00:00+05:30");
  });

  it("rolls the date over across local midnight", () => {
    // 2026-11-24T19:00:00Z is 00:30 on the 25th in India.
    expect(formatIsoWithOffset(Date.UTC(2026, 10, 24, 19, 0), IST_UTC_OFFSET_SECONDS)).toBe("2026-11-25T00:30:00+05:30");
  });

  it("preserves the absolute instant: re-parsing returns the same epoch", () => {
    const epoch = Date.UTC(2026, 0, 1, 18, 29, 59);
    const text = formatIsoWithOffset(epoch, IST_UTC_OFFSET_SECONDS);
    expect(text).toBe("2026-01-01T23:59:59+05:30");
    expect(Date.parse(text)).toBe(epoch);
  });

  it("works for UTC and negative offsets", () => {
    expect(formatIsoWithOffset(Date.UTC(2026, 5, 1, 12, 0), 0)).toBe("2026-06-01T12:00:00+00:00");
    expect(formatIsoWithOffset(Date.UTC(2026, 5, 1, 12, 0), -10_800)).toBe("2026-06-01T09:00:00-03:00");
  });

  it("rejects non-finite input", () => {
    expect(() => formatIsoWithOffset(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("Asia/Kolkata offset constant", () => {
  it("matches the runtime's own time-zone database, on both sides of the year", () => {
    // India has no DST, so the offset must be +05:30 all year. Verified against Intl, not assumed.
    for (const month of [0, 3, 6, 9, 11]) {
      const instant = new Date(Date.UTC(2026, month, 15, 12, 0, 0));
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(instant);
      const hour = Number(parts.find((p) => p.type === "hour")?.value);
      const minute = Number(parts.find((p) => p.type === "minute")?.value);
      // 12:00 UTC is 17:30 in India (12 * 60 + 330 minutes).
      expect(hour * 60 + minute).toBe((12 * 60 + IST_UTC_OFFSET_SECONDS / 60) % (24 * 60));
    }
  });
});

describe("ageSeconds", () => {
  it("counts whole seconds", () => {
    expect(ageSeconds(1_000, 4_999)).toBe(3);
  });

  it("is never negative", () => {
    expect(ageSeconds(5_000, 1_000)).toBe(0);
  });
});

describe("UTC day helpers", () => {
  const T0 = Date.UTC(2026, 10, 24, 10, 30, 0); // 2026-11-24 10:30 UTC

  it("keys by the UTC date, not the local one", () => {
    expect(utcDayKey(T0)).toBe("20261124");
    expect(utcDayKey(Date.UTC(2026, 10, 24, 23, 59, 59, 999))).toBe("20261124");
    expect(utcDayKey(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe("20261125");
    expect(utcDayKey(Date.UTC(2026, 11, 31, 23, 0, 0))).toBe("20261231");
    expect(utcDayKey(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe("20270101");
  });

  it("computes the time to the next 00:00 UTC", () => {
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe(86_400_000);
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 10, 24, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextUtcMidnight(T0)).toBe(13.5 * 3_600_000);
  });

  it("reports whole seconds until reset, at least one", () => {
    expect(secondsUntilUtcReset(T0)).toBe(13.5 * 3600);
    expect(secondsUntilUtcReset(Date.UTC(2026, 10, 24, 23, 59, 59, 999))).toBe(1);
    expect(secondsUntilUtcReset(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe(86_400);
  });
});
