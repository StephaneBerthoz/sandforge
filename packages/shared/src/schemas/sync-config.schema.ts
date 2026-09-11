import { z } from 'zod';

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

/** Top-level sync configuration schema */
export const syncConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  sourceOrgId: z.string().uuid(),
  targetOrgId: z.string().uuid(),
  direction: z.enum(['source_to_target', 'target_to_source', 'bidirectional']),
  mode: z.enum(['full', 'incremental', 'delta', 'cdc']),
  objects: z.array(syncObjectConfigSchema).min(1),
  conflictStrategy: z.enum(['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge']),
  enableRollback: z.boolean().default(false),
  dryRun: z.boolean().default(false),
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
