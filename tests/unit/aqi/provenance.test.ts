import { describe, expect, it } from "vitest";

import {
  CPCB_METHODOLOGY,
  NOT_OFFICIAL_DISCLAIMER,
  OPEN_METEO_MODEL_SOURCE,
  UNSPECIFIED_SOURCE,
  buildProvenanceLabel,
  type DataSource,
} from "@/lib/aqi";

describe("buildProvenanceLabel", () => {
  it("produces the exact required label for Open-Meteo model data", () => {
    expect(buildProvenanceLabel(OPEN_METEO_MODEL_SOURCE)).toBe(
      "Estimated Indian AQI — calculated using CPCB methodology and Open-Meteo model data.",
    );
  });

  it("always prefixes model estimates with 'Estimated'", () => {
    const model: DataSource = { kind: "model-estimate", name: "some other model" };
    expect(buildProvenanceLabel(model)).toMatch(/^Estimated Indian AQI/);
  });

  it("does not call station data 'estimated', but never calls anything official", () => {
    const station: DataSource = { kind: "station-observation", name: "station observations" };
    const label = buildProvenanceLabel(station);
    expect(label).not.toMatch(/^Estimated/);
    expect(label).not.toMatch(/official/i);
  });

  it("says so when the source is unspecified", () => {
    expect(buildProvenanceLabel(UNSPECIFIED_SOURCE)).toMatch(/data source not specified/);
  });

  it("never claims official, government or real-time CPCB status", () => {
    for (const source of [OPEN_METEO_MODEL_SOURCE, UNSPECIFIED_SOURCE]) {
      expect(buildProvenanceLabel(source)).not.toMatch(/official|government|real-time/i);
    }
  });
});

describe("disclaimer and methodology", () => {
  it("states the value is not an official CPCB reading", () => {
    expect(NOT_OFFICIAL_DISCLAIMER).toMatch(/not an official CPCB station AQI/);
  });

  it("describes the method independently of any data source", () => {
    const text = JSON.stringify(CPCB_METHODOLOGY);
    expect(text).not.toMatch(/open-meteo/i);
    expect(CPCB_METHODOLOGY.minimumPollutants).toBe(3);
    expect(CPCB_METHODOLOGY.requiresParticulateMatter).toBe(true);
    expect(CPCB_METHODOLOGY.minimumValidHoursFor24HourAverage).toBe(16);
  });

  it("cites the three CPCB documents", () => {
    expect(CPCB_METHODOLOGY.references).toHaveLength(3);
    for (const url of CPCB_METHODOLOGY.references) {
      expect(url).toMatch(/^https:\/\/airquality\.cpcb\.gov\.in\/ccr_docs\//);
    }
  });

  it("lists the engine assumptions that CPCB's documents do not settle", () => {
    expect(CPCB_METHODOLOGY.engineAssumptions.length).toBeGreaterThanOrEqual(5);
  });

  it("identifies Open-Meteo as a model-estimate source", () => {
    expect(OPEN_METEO_MODEL_SOURCE.kind).toBe("model-estimate");
  });
});
