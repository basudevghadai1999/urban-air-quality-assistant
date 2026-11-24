import { isIP } from "node:net";

/**
 * Client identification for rate limiting.
 *
 * Forwarding headers are written by whoever sends the request, so a header is only trustworthy
 * when the platform in front of the app sets or overwrites it.
 *
 * Render (the deployment target): public traffic reaches a web service through Cloudflare and
 * Render's load balancer. Render's own article on hosting PocketBase
 * (https://render.com/articles/host-pocketbase-on-render) states that Cloudflare writes
 * `CF-Connecting-IP` on requests to public web services and overwrites any value the caller sent,
 * while `X-Forwarded-For` is appended to (a caller controls its leftmost entry). Render's docs do not
 * say whether a service can be reached while skipping that proxy, so trust is an explicit,
 * server-side decision and is never inferred from a request or from a platform variable:
 *
 *   trust "render"  (TRUST_RENDER_CF_CONNECTING_IP=true, set by the operator on the Render service)
 *                   -> read ONLY `cf-connecting-ip`, and only if it holds exactly one valid address
 *   trust "none"    (anything else: local dev, `next start`, any host where the flag is not set)
 *                   -> trust NO header at all, so a spoofed header cannot pick or rotate the
 *                      limiter key. Clients are then indistinguishable and share one bucket.
 *
 * `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and `True-Client-IP` are never trusted. A value that is
 * a list (a repeated header is joined with commas), carries a port, brackets, a zone id or any other
 * decoration, or is not an address, is rejected, and the client falls back to the shared bucket.
 *
 * IPv6 clients are grouped by /64 (the first four 16-bit groups). A single subscriber usually
 * controls a whole /64, so keying by full address would let one machine dodge the limit by
 * rotating addresses.
 */

export type IpTrust = "render" | "none";

export type IpSource = "cf-connecting-ip";

/** The only header that is ever trusted, and only under trust "render". */
const RENDER_CLIENT_IP_HEADER: IpSource = "cf-connecting-ip";

/** Name of the server-side switch that enables trust in Render's Cloudflare-provided header. */
export const TRUST_RENDER_ENV = "TRUST_RENDER_CF_CONNECTING_IP";

export interface ClientIdentity {
  /** Canonical, comparable identifier (`v4:1.2.3.4` or `v6:2001:db8:0:1`), or null if none is trustworthy. */
  readonly identifier: string | null;
  readonly source: IpSource | null;
}

/** Trust Render's header only when the operator explicitly sets the flag to "true". Anything else trusts nothing. */
export function detectIpTrust(env: Readonly<Record<string, string | undefined>>): IpTrust {
  return env[TRUST_RENDER_ENV]?.trim().toLowerCase() === "true" ? "render" : "none";
}

/**
 * Remove brackets, a port and an IPv6 zone id: "[::1]:443", "1.2.3.4:80", "fe80::1%eth0".
 * Anything else attached to the address (trailing text, a second address) makes the whole
 * value unusable: it returns "" and the caller treats the client as unidentified.
 */
function stripDecorations(raw: string): string {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (value.startsWith("[")) {
    if (bracketed?.[1] === undefined) return "";
    value = bracketed[1];
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
    if (withPort?.[1] !== undefined) value = withPort[1];
  }
  const zone = value.indexOf("%");
  return zone === -1 ? value : value.slice(0, zone);
}

/** Expand an IPv6 address into eight 16-bit groups. Input must already pass `isIP(...) === 6`. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    const [a, b, c, d] = octets;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? numbers : null;
}

/** Canonical identifier for one IP address, or null if it is not a valid address. */
export function canonicalizeIp(raw: string): string | null {
  const address = stripDecorations(raw);
  const version = isIP(address);
  if (version === 4) return `v4:${address}`;
  if (version !== 6) return null;

  const groups = expandIpv6(address);
  if (groups === null) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff &&
    g6 !== undefined && g7 !== undefined
  ) {
    // IPv4-mapped (::ffff:a.b.c.d): the same client as its IPv4 address.
    return `v4:${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `v6:${[g0, g1, g2, g3].map((g) => (g ?? 0).toString(16)).join(":")}`;
}

/**
 * The client's identity from request headers, under the given trust mode. Under "render" the
 * value of `cf-connecting-ip` must be exactly one bare IPv4 or IPv6 address: no list, port,
 * brackets, zone id or surrounding text.
 */
export function identityFromHeaders(headers: Headers, trust: IpTrust): ClientIdentity {
  if (trust !== "render") return { identifier: null, source: null };

  const value = headers.get(RENDER_CLIENT_IP_HEADER)?.trim();
  if (value === undefined || value === "" || value.includes("%") || isIP(value) === 0) return { identifier: null, source: null };
  const identifier = canonicalizeIp(value);
  return identifier === null ? { identifier: null, source: null } : { identifier, source: RENDER_CLIENT_IP_HEADER };
}
