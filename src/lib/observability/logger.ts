/**
 * The only logging surface the cache and rate-limit layers use. Fields are
 * restricted to scalars by the type; callers pass identifiers like a city ID or a
 * failure class, never request headers, addresses, tokens or payloads.
 */
export type LogFields = Readonly<Record<string, string | number | undefined>>;

export interface SafeLogger {
  warn(event: string, fields: LogFields): void;
}

export const consoleSafeLogger: SafeLogger = {
  warn(event, fields) {
    console.warn(JSON.stringify({ level: "warn", event, ...fields }));
  },
};

export const silentLogger: SafeLogger = { warn() {} };
