import { z } from "zod";
import { normalizeWritePrefix } from "@server/lib/storage/write-prefix";

/**
 * Payload validation for source create/update (control plane).
 * Storage-layer conventions: booleans here are real booleans and are
 * converted to 0/1 integers at the data layer.
 */

export const sourceAdapterSchema = z.enum(["apt", "conda", "pypi", "static"]);
export const sourceModeSchema = z.enum(["lazy", "pinned", "external-pinned"]);
export const sourceAccessLevelSchema = z.enum(["public", "token"]);
export const sourceStatusSchema = z.enum(["active", "disabled"]);

const writePrefixSchema = z
  .string()
  .max(1024)
  .refine((prefix) => normalizeWritePrefix(prefix) !== null, {
    message: "write_prefix must be empty or a valid relative key prefix",
  });

const sourceBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  adapter: sourceAdapterSchema,
  mode: sourceModeSchema,
  base_url: z.url().nullish(),
  allow_insecure_http: z.boolean(),
  write_prefix: writePrefixSchema,
  access_level: sourceAccessLevelSchema,
  noindex: z.boolean(),
  daily_bytes_cap: z.number().int().positive().nullish(),
});

export const sourceCreateSchema = sourceBaseSchema
  .extend({
    allow_insecure_http: z.boolean().default(false),
    write_prefix: writePrefixSchema.default(""),
    access_level: sourceAccessLevelSchema.default("public"),
    noindex: z.boolean().default(true),
  })
  .superRefine((source, ctx) => {
    if (source.mode !== "external-pinned" && !source.base_url) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "base_url is required unless mode is external-pinned",
      });
    }
    if (
      source.base_url &&
      !source.allow_insecure_http &&
      !source.base_url.startsWith("https://")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "base_url must use https unless allow_insecure_http is set",
      });
    }
  });

/** Partial updates validate field shapes only; cross-field rules run on create. */
export const sourceUpdateSchema = sourceBaseSchema
  .partial()
  .extend({ status: sourceStatusSchema.optional() });

export type SourceCreateInput = z.input<typeof sourceCreateSchema>;
export type SourceCreate = z.output<typeof sourceCreateSchema>;
export type SourceUpdate = z.output<typeof sourceUpdateSchema>;
