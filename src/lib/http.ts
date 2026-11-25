/** Small HTTP helpers shared by the outbound clients (Open-Meteo, Upstash). */

export class BodyTooLargeError extends Error {
  constructor() {
    super("response body exceeded the size limit");
    this.name = "BodyTooLargeError";
  }
}

/** What `Request` and `Response` share: the part needed to read a capped body. */
export interface BodySource {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * Read a request or response body as text, refusing anything over `maxBytes`: first by the
 * declared Content-Length, then while streaming (the stream is cancelled at the limit), so an
 * oversized body, with or without a length, is never buffered in full.
 */
export async function readTextCapped(response: BodySource, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Refused unread: release the body so the connection is not held by a stream nobody will read.
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
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
