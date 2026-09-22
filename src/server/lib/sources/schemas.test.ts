import { describe, it, expect } from "vitest";
import {
  sourceCreateSchema,
  sourceUpdateSchema,
} from "@server/lib/sources/schemas";

const validLazy = {
  name: "conda-forge",
  adapter: "conda",
  mode: "lazy",
  base_url: "https://conda.anaconda.org/conda-forge",
};

describe("sourceCreateSchema", () => {
  it("accepts a minimal lazy source and applies defaults", () => {
    const source = sourceCreateSchema.parse(validLazy);
    expect(source).toMatchObject({
      name: "conda-forge",
      adapter: "conda",
      mode: "lazy",
      allow_insecure_http: false,
      write_prefix: "",
      access_level: "public",
      noindex: true,
    });
  });

  it("requires base_url for lazy and pinned modes", () => {
    const noBaseUrl = { name: "conda-forge", adapter: "conda" };
    expect(
      sourceCreateSchema.safeParse({ ...noBaseUrl, mode: "lazy" }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...noBaseUrl, mode: "pinned" }).success,
    ).toBe(false);
  });

  it("allows external-pinned sources without a base_url", () => {
    const result = sourceCreateSchema.safeParse({
      name: "robot-apt",
      adapter: "apt",
      mode: "external-pinned",
      write_prefix: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects http base_url unless allow_insecure_http is set", () => {
    expect(
      sourceCreateSchema.safeParse({
        ...validLazy,
        base_url: "http://snapshots.ros.org/noetic",
      }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({
        ...validLazy,
        base_url: "http://snapshots.ros.org/noetic",
        allow_insecure_http: true,
      }).success,
    ).toBe(true);
  });

  it("rejects invalid enum values and urls", () => {
    expect(sourceCreateSchema.safeParse({ ...validLazy, adapter: "npm" }).success).toBe(false);
    expect(sourceCreateSchema.safeParse({ ...validLazy, mode: "eager" }).success).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, access_level: "secret" }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, base_url: "not a url" }).success,
    ).toBe(false);
  });

  it("rejects invalid write prefixes and caps", () => {
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, write_prefix: "../x" }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, daily_bytes_cap: -1 }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, daily_bytes_cap: 1.5 }).success,
    ).toBe(false);
    expect(
      sourceCreateSchema.safeParse({ ...validLazy, daily_bytes_cap: 1_000_000 }).success,
    ).toBe(true);
  });

  it("rejects empty names", () => {
    expect(sourceCreateSchema.safeParse({ ...validLazy, name: "  " }).success).toBe(false);
  });
});

describe("sourceUpdateSchema", () => {
  it("accepts partial updates without cross-field requirements", () => {
    const update = sourceUpdateSchema.parse({ name: "new name" });
    expect(update).toEqual({ name: "new name" });
  });

  it("accepts a status transition", () => {
    expect(sourceUpdateSchema.parse({ status: "disabled" })).toEqual({
      status: "disabled",
    });
    expect(sourceUpdateSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });

  it("still validates field shapes", () => {
    expect(sourceUpdateSchema.safeParse({ adapter: "npm" }).success).toBe(false);
    expect(sourceUpdateSchema.safeParse({ write_prefix: "a/../b" }).success).toBe(false);
  });
});
