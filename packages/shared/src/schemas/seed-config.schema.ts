import * as z from 'zod';
import { SEED_RELATION_LIMITS, SEED_ROW_LIMITS } from '../utils/seed-relations.js';
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

/** What a row is named by, and what a child row names its parent row by. */
const seedRowKeySchema = z.string().min(1).max(SEED_ROW_LIMITS.maxKeyLength);

/** One record written with these values as they are (`SeedRow`). */
export const seedRowSchema = z.object({
  key: seedRowKeySchema,
  values: z.record(
    z.string().min(1),
    z.union([z.string().max(SEED_ROW_LIMITS.maxTextLength), z.number(), z.boolean(), z.null()]),
  ),
  parentKey: seedRowKeySchema.optional(),
});

/**
 * An object's rows, each key once: a child row names its parent by key, and
 * a key given twice would leave it two parents to be placed under.
 */
export const seedRowsSchema = z
  .array(seedRowSchema)
  .min(1)
  .max(SEED_MAX_RECORDS_PER_OBJECT)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `The key "${row.key}" names more than one row: each row is named once`,
        });
      }
      seen.add(row.key);
    }
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
  optional: z.boolean().optional(),
  rows: seedRowsSchema.optional(),
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

/** How many children each parent of a relation receives, or `byKey`: under the row each names. */
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
    z.object({ mode: z.literal('byKey') }),
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

/** The part of a template the checks of its rows read. */
export interface SeedKeyedRowsTemplate {
  objects: ReadonlyArray<{
    objectApiName: string;
    recordCount: number;
    rows?: ReadonlyArray<{ key: string; parentKey?: string }>;
  }>;
  relations?: ReadonlyArray<{
    childObject: string;
    parentObject: string;
    parents: { kind: string };
    distribution: { mode: string };
  }>;
}

/**
 * What a template's rows break, and where. A type rather than an interface,
 * so that a schema's refinement context, which takes any issue, takes it.
 */
export type SeedKeyedRowsIssue = {
  code: 'custom';
  path: Array<string | number>;
  message: string;
};

/**
 * What a template's rows break, across its objects and relations: an object
 * whose count is not its rows', a parent key no relation places by, a row of
 * a relation by key that names no parent row, or a relation by key over
 * parents that have no keys. Each issue says where it is.
 *
 * A refinement for the template schemas, given apart from `seedConfigSchema`
 * because the bridge extends its shape, which an object schema once refined
 * can no longer be. The run's validator asks the same of a template built in
 * code, which no schema reads.
 */
export function checkSeedKeyedRows(
  template: SeedKeyedRowsTemplate,
  ctx: { addIssue(issue: SeedKeyedRowsIssue): void },
): void {
  const objects = template.objects;
  const relations = template.relations ?? [];
  const issue = (path: Array<string | number>, message: string): void =>
    ctx.addIssue({ code: 'custom', path, message });
  for (const [index, object] of objects.entries()) {
    const rows = object.rows;
    if (!rows) continue;
    const name = object.objectApiName;
    if (object.recordCount !== rows.length) {
      issue(
        ['objects', index, 'recordCount'],
        `${name} gives ${rows.length} row(s) and asks for ${object.recordCount} record(s): ` +
          'an object with rows writes one record per row',
      );
    }
    const relation = relations.find((r) => r.childObject === name);
    const byKey = relation?.distribution.mode === 'byKey' ? relation : undefined;
    const parent = byKey && objects.find((o) => o.objectApiName === byKey.parentObject);
    const parentKeys = new Set((parent ? (parent.rows ?? []) : []).map((row) => row.key));
    for (const [at, row] of rows.entries()) {
      const path = ['objects', index, 'rows', at, 'parentKey'];
      if (!byKey) {
        if (row.parentKey !== undefined) {
          issue(
            path,
            `${name} row "${row.key}" names a parent row, and no relation places ${name} by key`,
          );
        }
      } else if (row.parentKey === undefined) {
        issue(
          path,
          `${name} row "${row.key}" names no ${byKey.parentObject} row: a relation by key ` +
            'places every row under the one it names',
        );
      } else if (parent && parent.rows && !parentKeys.has(row.parentKey)) {
        issue(
          path,
          `${name} row "${row.key}" is placed under ${byKey.parentObject} "${row.parentKey}", ` +
            `which no ${byKey.parentObject} row is`,
        );
      }
    }
  }
  for (const [index, relation] of relations.entries()) {
    if (relation.distribution.mode !== 'byKey') continue;
    const path = ['relations', index, 'distribution'];
    const said = `The relation on ${relation.childObject} places by key`;
    const child = objects.find((o) => o.objectApiName === relation.childObject);
    const parent = objects.find((o) => o.objectApiName === relation.parentObject);
    if (relation.parents.kind !== 'generated') {
      issue(path, `${said}, which only the ${relation.parentObject} rows this run writes have`);
    } else if (parent && !parent.rows) {
      issue(path, `${said}, and ${relation.parentObject} has no rows to name`);
    }
    if (child && !child.rows) {
      issue(path, `${said}, and ${relation.childObject} has no rows to place`);
    }
  }
}

/** What {@link checkSeedKeyedRows} finds in a template, as a list. */
export function seedKeyedRowsIssues(template: SeedKeyedRowsTemplate): SeedKeyedRowsIssue[] {
  const issues: SeedKeyedRowsIssue[] = [];
  checkSeedKeyedRows(template, { addIssue: (issue) => issues.push(issue) });
  return issues;
}

/** Inferred type for field rule configuration input */
export type FieldRuleConfigInput = z.infer<typeof fieldRuleConfigSchema>;

/** Inferred type for a field rule input */
export type FieldRuleInput = z.infer<typeof fieldRuleSchema>;

/** Inferred type for per-object seed configuration input */
export type SeedObjectConfigInput = z.infer<typeof seedObjectConfigSchema>;

/** Inferred type for seed configuration input */
export type SeedConfigInput = z.infer<typeof seedConfigSchema>;
