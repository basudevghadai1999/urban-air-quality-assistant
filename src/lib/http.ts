/** Small HTTP helpers shared by the outbound clients (Open-Meteo, Upstash). */

export class BodyTooLargeError extends Error {
  constructor() {
    super("response body exceeded the size limit");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a response body as text, refusing anything over `maxBytes`: first by the
 * declared Content-Length, then while streaming, so an oversized body is never
 * buffered in full.
 */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** True for the errors `fetch` raises when an AbortSignal (e.g. AbortSignal.timeout) fires. */
export function isAbortError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}
