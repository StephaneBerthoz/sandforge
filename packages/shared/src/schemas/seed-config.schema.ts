import { z } from 'zod';

/** Configuration for a single field generation rule */
export const fieldRuleConfigSchema = z.object({
  staticValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  fakerMethod: z.string().optional(),
  fakerLocale: z.string().optional(),
  sequenceStart: z.number().int().optional(),
  sequenceStep: z.number().int().optional(),
  sequencePrefix: z.string().optional(),
  formula: z.string().optional(),
  referenceObject: z.string().optional(),
  referenceField: z.string().optional(),
  picklistValues: z.array(z.string()).optional(),
  regexPattern: z.string().optional(),
  csvColumn: z.string().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  aiPrompt: z.string().optional(),
});

/** A field rule with its API name, type, and configuration */
export const fieldRuleSchema = z.object({
  fieldApiName: z.string().min(1),
  ruleType: z.enum([
    'static',
    'random',
    'sequence',
    'formula',
    'reference',
    'picklist_random',
    'ai_generate',
    'faker',
    'regex',
    'from_csv',
  ]),
  config: fieldRuleConfigSchema,
});

/** Per-object seed configuration */
export const seedObjectConfigSchema = z.object({
  objectApiName: z.string().min(1),
  recordCount: z.number().int().positive(),
  recordTypeId: z.string().optional(),
  fieldRules: z.array(fieldRuleSchema),
  excludedFields: z.array(z.string()),
  insertOrder: z.number().int().nonnegative(),
  batchSize: z.number().int().positive().max(10000).default(200),
});

/** Top-level seed configuration schema */
export const seedConfigSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  strategy: z.enum(['ai', 'faker', 'template', 'csv_import', 'clone']),
  objects: z.array(seedObjectConfigSchema).min(1),
  aiPersona: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

/** Inferred type for field rule configuration input */
export type FieldRuleConfigInput = z.infer<typeof fieldRuleConfigSchema>;

/** Inferred type for a field rule input */
export type FieldRuleInput = z.infer<typeof fieldRuleSchema>;

/** Inferred type for per-object seed configuration input */
export type SeedObjectConfigInput = z.infer<typeof seedObjectConfigSchema>;

/** Inferred type for seed configuration input */
export type SeedConfigInput = z.infer<typeof seedConfigSchema>;
