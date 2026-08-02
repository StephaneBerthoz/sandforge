import type { BaseMessage } from '@sandforge/shared';
import {
  syncConfigSchema,
  syncObjectConfigSchema,
  seedConfigSchema,
  seedObjectConfigSchema,
} from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps } from './handlers/HandlerTypes.js';
import { sendHandlerError } from './handlers/HandlerTypes.js';

/**
 * Generic webview-payload validation (defense-in-depth against a compromised
 * or buggy webview).
 *
 * The MessageBroker validates the message *envelope*; handlers historically
 * cast `msg.payload` with `as` and trusted every field. This module provides
 * a single Zod-based choke point: `validatePayload` returns the parsed,
 * typed payload on success; on failure it posts a handler error
 * (`INVALID_PAYLOAD`) through the existing `sendHandlerError` channel and
 * returns null so the caller can early-return.
 *
 * Payload schemas below mirror what the webview actually sends (verified
 * against `packages/webview/src/pages/*`). Org ids are Salesforce 18-char
 * org IDs (not UUIDs), so the shared `syncConfigSchema` is extended with a
 * permissive org-id field rather than reused blindly. `.passthrough()` keeps
 * extra keys the webview legitimately sends (config `id`, `createdAt`, …).
 */

/** Permissive org-id schema (accepts SF 18-char org IDs as well as UUIDs). */
export const orgIdSchema = z.string().min(1).max(128);

/** Salesforce object/field API name: letter first, then alphanumerics/underscore. */
export const sfApiNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Invalid Salesforce API name')
  .max(80);

/** Strict Salesforce record ID (15 or 18 alphanumerics). */
export const sfIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/, 'Invalid Salesforce record ID');

/** Bounded opaque identifier (operation ids, template ids, alert ids, config ids). */
export const opaqueIdSchema = z.string().min(1).max(200);

/**
 * Free-text SOQL WHERE fragment. Subqueries and DML keywords are rejected at
 * validation time — the same filter is re-applied at query build time in
 * `SyncOpsHandler` (defense-in-depth, both layers stay).
 */
export const whereClauseSchema = z
  .string()
  .max(2000)
  .refine(
    (where) => {
      const upper = where.toUpperCase();
      return !(
        /\bSELECT\b/.test(upper) ||
        /\bINSERT\b/.test(upper) ||
        /\bUPDATE\b/.test(upper) ||
        /\bDELETE\b/.test(upper)
      );
    },
    {
      message:
        'WHERE clause contains forbidden keyword (SELECT/INSERT/UPDATE/DELETE). Subqueries are not allowed.',
    },
  );

/** Max objects accepted per data operation (bounds API-call fan-out per request). */
const MAX_OBJECTS_PER_REQUEST = 100;

/** Max records a single seed object may generate (bounds memory + API usage). */
const MAX_SEED_RECORDS_PER_OBJECT = 1_000_000;

/** Max batch size accepted from the webview (matches manifest caps). */
const MAX_BATCH_SIZE = 10_000;

// ── sync:* payload schemas ────────────────────────────────────────────────

/**
 * Per-object sync config as sent by the webview. `batchSize` is made optional
 * so the handler can fall back to the `sandforge.sync.defaultBatchSize`
 * setting (the shared schema hard-codes 200 otherwise).
 */
export const syncObjectPayloadSchema = syncObjectConfigSchema
  .extend({
    objectApiName: sfApiNameSchema,
    where: whereClauseSchema.optional(),
    batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
  })
  .passthrough();

/** Sync config accepted by `sync:execute` / `sync:config:save`. */
export const syncConfigPayloadSchema = syncConfigSchema
  .extend({
    sourceOrgId: orgIdSchema,
    targetOrgId: orgIdSchema,
    objects: z.array(syncObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
  })
  .passthrough();

export const syncExecutePayloadSchema = z.object({ config: syncConfigPayloadSchema });
export const syncConfigSavePayloadSchema = z.object({ config: syncConfigPayloadSchema });
export const syncConfigIdPayloadSchema = z.object({ id: opaqueIdSchema });
export const syncDescribeGlobalPayloadSchema = z.object({ orgId: orgIdSchema });
export const syncDescribeFieldsPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
});

// ── seed:* payload schemas ────────────────────────────────────────────────

/** Per-object seed config as sent by the webview (see sync note on batchSize). */
export const seedObjectPayloadSchema = seedObjectConfigSchema
  .extend({
    objectApiName: sfApiNameSchema,
    recordCount: z.number().int().positive().max(MAX_SEED_RECORDS_PER_OBJECT),
    batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
  })
  .passthrough();

/** Seed template accepted by `seed:execute`. */
export const seedTemplatePayloadSchema = seedConfigSchema
  .extend({
    objects: z.array(seedObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
  })
  .passthrough();

export const seedExecutePayloadSchema = z.object({
  orgId: orgIdSchema,
  template: seedTemplatePayloadSchema,
  dryRun: z.boolean().optional(),
});
export const seedDescribeGlobalPayloadSchema = z.object({ orgId: orgIdSchema });
export const seedDescribeObjectPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
});
export const seedTemplateIdPayloadSchema = z.object({ id: opaqueIdSchema });
export const seedTemplateSavePayloadSchema = z.object({
  template: z.record(z.unknown()),
});
export const seedCreatePersonaPayloadSchema = z.object({
  // Empty descriptions stay legal here: the handler answers with a graceful
  // `success: false` response (existing webview flow) instead of INVALID_PAYLOAD.
  description: z.string().max(10_000),
});

// ── dataops:* / backup payload schemas ────────────────────────────────────

export const dataOpsBackupPayloadSchema = z.object({
  orgId: orgIdSchema,
  objects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
});
export const dataOpsRollbackPayloadSchema = z.object({
  orgId: orgIdSchema,
  operationId: opaqueIdSchema,
});
export const dataOpsAnonymizePayloadSchema = z.object({
  orgId: orgIdSchema,
  templateId: opaqueIdSchema,
  objects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST).optional(),
});
export const dataOpsMaskingTemplatesPayloadSchema = z.object({
  objectApiName: sfApiNameSchema,
});
export const piiScanPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectNames: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
});

// ── monitor:* payload schemas ─────────────────────────────────────────────

export const monitorOrgPayloadSchema = z.object({ orgId: orgIdSchema });
export const monitorTrendsPayloadSchema = z.object({
  orgId: orgIdSchema,
  period: z.string().max(10).optional(),
});
export const monitorAbortJobPayloadSchema = z.object({
  orgId: orgIdSchema,
  jobId: sfIdSchema,
});
export const monitorAlertIdPayloadSchema = z.object({ alertId: opaqueIdSchema });

// ── compare:* payload schemas ─────────────────────────────────────────────

export const compareOrgsPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
});
export const compareExecutePayloadSchema = compareOrgsPayloadSchema.extend({
  types: z.array(z.string().min(1).max(80)).min(1).max(50),
});

/**
 * Validate a webview message payload against a zod schema. Returns parsed
 * data on success; on failure, posts a handler error and returns null so
 * the caller can early-return. Defense-in-depth against compromised webview.
 *
 * @param schema - Zod schema describing the expected payload.
 * @param msg - The incoming bridge message (envelope already validated).
 * @param responseType - Error message type to post back on failure.
 * @param deps - Handler dependencies (log, broker, nextId).
 */
export function validatePayload<T>(
  schema: z.ZodSchema<T>,
  msg: BaseMessage,
  responseType: string,
  deps: Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>,
): T | null {
  const payload = (msg as { payload?: unknown }).payload;
  const result = schema.safeParse(payload);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    sendHandlerError(
      deps,
      msg.type,
      responseType,
      new Error(`Invalid payload — ${summary}`),
      'INVALID_PAYLOAD',
    );
    return null;
  }
  return result.data;
}
