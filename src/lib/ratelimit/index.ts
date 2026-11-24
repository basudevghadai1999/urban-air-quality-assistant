export {
  canonicalizeIp,
  detectIpTrust,
  identityFromHeaders,
  type ClientIdentity,
  type IpSource,
  type IpTrust,
} from "./clientIp";
export { MemoryRateLimiter } from "./memory";
export type { RateLimitPolicy, RateLimiter, RateLimitResult } from "./types";
// RedisRateLimiter and the gate are server-only: import them from "./redis" and "./gate".
