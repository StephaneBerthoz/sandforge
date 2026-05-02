import { z } from 'zod';

// ─── Enum Schemas ────────────────────────────────────────────────────────────

/** Zod schema for ForgeInputMode enum */
export const forgeInputModeSchema = z.enum(['record', 'soql', 'template', 'ai']);

/** Zod schema for ForgeDepth enum */
export const forgeDepthSchema = z.enum(['direct', 'full', 'custom']);

/** Zod schema for ForgeNodeStatus enum */
export const forgeNodeStatusSchema = z.enum(['idle', 'scanning', 'running', 'done', 'error', 'skipped']);

/** Zod schema for ForgeGraphEdge relationship type */
export const forgeEdgeTypeSchema = z.enum(['master-detail', 'lookup']);

/** Zod schema for ForgeExecutionResult status */
export const forgeExecutionStatusSchema = z.enum(['success', 'partial', 'failure']);

/** Zod schema for ForgeBatchStrategy */
export const forgeBatchStrategySchema = z.enum(['rest', 'bulk', 'auto']);

/** Zod schema for ForgeAnonymizationCategory */
export const forgeAnonymizationCategorySchema = z.enum(['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other']);

/** Zod schema for ForgeCycleStrategy */
export const forgeCycleStrategySchema = z.enum(['two_pass', 'upsert_external_id', 'nullable_lookup']);

// ─── Config Schema ──────────────────────────────────────────────────────────

/** Strict Salesforce record/object ID — 15 or 18 alphanum chars. */
const SF_RECORD_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;
/**
 * Salesforce SObject API name — letter-prefixed, alphanumeric + underscore,
 * length ≤ 80 (Salesforce hard cap is 40 for standard / 254 with namespace,
 * 80 is a safe practical ceiling). Anchored to block injection via the
 * graph payload (defense-in-depth — assertSoqlIdentifier still runs).
 */
const SF_OBJECT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * Base ForgeConfig schema (no cross-field refine). Kept as a plain ZodObject
 * so consumers like `forgeTemplateSchema` can still call `.omit()` on it.
 * For handler validation that requires the `inputMode → matching field`
 * contract, prefer `forgeConfigSchemaStrict` below (CR-017).
 */
export const forgeConfigSchema = z.object({
  inputMode: forgeInputModeSchema,
  recordId: z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID').optional(),
  soqlQuery: z.string().min(1).max(20_000).optional(),
  templateId: z.string().min(1).max(200).optional(),
  aiPrompt: z.string().min(1).max(4_000).optional(),
  depth: forgeDepthSchema,
  customDepth: z.number().int().positive().max(10).optional(),
  sourceOrgId: z.string().min(1).max(128),
  targetOrgId: z.string().min(1).max(128),
  anonymizePII: z.boolean(),
  skipEmpty: z.boolean(),
  batchSize: z.union([z.literal('auto'), z.number().int().positive().max(10_000)]),
  expandOrphanParents: z.boolean().optional(),
  maxRecordsPerObject: z.number().int().positive().max(1_000_000).optional(),
  // Per-object field exclusions. Outer key = SObject API name (regex'd),
  // inner array = field API names to skip (each ≤ 80 chars, ≤ 200 per
  // object). Defense-in-depth: bounded to keep payloads sane.
  fieldExclusions: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).max(80)).max(200),
    )
    .optional(),
  // Source-org → target-org User Id remap for OwnerId. Both sides are
  // Salesforce IDs; arbitrary keys would let a webview-compromised
  // payload swap arbitrary FK values, hence the strict ID regex on
  // both ends. Bounded to 200 entries (very large by realistic use).
  ownerMappings: z
    .record(
      z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID'),
      z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID'),
    )
    .refine((m) => Object.keys(m).length <= 200, {
      message: 'Too many owner mappings (max 200)',
    })
    .optional(),
  // Per-object SOQL WHERE filter. Outer key = SObject API name (regex'd),
  // value = arbitrary SOQL fragment (length-bounded to 512 chars). Two
  // defenses: object-name regex blocks injection via the key, length cap
  // blocks DoS via huge filters. Newlines and the SOQL comment markers
  // (-- and /* */) are rejected so the filter can't append a second
  // statement. Trust boundary at the schema — the filter itself is
  // intentionally arbitrary (BA writes their own WHERE clause).
  objectSoqlFilters: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      z
        .string()
        .min(1)
        .max(512)
        .refine((s) => !/--|\/\*|\*\/|;\s*$/.test(s), {
          message: 'SOQL filter must not contain comment markers (--, /*, */) or trailing semicolon',
        }),
    )
    .refine((m) => Object.keys(m).length <= 50, {
      message: 'Too many SOQL filters (max 50)',
    })
    .optional(),
});

/**
 * Strict ForgeConfig validation: enforces the inputMode→required-field
 * contract via `.refine`. CR-017 — without this, a payload like
 * `{inputMode:'soql', recordId:'…'}` passes validation, then crashes
 * downstream in `resolveRootObject` with a generic message.
 */
export const forgeConfigSchemaStrict = forgeConfigSchema.refine(
  (c) => {
    if (c.inputMode === 'record') return c.recordId !== undefined;
    if (c.inputMode === 'soql') return c.soqlQuery !== undefined;
    if (c.inputMode === 'template') return c.templateId !== undefined;
    if (c.inputMode === 'ai') return c.aiPrompt !== undefined;
    return false;
  },
  {
    message: 'inputMode requires the matching field (record→recordId, soql→soqlQuery, template→templateId, ai→aiPrompt)',
    path: ['inputMode'],
  },
);

// ─── Graph Schemas ──────────────────────────────────────────────────────────

/** Zod schema for ForgeGraphNode */
export const forgeGraphNodeSchema = z.object({
  objectApiName: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  recordCount: z.number().int().nonnegative(),
  fieldCount: z.number().int().nonnegative(),
  status: forgeNodeStatusSchema,
  progress: z.number().min(0).max(100),
  included: z.boolean(),
  piiFields: z.array(z.string().max(80)).max(500),
  anonymizeFields: z.array(z.string().max(80)).max(500),
  level: z.number().int().nonnegative().max(20),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  errors: z.array(z.string().max(2_000)).max(50),
  createableFieldCount: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
  batchStrategy: forgeBatchStrategySchema,
});

/** Zod schema for ForgeGraphEdge */
export const forgeGraphEdgeSchema = z.object({
  sourceObject: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  targetObject: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  relationshipName: z.string().min(1).max(80),
  type: forgeEdgeTypeSchema,
});

/**
 * Zod schema for ForgeGraph — bounded by .max() on nodes/edges to block
 * a forged payload from triggering O(n²) or recursive algorithms (Tarjan
 * SCC, in-degree map, etc.) into stack overflow / DoS.
 */
export const forgeGraphSchema = z.object({
  nodes: z.array(forgeGraphNodeSchema).max(2_000),
  edges: z.array(forgeGraphEdgeSchema).max(20_000),
  totalRecords: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  truncated: z.boolean().optional(),
});

// ─── Execution Result Schema ────────────────────────────────────────────────

/** Zod schema for ForgeExecutionErrorSample */
export const forgeExecutionErrorSampleSchema = z.object({
  recordSummary: z.string(),
  messages: z.array(z.string()),
});

/** Zod schema for ForgeExecutionError */
export const forgeExecutionErrorSchema = z.object({
  objectApiName: z.string().min(1),
  stage: z.enum(['query', 'insert', 'scope']),
  failedCount: z.number().int().nonnegative(),
  attemptedCount: z.number().int().nonnegative(),
  samples: z.array(forgeExecutionErrorSampleSchema),
});

/** Zod schema for ForgeExecutionResult */
export const forgeExecutionResultSchema = z.object({
  forgeId: z.string().min(1),
  status: forgeExecutionStatusSchema,
  graph: forgeGraphSchema,
  duration: z.number().nonnegative(),
  timestamp: z.string().min(1),
  idRemapCount: z.number().int().nonnegative(),
  errors: z.array(forgeExecutionErrorSchema).optional(),
});

// ─── Template Schema ────────────────────────────────────────────────────────

/** Zod schema for ForgeTemplate */
export const forgeTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  config: forgeConfigSchema.omit({ sourceOrgId: true, targetOrgId: true }),
  objectCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().min(1),
});

// ─── Forge v2 Schemas ──────────────────────────────────────────────────────

/** Zod schema for ForgeWave */
export const forgeWaveSchema = z.object({
  order: z.number().int().nonnegative(),
  objectApiNames: z.array(z.string()),
  totalRecords: z.number().int().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
});

/** Zod schema for ForgeCycleResolution */
export const forgeCycleResolutionSchema = z.object({
  objects: z.array(z.string()),
  strategy: forgeCycleStrategySchema,
  description: z.string(),
});

/** Zod schema for ForgePlan */
export const forgePlanSchema = z.object({
  waves: z.array(forgeWaveSchema),
  totalRecords: z.number().int().nonnegative(),
  totalApiCalls: z.number().int().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  cycleResolutions: z.array(forgeCycleResolutionSchema),
});

/** Zod schema for ForgeCheckpoint */
export const forgeCheckpointSchema = z.object({
  forgeId: z.string(),
  config: forgeConfigSchema,
  graph: forgeGraphSchema,
  plan: forgePlanSchema,
  currentWaveIndex: z.number().int().nonnegative(),
  currentObjectIndex: z.number().int().nonnegative(),
  currentBatchIndex: z.number().int().nonnegative(),
  remapperState: z.record(z.string()),
  completedObjects: z.array(z.string()),
  timestamp: z.string(),
});

// ─── Inferred Types ─────────────────────────────────────────────────────────

/** Inferred type for ForgeConfig input */
export type ForgeConfigInput = z.infer<typeof forgeConfigSchema>;

/** Inferred type for ForgeGraphNode input */
export type ForgeGraphNodeInput = z.infer<typeof forgeGraphNodeSchema>;

/** Inferred type for ForgeGraphEdge input */
export type ForgeGraphEdgeInput = z.infer<typeof forgeGraphEdgeSchema>;

/** Inferred type for ForgeGraph input */
export type ForgeGraphInput = z.infer<typeof forgeGraphSchema>;

/** Inferred type for ForgeExecutionResult input */
export type ForgeExecutionResultInput = z.infer<typeof forgeExecutionResultSchema>;

/** Inferred type for ForgeTemplate input */
export type ForgeTemplateInput = z.infer<typeof forgeTemplateSchema>;

/** Inferred type for ForgeWave input */
export type ForgeWaveInput = z.infer<typeof forgeWaveSchema>;

/** Inferred type for ForgePlan input */
export type ForgePlanInput = z.infer<typeof forgePlanSchema>;

/** Inferred type for ForgeCycleResolution input */
export type ForgeCycleResolutionInput = z.infer<typeof forgeCycleResolutionSchema>;

/** Inferred type for ForgeCheckpoint input */
export type ForgeCheckpointInput = z.infer<typeof forgeCheckpointSchema>;
