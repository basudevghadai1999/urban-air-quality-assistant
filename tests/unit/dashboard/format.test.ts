import { describe, expect, it } from "vitest";

import { AQI_CATEGORIES } from "@/lib/aqi";
import { AQI_STYLES, dayLabel, formatAge, formatIst, formatNumber, isCategoryId, slotText } from "@/components/dashboard/format";

describe("dashboard formatting", () => {
  it("formats an instant in IST and rejects garbage", () => {
    expect(formatIst("2026-11-24T08:17:11Z")).toMatch(/^24 Nov, 1:47 pm IST$/i);
    expect(formatIst(null)).toBeNull();
    expect(formatIst("not a date")).toBeNull();
  });

  it("words server-computed ages", () => {
    expect(formatAge(10)).toBe("just now");
    expect(formatAge(600)).toBe("10 minutes ago");
    expect(formatAge(7_200)).toBe("2 hours ago");
    expect(formatAge(3 * 86_400)).toBe("3 days ago");
    expect(formatAge(null)).toBeNull();
    expect(formatAge(-5)).toBeNull();
    expect(formatAge(Number.NaN)).toBeNull();
  });

  it("labels which Asia/Kolkata day a time falls on, whatever the machine's zone", () => {
    const now = "2026-11-24T14:28:16Z"; // 19:58 IST on 24 Nov
    expect(dayLabel("2026-11-24T20:00:00+05:30", now)).toBe("Today");
    expect(dayLabel("2026-11-25T16:00:00+05:30", now)).toBe("Tomorrow");
    expect(dayLabel("2026-11-26T05:00:00+05:30", now)).toBe("26 Nov");
    // 23:30 UTC on 24 Nov is already 05:00 IST on 25 Nov: the IST calendar day decides, not UTC.
    expect(dayLabel("2026-11-24T23:30:00Z", "2026-11-24T14:28:16Z")).toBe("Tomorrow");
    expect(dayLabel("2026-11-24T18:29:00Z", "2026-11-24T14:28:16Z")).toBe("Today");
    expect(dayLabel("garbage", now)).toBeNull();
    expect(dayLabel(now, "garbage")).toBeNull();
  });

  it("writes a slot with its day, IST and a midnight crossing", () => {
    const now = "2026-11-24T14:28:16Z";
    expect(slotText({ start: "2026-11-25T16:00:00+05:30", startLocal: "16:00", endLocal: "16:45" }, now)).toBe("Tomorrow, 16:00 to 16:45 IST");
    expect(slotText({ start: "2026-11-24T23:30:00+05:30", startLocal: "23:30", endLocal: "00:15" }, now)).toBe("Today, 23:30 to 00:15 IST (ends the next day)");
    expect(slotText({ start: "bad", startLocal: "07:00", endLocal: "07:45" }, now)).toBe("07:00 to 07:45 IST");
  });

  it("trims numbers without inventing precision", () => {
    expect(formatNumber(12.34)).toBe("12.3");
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(0.96, 0)).toBe("1");
  });

  it("styles every CPCB category and nothing else", () => {
    expect(Object.keys(AQI_STYLES).sort()).toEqual(AQI_CATEGORIES.map((c) => c.id).sort());
    for (const c of AQI_CATEGORIES) {
      expect(isCategoryId(c.id)).toBe(true);
      expect(AQI_STYLES[c.id].badge).toContain(`aqi-${c.id}-ink`);
    }
    expect(isCategoryId("constructor")).toBe(false);
    expect(isCategoryId(null)).toBe(false);
  });
});
