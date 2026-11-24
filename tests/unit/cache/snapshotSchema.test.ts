import { describe, expect, it } from "vitest";

import { SNAPSHOT_FORMAT_VERSION, parseStoredSnapshot } from "@/lib/cache";

import { FETCHED_AT_MS } from "../../fixtures/openMeteo";
import { makeSnapshot } from "../../fixtures/snapshot";

const envelope = (value: unknown, storedAtMs = FETCHED_AT_MS) => JSON.stringify({ v: SNAPSHOT_FORMAT_VERSION, storedAtMs, value });

describe("parseStoredSnapshot", () => {
  it("accepts a real snapshot for every configured city", () => {
    for (const city of ["delhi-ncr", "mumbai", "kolkata", "bengaluru", "lucknow", "patna"] as const) {
      const result = parseStoredSnapshot(envelope(makeSnapshot(city)));
      expect(result.ok, city).toBe(true);
    }
  });

  it("accepts snapshots whose AQI result is not valid (insufficient data) as long as it carries no number", () => {
    const snapshot = makeSnapshot("mumbai", FETCHED_AT_MS, {
      values: Object.fromEntries(
        ["pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone"].map((v) => [v, (o: number) => (o > 0 ? 40 : null)]),
      ),
    });
    expect(snapshot.calculatedAqi?.status).toBe("insufficient_data");
    expect(parseStoredSnapshot(envelope(snapshot)).ok).toBe(true);
  });

  it("returns the validated value and timestamp unchanged", () => {
    const snapshot = makeSnapshot("mumbai");
    const result = parseStoredSnapshot(envelope(snapshot));
    expect(result.ok && result.value).toEqual(snapshot);
    expect(result.ok && result.storedAtMs).toBe(FETCHED_AT_MS);
  });

  it("tolerates unknown extra fields (forward compatibility)", () => {
    const withExtra = { ...makeSnapshot("mumbai"), brandNewField: [1, 2, 3] };
    expect(parseStoredSnapshot(envelope(withExtra)).ok).toBe(true);
  });

  it("distinguishes unparseable text from a parseable but invalid shape", () => {
    expect(parseStoredSnapshot("{oops")).toEqual({ ok: false, reason: "corrupt-json" });
    expect(parseStoredSnapshot(envelope({ nope: true }))).toEqual({ ok: false, reason: "invalid-schema" });
  });

  it("rejects a bad envelope (wrong version, bad timestamp)", () => {
    const value = makeSnapshot("mumbai");
    expect(parseStoredSnapshot(JSON.stringify({ v: 99, storedAtMs: 1, value })).ok).toBe(false);
    expect(parseStoredSnapshot(envelope(value, -1)).ok).toBe(false);
    expect(parseStoredSnapshot(envelope(value, 1.5)).ok).toBe(false);
  });

  it("rejects out-of-range or malformed readings", () => {
    /** Set a nested value in an untyped copy of a real snapshot, then re-validate it. */
    const accepts = (path: (string | number)[], value: unknown): boolean => {
      const copy = JSON.parse(JSON.stringify(makeSnapshot("mumbai"))) as Record<string, unknown>;
      let node: Record<string, unknown> = copy;
      for (const step of path.slice(0, -1)) node = node[step as string] as Record<string, unknown>;
      node[String(path[path.length - 1])] = value;
      return parseStoredSnapshot(envelope(copy)).ok;
    };
    expect(accepts(["calculatedAqi", "subIndices", 0, "index"], 501)).toBe(false);
    expect(accepts(["calculatedAqi", "subIndices", 0, "index"], -1)).toBe(false);
    expect(accepts(["historicalHourlyData", "hours", 0, "time"], "yesterday")).toBe(false);
    expect(accepts(["historicalHourlyData", "hours", 0, "values", "pm25"], "40")).toBe(false);
    expect(accepts(["timezone"], "Europe/Berlin")).toBe(false);
    expect(accepts(["calculatedAqi", "dataSource", "kind"], "official")).toBe(false);
    expect(accepts(["freshnessStatus"], "fresh")).toBe(true); // control: a harmless write still validates
  });

  it("rejects an oversized hourly series", () => {
    const copy = JSON.parse(JSON.stringify(makeSnapshot("mumbai"))) as { historicalHourlyData: { hours: unknown[] } };
    copy.historicalHourlyData.hours = new Array(500).fill(copy.historicalHourlyData.hours[0]);
    expect(parseStoredSnapshot(envelope(copy)).ok).toBe(false);
  });
});
