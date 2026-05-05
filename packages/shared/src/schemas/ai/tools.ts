import { z } from 'zod';

// ── Universal tool error envelope ────────────────────────────────────────────

export const ToolErrorSchema = z
  .object({
    code: z.string().min(1).max(60),
    message: z.string().min(1).max(2000),
    hint: z.string().max(500).optional(),
  })
  .strict();
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * Discriminated union: every read-only tool returns either
 * `{ ok: true, data }` (validated against the tool's output schema)
 * OR `{ ok: false, error: ToolError }`.
 *
 * RESEARCH Pitfall #8: betaZodTool validates INPUT only — wrapTool layers
 * this contract on the OUTPUT side so tool errors reach Claude as structured
 * payloads, not raw error strings.
 */
export function toolResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: ToolErrorSchema }).strict(),
  ]);
}

// ── 1. describe_object ──────────────────────────────────────────────────────

export const describeObjectInput = z
  .object({
    sObject: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  })
  .strict();
export const describeObjectOutput = z
  .object({
    name: z.string(),
    label: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.string(),
        required: z.boolean(),
        custom: z.boolean(),
        length: z.number().optional(),
      }),
    ),
    recordTypeIds: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

// ── 2. query_records ────────────────────────────────────────────────────────

export const queryRecordsInput = z
  .object({
    soql: z.string().min(1).max(20_000),
    limit: z.number().int().positive().max(200).default(50),
  })
  .strict();
export const queryRecordsOutput = z
  .object({
    totalSize: z.number().int().nonnegative(),
    records: z.array(z.record(z.string(), z.unknown())),
    done: z.boolean(),
  })
  .strict();

// ── 3. get_limits ───────────────────────────────────────────────────────────

export const getLimitsInput = z.object({}).strict();
export const getLimitsOutput = z
  .object({
    limits: z.array(
      z.object({
        name: z.string(),
        max: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        percentUsed: z.number().min(0).max(100),
      }),
    ),
  })
  .strict();

// ── 4. get_recent_errors ────────────────────────────────────────────────────

export const getRecentErrorsInput = z
  .object({
    lookbackHours: z.number().int().positive().max(168).default(24),
    maxResults: z.number().int().positive().max(50).default(20),
  })
  .strict();
export const getRecentErrorsOutput = z
  .object({
    errors: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        message: z.string().max(2000),
        occurredAt: z.string(),
        severity: z.string(),
      }),
    ),
  })
  .strict();

// ── 5. get_apex_log ─────────────────────────────────────────────────────────

export const getApexLogInput = z.object({ logId: z.string().min(1) }).strict();
export const getApexLogOutput = z
  .object({
    logId: z.string(),
    body: z.string().max(50_000),
    truncated: z.boolean(),
  })
  .strict();

// ── 6. get_metadata ─────────────────────────────────────────────────────────

export const getMetadataInput = z
  .object({
    metadataType: z.enum([
      'ApexClass',
      'ApexTrigger',
      'Flow',
      'ValidationRule',
      'PermissionSet',
      'Profile',
    ]),
    fullName: z.string().min(1),
  })
  .strict();
export const getMetadataOutput = z
  .object({
    metadataType: z.string(),
    fullName: z.string(),
    body: z.string().max(80_000),
    truncated: z.boolean(),
  })
  .strict();

// ── 7. get_alerts ───────────────────────────────────────────────────────────

export const getAlertsInput = z.object({ orgId: z.string().min(1) }).strict();
export const getAlertsOutput = z
  .object({
    alerts: z.array(
      z.object({
        id: z.string(),
        ruleId: z.string(),
        severity: z.string(),
        message: z.string().max(2000),
        openedAt: z.string(),
      }),
    ),
  })
  .strict();

// ── 8. get_anomalies ────────────────────────────────────────────────────────

export const getAnomaliesInput = z
  .object({
    orgId: z.string().min(1),
    lookbackMinutes: z.number().int().positive().max(10080).default(1440),
  })
  .strict();
export const getAnomaliesOutput = z
  .object({
    anomalies: z.array(
      z.object({
        ts: z.number(),
        seriesId: z.string(),
        value: z.number(),
        mean: z.number(),
        stdDev: z.number(),
        zScore: z.number(),
      }),
    ),
  })
  .strict();

// ── 9. list_sobjects ────────────────────────────────────────────────────────

export const listSObjectsInput = z
  .object({
    filter: z.enum(['custom', 'standard', 'all']).default('all'),
  })
  .strict();
export const listSObjectsOutput = z
  .object({
    sObjects: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        custom: z.boolean(),
        queryable: z.boolean(),
      }),
    ),
  })
  .strict();

// ── 10. validate_soql ───────────────────────────────────────────────────────

export const validateSoqlInput = z
  .object({ soql: z.string().min(1).max(20_000) })
  .strict();
export const validateSoqlOutput = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    detectedAntipatterns: z.array(z.string()),
  })
  .strict();
