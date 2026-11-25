import { describe, expect, it, vi } from "vitest";

import { BodyTooLargeError, readTextCapped } from "@/lib/http";

describe("readTextCapped releases a body it refuses", () => {
  it("cancels the stream when the declared length is over the limit, without reading it", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel });
    const source = { headers: new Headers({ "content-length": "101" }), body };
    await expect(readTextCapped(source, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls.length).toBeLessThanOrEqual(1); // only the platform's own prefill, nothing consumed
  });

  it("cancels the stream when a body with no declared length passes the limit", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(60)), cancel });
    await expect(readTextCapped({ headers: new Headers(), body }, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("still reads a body at the limit, and treats a missing body as empty", async () => {
    const body = new Response("x".repeat(100)).body;
    expect((await readTextCapped({ headers: new Headers({ "content-length": "100" }), body }, 100)).length).toBe(100);
    expect(await readTextCapped({ headers: new Headers(), body: null }, 100)).toBe("");
  });
});
