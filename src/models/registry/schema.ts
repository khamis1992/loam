/**
 * Zod schemas for the unified model registry.
 * 
 * Validates registry JSON on load and API request bodies. Prevents:
 * - Duplicate provider/model IDs
 * - Models referencing nonexistent providers
 * - Chains referencing nonexistent models
 * - Secret headers in extraHeaders
 * - Invalid URLs (ftp://, trailing slashes, etc.)
 * - Non-ASCII or malformed header values
 */

import { z } from "zod";

/**
 * Slug pattern: lowercase alphanumeric + hyphens, 2-40 chars.
 * Must start with alphanumeric (not hyphen).
 */
const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "ID must be lowercase alphanumeric with hyphens, 2-40 characters");

/**
 * HTTP/HTTPS URL with trailing slash normalization.
 * Rejects ftp://, file://, etc.
 */
const httpUrl = z
  .string()
  .url("Must be a valid URL")
  .refine((u) => {
    try {
      const proto = new URL(u).protocol;
      return proto === "http:" || proto === "https:";
    } catch {
      return false;
    }
  }, "Only http:// and https:// URLs are allowed")
  .transform((u) => u.replace(/\/+$/, "")); // Strip trailing slashes

/**
 * HTTP header name: alphanumeric + hyphens, 1-64 chars.
 * Standard HTTP header name pattern.
 */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Headers that MUST go through auth, not extraHeaders.
 * These carry secrets and belong in the vault, not the JSON file.
 */
const SECRET_HEADER = /^(authorization|x-api-key|x-goog-api-key|cookie|proxy-authorization)$/i;

/**
 * Authentication scheme discriminated union.
 */
export const AuthSchemeZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    credentialId: z.string().uuid("credentialId must be a valid UUID"),
  }),
  z.object({
    type: z.literal("header"),
    credentialId: z.string().uuid("credentialId must be a valid UUID"),
    header: z
      .string()
      .regex(HEADER_NAME, "Header name must be alphanumeric with hyphens, 1-64 characters"),
  }),
  z.object({
    type: z.literal("env"),
    envVar: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "Environment variable must be uppercase with underscores, 1-64 characters"),
  }),
]);

/**
 * Connection test result.
 */
const TestResultZ = z.object({
  at: z.string(), // ISO timestamp (not validated as date to allow flexibility)
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  modelTested: z.string().optional(),
  modelsFound: z.number().int().nonnegative().optional(),
  toolCalls: z.boolean().optional(),
  error: z
    .object({
      code: z.enum([
        "unreachable",
        "timeout",
        "auth",
        "billing",
        "rate_limited",
        "not_found",
        "bad_request",
        "bad_response",
        "model_not_found",
        "unknown",
      ]),
      message: z.string().max(500),
      status: z.number().int().optional(),
    })
    .optional(),
});

/**
 * Provider record schema.
 */
export const ProviderZ = z.object({
  id: slug,
  label: z.string().min(1, "Label cannot be empty").max(60, "Label too long (max 60 characters)"),
  kind: z.enum(["ollama", "openai-compatible", "anthropic", "google-gemini"]),
  presetId: z.string().optional(),
  baseUrl: httpUrl,
  location: z.enum(["local", "cloud"]),
  auth: AuthSchemeZ,
  extraHeaders: z
    .record(
      z
        .string()
        .regex(HEADER_NAME, "Header name must be alphanumeric with hyphens")
        .refine((h) => !SECRET_HEADER.test(h), "Secret headers (authorization, x-api-key, etc.) belong in auth, not extraHeaders"),
      z
        .string()
        .max(512, "Header value too long (max 512 characters)")
        .regex(/^[\x20-\x7E]*$/, "Header value must contain only printable ASCII characters")
    )
    .default({}),
  timeoutMs: z
    .number()
    .int()
    .min(5_000, "Timeout must be at least 5 seconds")
    .max(1_800_000, "Timeout cannot exceed 30 minutes"),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastTest: TestResultZ.optional(),
});

/**
 * Tri-state boolean: true, false, or "unknown".
 */
const tri = z.union([z.boolean(), z.literal("unknown")]);

/**
 * Model capabilities schema.
 */
export const CapabilitiesZ = z.object({
  tools: tri,
  vision: tri,
  jsonMode: tri,
  thinking: z.enum(["none", "toggle", "always", "unknown"]),
  contextWindow: z.number().int().positive().max(10_000_000, "Context window too large").nullable(),
  maxOutputTokens: z.number().int().positive().max(1_000_000, "Max output tokens too large").nullable(),
  source: z.enum(["user", "probe", "provider-list", "preset", "default"]),
});

/**
 * Model record schema.
 */
export const ModelZ = z.object({
  id: z.string().min(3, "Model ID too short").max(200, "Model ID too long"),
  providerId: slug,
  remoteId: z.string().min(1, "Remote ID cannot be empty").max(160, "Remote ID too long"),
  label: z.string().min(1, "Label cannot be empty").max(80, "Label too long"),
  capabilities: CapabilitiesZ,
  defaults: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      think: z.boolean().optional(),
      numCtx: z.number().int().positive().optional(),
    })
    .default({}),
  limits: z
    .object({
      rpm: z.number().int().positive().optional(),
      rpd: z.number().int().positive().optional(),
      tpm: z.number().int().positive().optional(),
      tpd: z.number().int().positive().optional(),
    })
    .optional(),
  enabled: z.boolean(),
  tags: z.array(z.string().max(24, "Tag too long (max 24 characters)")).max(10, "Too many tags (max 10)").default([]),
});

/**
 * Model chain schema.
 */
const ChainZ = z.object({
  id: z.string().min(1, "Chain ID cannot be empty").max(40, "Chain ID too long"),
  label: z.string().max(60, "Chain label too long"),
  modelIds: z.array(z.string()).max(50, "Too many models in chain (max 50)"),
});

/**
 * Complete registry schema with referential integrity checks.
 */
export const RegistryZ = z
  .object({
    version: z.literal(1),
    providers: z.array(ProviderZ).max(100, "Too many providers (max 100)"),
    models: z.array(ModelZ).max(2000, "Too many models (max 2000)"),
    chains: z.array(ChainZ),
    defaultModelId: z.string().nullable(),
    fallbackModelId: z.string().nullable(),
    migratedFrom: z
      .object({
        at: z.string(),
        sourceHash: z.string(),
      })
      .optional(),
  })
  .superRefine((r, ctx) => {
    // Build sets of valid IDs for referential integrity checks
    const pids = new Set<string>();
    const mids = new Set<string>();

    // Check provider uniqueness
    for (const p of r.providers) {
      if (pids.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate provider ID: ${p.id}`,
          path: ["providers"],
        });
      }
      pids.add(p.id);
    }

    // Check model uniqueness and provider references
    for (const m of r.models) {
      if (!pids.has(m.providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Model ${m.id} references unknown provider: ${m.providerId}`,
          path: ["models"],
        });
      }
      if (m.id !== `${m.providerId}/${m.remoteId}`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Model ID must be "{providerId}/{remoteId}", got: ${m.id}`,
          path: ["models"],
        });
      }
      if (mids.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate model ID: ${m.id}`,
          path: ["models"],
        });
      }
      mids.add(m.id);
    }

    // Check chain model references
    for (const c of r.chains) {
      for (const mid of c.modelIds) {
        if (!mids.has(mid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Chain ${c.id} references unknown model: ${mid}`,
            path: ["chains"],
          });
        }
      }
    }

    // Check default/fallback model references
    if (r.defaultModelId && !mids.has(r.defaultModelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Default model references unknown model: ${r.defaultModelId}`,
        path: ["defaultModelId"],
      });
    }
    if (r.fallbackModelId && !mids.has(r.fallbackModelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Fallback model references unknown model: ${r.fallbackModelId}`,
        path: ["fallbackModelId"],
      });
    }
  });

/**
 * Discovered model schema (from provider /models endpoint).
 */
export const DiscoveredModelZ = z.object({
  remoteId: z.string().min(1),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  vision: z.boolean().optional(),
  tools: z.boolean().optional(),
  kind: z.enum(["chat", "embedding", "image", "audio", "other"]).optional(),
});

/**
 * Type inference from schemas (for use in code).
 */
export type AuthScheme = z.infer<typeof AuthSchemeZ>;
export type Provider = z.infer<typeof ProviderZ>;
export type Capabilities = z.infer<typeof CapabilitiesZ>;
export type Model = z.infer<typeof ModelZ>;
export type Chain = z.infer<typeof ChainZ>;
export type Registry = z.infer<typeof RegistryZ>;
export type DiscoveredModel = z.infer<typeof DiscoveredModelZ>;
export type TestResult = z.infer<typeof TestResultZ>;
