import * as z from 'zod';
import { SEED_RELATION_LIMITS } from '../utils/seed-relations.js';
import { SEED_MAX_RECORDS_PER_OBJECT } from '../constants/defaults.js';

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
  fieldType: z.string().min(1).optional(),
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
  recordCount: z.number().int().positive().max(SEED_MAX_RECORDS_PER_OBJECT),
  recordTypeId: z.string().optional(),
  fieldRules: z.array(fieldRuleSchema),
  excludedFields: z.array(z.string()),
  insertOrder: z.number().int().nonnegative(),
  batchSize: z.number().int().positive().max(10000).default(200),
});

/** A record id as an org writes one: 15 letters and digits, or 18 with the case-safe suffix. */
const seedParentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'A record id is 15 or 18 letters and digits');

/** Where a relation's parents come from: this run, the org by a filter, or records named by id. */
export const seedRelationParentsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generated') }),
  z.object({
    kind: z.literal('existing'),
    where: z.string().max(2000).optional(),
    limit: z.number().int().positive().max(SEED_RELATION_LIMITS.maxExistingParents),
  }),
  z.object({
    kind: z.literal('records'),
    // The bound the org's own parents have. A record given twice — its 15
    // characters and its 18 are one record — would take twice the children.
    ids: z
      .array(seedParentIdSchema)
      .min(1)
      .max(SEED_RELATION_LIMITS.maxExistingParents)
      .refine((ids) => new Set(ids.map((id) => id.slice(0, 15))).size === ids.length, {
        message: 'Each parent record is given once',
      }),
  }),
]);

/** How many children each parent of a relation receives. */
export const seedRelationDistributionSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('perParent'),
      count: z.number().int().positive().max(SEED_RELATION_LIMITS.maxPerParent),
    }),
    z.object({
      mode: z.literal('range'),
      min: z.number().int().nonnegative().max(SEED_RELATION_LIMITS.maxPerParent),
      max: z.number().int().positive().max(SEED_RELATION_LIMITS.maxPerParent),
    }),
    z.object({
      mode: z.literal('ratio'),
      ratio: z.number().min(SEED_RELATION_LIMITS.minRatio).max(SEED_RELATION_LIMITS.maxPerParent),
    }),
  ])
  .refine((distribution) => distribution.mode !== 'range' || distribution.min <= distribution.max, {
    message: 'A range of children per parent cannot start above its end',
    path: ['min'],
  });

/** A lookup of a generated object, filled from a parent object's records. */
export const seedRelationSchema = z.object({
  childObject: z.string().min(1),
  lookupField: z.string().min(1),
  parentObject: z.string().min(1),
  parents: seedRelationParentsSchema,
  distribution: seedRelationDistributionSchema,
});

/** Top-level seed configuration schema */
export const seedConfigSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  strategy: z.enum(['ai', 'faker', 'template', 'csv_import', 'clone']),
  objects: z.array(seedObjectConfigSchema).min(1),
  relations: z.array(seedRelationSchema).max(100).optional(),
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
