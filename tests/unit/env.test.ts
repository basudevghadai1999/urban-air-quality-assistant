import { describe, expect, it } from "vitest";

import {
  InvalidEnvError,
  MissingGeminiKeyError,
  getGeminiConfig,
  isGeminiConfigured,
  resolveGeminiKey,
} from "@/lib/env";

// Obviously fake values: tests never read the real .env and never print real secrets.
const PRIMARY = "fake-primary-value-for-tests";
const FALLBACK = "fake-fallback-value-for-tests";

describe("resolveGeminiKey", () => {
  it("prefers GEMINI_API_KEY when both variables are set", () => {
    const result = resolveGeminiKey({
      GEMINI_API_KEY: PRIMARY,
      GEMINI_KEY: FALLBACK,
    });
    expect(result).toEqual({ apiKey: PRIMARY, source: "GEMINI_API_KEY" });
  });

  it("falls back to GEMINI_KEY when GEMINI_API_KEY is absent", () => {
    const result = resolveGeminiKey({ GEMINI_KEY: FALLBACK });
    expect(result).toEqual({ apiKey: FALLBACK, source: "GEMINI_KEY" });
  });

  it("treats a blank GEMINI_API_KEY as unset (e.g. copied from .env.example)", () => {
    const result = resolveGeminiKey({
      GEMINI_API_KEY: "",
      GEMINI_KEY: FALLBACK,
    });
    expect(result.source).toBe("GEMINI_KEY");
  });

  it("treats a whitespace-only GEMINI_API_KEY as unset", () => {
    const result = resolveGeminiKey({
      GEMINI_API_KEY: "   \t ",
      GEMINI_KEY: FALLBACK,
    });
    expect(result.source).toBe("GEMINI_KEY");
  });

  it("trims surrounding whitespace from the selected value", () => {
    const result = resolveGeminiKey({ GEMINI_KEY: `  ${FALLBACK}\n` });
    expect(result.apiKey).toBe(FALLBACK);
  });

  it("throws MissingGeminiKeyError when neither variable is set", () => {
    expect(() => resolveGeminiKey({})).toThrow(MissingGeminiKeyError);
  });

  it("throws when both variables are blank", () => {
    expect(() =>
      resolveGeminiKey({ GEMINI_API_KEY: "", GEMINI_KEY: "  " }),
    ).toThrow(MissingGeminiKeyError);
  });

  it("names the variables in the error but never leaks a value", () => {
    let message = "";
    try {
      resolveGeminiKey({ GEMINI_API_KEY: "", GEMINI_KEY: "  " });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain("GEMINI_KEY");
    expect(message).not.toContain(PRIMARY);
    expect(message).not.toContain(FALLBACK);
  });

  it("reads process.env by default without mutating it", () => {
    const before = { ...process.env };
    try {
      resolveGeminiKey();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingGeminiKeyError);
    }
    expect(process.env).toEqual(before);
  });
});

describe("isGeminiConfigured", () => {
  it("is true when either variable holds a value", () => {
    expect(isGeminiConfigured({ GEMINI_API_KEY: PRIMARY })).toBe(true);
    expect(isGeminiConfigured({ GEMINI_KEY: FALLBACK })).toBe(true);
  });

  it("is false when no usable key exists", () => {
    expect(isGeminiConfigured({})).toBe(false);
    expect(isGeminiConfigured({ GEMINI_KEY: " " })).toBe(false);
  });
});

describe("getGeminiConfig", () => {
  it("returns the default model and the key source", () => {
    const config = getGeminiConfig({ GEMINI_KEY: FALLBACK });
    expect(config.model).toBe("gemini-3.5-flash");
    expect(config.keySource).toBe("GEMINI_KEY");
    expect(config.apiKey).toBe(FALLBACK);
  });

  it("honours a valid GEMINI_MODEL override", () => {
    const config = getGeminiConfig({
      GEMINI_API_KEY: PRIMARY,
      GEMINI_MODEL: "gemini-2.5-pro",
    });
    expect(config.model).toBe("gemini-2.5-pro");
    expect(config.keySource).toBe("GEMINI_API_KEY");
  });

  it("falls back to the default model when GEMINI_MODEL is blank", () => {
    const config = getGeminiConfig({ GEMINI_KEY: FALLBACK, GEMINI_MODEL: " " });
    expect(config.model).toBe("gemini-3.5-flash");
  });

  it("rejects a malformed GEMINI_MODEL without echoing it", () => {
    const bad = "bad model; rm -rf /";
    let caught: unknown;
    try {
      getGeminiConfig({ GEMINI_KEY: FALLBACK, GEMINI_MODEL: bad });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidEnvError);
    expect((caught as Error).message).toContain("GEMINI_MODEL");
    expect((caught as Error).message).not.toContain(bad);
  });

  it("throws MissingGeminiKeyError when no key is configured", () => {
    expect(() => getGeminiConfig({})).toThrow(MissingGeminiKeyError);
  });

  it("keeps the key out of JSON, spread and string conversion", () => {
    const config = getGeminiConfig({ GEMINI_API_KEY: PRIMARY });
    expect(JSON.stringify(config)).not.toContain(PRIMARY);
    expect(JSON.stringify({ ...config })).not.toContain(PRIMARY);
    expect(Object.keys(config)).not.toContain("apiKey");
    expect(config.apiKey).toBe(PRIMARY);
  });

  it("is frozen so the key cannot be reassigned", () => {
    const config = getGeminiConfig({ GEMINI_API_KEY: PRIMARY });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { apiKey: string }).apiKey = "other";
    }).toThrow(TypeError);
    expect(config.apiKey).toBe(PRIMARY);
  });
});
