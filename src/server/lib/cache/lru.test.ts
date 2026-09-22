import { describe, expect, it } from "vitest";
import { LruCache } from "@server/lib/cache/lru";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after the TTL", () => {
    let now = 1000;
    const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: () => now });
    cache.set("a", 1);
    now = 1099;
    expect(cache.get("a")).toBe(1);
    now = 1100;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry past maxEntries", () => {
    const cache = new LruCache<string, number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a becomes most-recently-used
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("overwrites existing keys without growing", () => {
    const cache = new LruCache<string, number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });
});
