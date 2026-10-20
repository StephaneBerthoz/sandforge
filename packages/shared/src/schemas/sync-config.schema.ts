import { z } from 'zod';
import { FILE_COPY_CEILING_MB, FILE_COPY_DEFAULT_MAX_MB } from '../constants/file-copy.js';

/** The largest file a Sync configuration copies unless it sets another size, in MB. */
export const SYNC_FILES_DEFAULT_MAX_FILE_MB = FILE_COPY_DEFAULT_MAX_MB;

/**
 * The most a Sync run copies unless the configuration sets another amount, in
 * MB: half the file storage of a Developer sandbox, so one run cannot fill it.
 */
export const SYNC_FILES_DEFAULT_RUN_MB = 100;

/** The most a Sync run can be set to copy, in MB. */
export const SYNC_FILES_MAX_RUN_MB = 2_000;

/**
 * A configuration's choice to copy the files of the records it writes: two
 * whole numbers of megabytes, the largest file no more than one call carries.
 */
export const syncFileCopyOptionSchema = z.object({
  maxFileSizeMB: z.number().int().min(1).max(FILE_COPY_CEILING_MB),
  maxRunMB: z.number().int().min(1).max(SYNC_FILES_MAX_RUN_MB),
});

/** Transform rule configuration */
export const transformRuleConfigSchema = z.object({
  length: z.number().int().positive().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  search: z.string().optional(),
  replace: z.string().optional(),
  regex: z.string().optional(),
  valueMap: z.record(z.string(), z.string()).optional(),
  defaultValue: z.string().optional(),
  dateFormat: z.string().optional(),
  numberFormat: z.string().optional(),
  formula: z.string().optional(),
});

/** Transform rule schema */
export const transformRuleSchema = z.object({
  type: z.enum([
    'uppercase',
    'lowercase',
    'trim',
    'truncate',
    'prefix',
    'suffix',
    'replace',
    'regex_replace',
    'map_value',
    'default_value',
    'format_date',
    'format_number',
    'custom_formula',
  ]),
  config: transformRuleConfigSchema,
});

/** Field mapping schema */
export const fieldMappingSchema = z.object({
  sourceField: z.string().min(1),
  targetField: z.string().min(1),
  type: z.enum(['direct', 'rename', 'transform', 'constant', 'formula', 'exclude', 'add_on']),
  transformRules: z.array(transformRuleSchema).optional(),
});

/** Per-object sync configuration */
export const syncObjectConfigSchema = z.object({
  objectApiName: z.string().min(1),
  externalIdField: z.string().optional(),
  operation: z.enum(['insert', 'update', 'upsert', 'delete']),
  query: z.string().optional(),
  fieldMappings: z.array(fieldMappingSchema),
  transformRules: z.array(transformRuleSchema),
  excludedFields: z.array(z.string()),
  addOnFields: z
    .array(
      z.object({
        fieldApiName: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]),
        overwriteExisting: z.boolean(),
      }),
    )
    .default([]),
  batchSize: z.number().int().positive().default(200),
  orderBy: z.string().optional(),
  where: z.string().optional(),
  insertOrder: z.number().int().nonnegative().default(0),
});

/**
 * The strategies a bidirectional sync run settles a conflict with, in the
 * order the page offers them. `manual` is left out on purpose: see
 * `SyncConflictStrategy`.
 */
export const syncConflictStrategySchema = z.enum([
  'source_wins',
  'target_wins',
  'newest_wins',
  'merge',
]);

/** {@link syncConflictStrategySchema}'s values. */
export const SYNC_CONFLICT_STRATEGIES = syncConflictStrategySchema.options;

/** Top-level sync configuration schema */
export const syncConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  sourceOrgId: z.uuid(),
  targetOrgId: z.uuid(),
  direction: z.enum(['source_to_target', 'target_to_source', 'bidirectional']),
  mode: z.enum(['full', 'incremental', 'delta', 'cdc']),
  objects: z.array(syncObjectConfigSchema).min(1),
  conflictStrategy: syncConflictStrategySchema,
  enableRollback: z.boolean().default(false),
  /** With `mode: 'delta'`: carry the source's deletions to the target. Off unless set. */
  propagateDeletes: z.boolean().optional(),
  /** Copy the files of the records each object writes. Off unless set. */
  files: syncFileCopyOptionSchema.optional(),
  /**
   * Write emails and phone numbers as the source holds them. Off unless set:
   * parsing drops what the schema does not name, and the choice would never
   * reach the run.
   */
  keepContactPoints: z.boolean().optional(),
});

/** Inferred type for transform rule configuration input */
export type TransformRuleConfigInput = z.infer<typeof transformRuleConfigSchema>;

/** Inferred type for a transform rule input */
export type TransformRuleInput = z.infer<typeof transformRuleSchema>;

/** Inferred type for a field mapping input */
export type FieldMappingInput = z.infer<typeof fieldMappingSchema>;

/** Inferred type for per-object sync configuration input */
export type SyncObjectConfigInput = z.infer<typeof syncObjectConfigSchema>;

/** Inferred type for sync configuration input */
export type SyncConfigInput = z.infer<typeof syncConfigSchema>;
