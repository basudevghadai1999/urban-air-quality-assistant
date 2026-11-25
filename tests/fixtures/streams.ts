/** Requests whose bodies arrive as a stream with no Content-Length, like a chunked upload. */

const encoder = new TextEncoder();
/** Lets the stream finish its initial read-ahead, so `pulls()` taken afterwards is a stable baseline. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
export const bytes = (text: string): Uint8Array => encoder.encode(text);

export interface StreamedPost {
  readonly request: Request;
  /** How many chunks the consumer asked the source for. */
  readonly pulls: () => number;
  /** True once the consumer cancelled the stream. */
  readonly cancelled: () => boolean;
}

/**
 * `chunk(i)` returns the i-th chunk, or `null` to end the body; it may throw to error the stream.
 * It is called only when the consumer pulls, so `pulls()` shows how much of the body was read.
 */
export function streamedPost(
  chunk: (index: number) => Uint8Array | null,
  headers: Record<string, string> = { "content-type": "application/json" },
  url = "http://localhost:3000/api/test",
): StreamedPost {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunk(pulls);
      pulls += 1;
      if (next === null) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  // `duplex` is required by fetch for a streamed body; the DOM typings omit it.
  const request = new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  return { request, pulls: () => pulls, cancelled: () => cancelled };
}

/** A body of `chunks` chunks of `size` bytes each (then the end), as ASCII `x`. */
export const fixedChunks = (chunks: number, size: number) => (i: number): Uint8Array | null => (i < chunks ? new Uint8Array(size).fill(120) : null);
