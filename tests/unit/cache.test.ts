import { describe, expect, it } from "vitest";

import { MemoryCache } from "@/lib/cache";

describe("MemoryCache", () => {
  it("returns null on a miss", async () => {
    expect(await new MemoryCache<string>().get("nothing")).toBeNull();
  });

  it("returns exactly what was stored, including the original timestamp", async () => {
    const cache = new MemoryCache<{ n: number }>();
    const entry = { value: { n: 1 }, storedAtMs: 1_700_000_000_000 };
    await cache.set("a", entry);
    const got = await cache.get("a");
    expect(got).toEqual(entry);
    expect(got?.storedAtMs).toBe(1_700_000_000_000);
  });

  it("never rewrites the timestamp on read, however many times it is read", async () => {
    const cache = new MemoryCache<string>();
    await cache.set("k", { value: "v", storedAtMs: 123 });
    for (let i = 0; i < 5; i += 1) await cache.get("k");
    expect((await cache.get("k"))?.storedAtMs).toBe(123);
  });

  it("keeps independent entries per key (per-city isolation)", async () => {
    const cache = new MemoryCache<string>();
    await cache.set("mumbai", { value: "M", storedAtMs: 1 });
    await cache.set("patna", { value: "P", storedAtMs: 2 });
    expect((await cache.get("mumbai"))?.value).toBe("M");
    expect((await cache.get("patna"))?.value).toBe("P");
    await cache.delete("mumbai");
    expect(await cache.get("mumbai")).toBeNull();
    expect((await cache.get("patna"))?.value).toBe("P");
  });

  it("overwrites an existing key", async () => {
    const cache = new MemoryCache<string>();
    await cache.set("k", { value: "old", storedAtMs: 1 });
    await cache.set("k", { value: "new", storedAtMs: 2 });
    expect(await cache.get("k")).toEqual({ value: "new", storedAtMs: 2 });
    expect(cache.size).toBe(1);
  });

  it("evicts the oldest-written entry beyond maxEntries", async () => {
    const cache = new MemoryCache<number>(2);
    await cache.set("a", { value: 1, storedAtMs: 1 });
    await cache.set("b", { value: 2, storedAtMs: 2 });
    await cache.set("c", { value: 3, storedAtMs: 3 });
    expect(cache.size).toBe(2);
    expect(await cache.get("a")).toBeNull();
    expect((await cache.get("c"))?.value).toBe(3);
  });

  it("treats a rewrite as most recent for eviction", async () => {
    const cache = new MemoryCache<number>(2);
    await cache.set("a", { value: 1, storedAtMs: 1 });
    await cache.set("b", { value: 2, storedAtMs: 2 });
    await cache.set("a", { value: 10, storedAtMs: 3 }); // a is now newest
    await cache.set("c", { value: 3, storedAtMs: 4 }); // evicts b
    expect(await cache.get("b")).toBeNull();
    expect((await cache.get("a"))?.value).toBe(10);
  });

  it("deleting a missing key is harmless", async () => {
    await expect(new MemoryCache<string>().delete("nope")).resolves.toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects maxEntries %s", (max) => {
    expect(() => new MemoryCache(max)).toThrow(RangeError);
  });
});
