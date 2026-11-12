import type { FieldMapping, AddOnField, MappingType } from '@sandforge/shared';
import { TransformPipeline } from './TransformPipeline.js';

/**
 * Applies field mappings to transform a source record into a target record.
 * Supports direct copy, rename, transform, constant, formula, and exclude mapping types.
 * Also handles add-on fields that inject constant values.
 */
export class FieldMappingService {
  /**
   * Apply field mappings to a source record, producing a mapped target record:
   * see {@link mapFields}.
   *
   * @param excludedFields - The fields the object's configuration leaves out
   *   (an SFDMU export's `excludedFields`), never written.
   */
  apply(
    record: Record<string, unknown>,
    mappings: readonly FieldMapping[],
    excludedFields: readonly string[] = [],
  ): Record<string, unknown> {
    return mapFields(record, mappings, excludedFields);
  }

  /**
   * Apply add-on fields to a record, injecting constant values.
   * Respects the overwriteExisting flag on each add-on field.
   */
  applyAddOns(record: Record<string, unknown>, addOns: AddOnField[]): Record<string, unknown> {
    const result: Record<string, unknown> = { ...record };

    for (const addOn of addOns) {
      const fieldExists = addOn.fieldApiName in result;
      if (!fieldExists || addOn.overwriteExisting) {
        result[addOn.fieldApiName] = addOn.value;
      }
    }

    return result;
  }
}

/**
 * The mapping types that read their source field and write its value, changed
 * or not, under their target field: the source field goes there, not under
 * its own name as well.
 */
export const MOVES_ITS_SOURCE: ReadonlySet<MappingType> = new Set<MappingType>([
  'direct',
  'rename',
  'transform',
  'add_on',
]);

/** An API name as Salesforce matches one, whatever its case. */
const nameKey = (field: string): string => field.toLowerCase();

/**
 * The target fields the mappings write a value into, by {@link nameKey}: every
 * mapping's but an exclude's, which writes nothing.
 */
export function mappedTargets(mappings: readonly FieldMapping[]): Set<string> {
  return new Set(
    mappings.filter((mapping) => mapping.type !== 'exclude').map((m) => nameKey(m.targetField)),
  );
}

/**
 * The fields of a record a write does not send as read, under their own name,
 * by {@link nameKey}: those the configuration excludes, those a mapping takes
 * to its target field, those an exclude mapping names, and the target fields
 * a mapping writes, whose value is the mapping's. Every other field goes as
 * the source holds it.
 */
export function notSentAsRead(
  mappings: readonly FieldMapping[],
  excludedFields: readonly string[] = [],
): Set<string> {
  const dropped = new Set(excludedFields.map(nameKey));
  for (const mapping of mappings) {
    if (MOVES_ITS_SOURCE.has(mapping.type) || mapping.type === 'exclude') {
      dropped.add(nameKey(mapping.sourceField));
    }
    dropped.add(nameKey(mapping.targetField));
  }
  return dropped;
}

/** The rules of a mapping, run once on the value it writes, as an object's own rules run. */
const pipeline = new TransformPipeline();

/**
 * A source record as a write sends it: a mapping renames or transforms its
 * field, and every other field goes as read, under its own name. The fields
 * the configuration excludes go nowhere, and neither does a field an exclude
 * mapping names.
 *
 * As soon as one mapping existed, the write carried the mapped fields alone:
 * an SFDMU export that renamed `BillingCity` onto `ShippingCity` wrote
 * ShippingCity and dropped every other field of every record, unsaid, in the
 * simulation as in the run. An SFDMU `fieldMapping` means "this field goes
 * there"; the panel's Field Mapping step says that an object without one has
 * its same-named fields copied, and offers Exclude for a field that should
 * not be.
 *
 * Field names are matched as Salesforce matches an API name, whatever their
 * case: a rename written `billingcity` left the record's `BillingCity` to go
 * as read beside its copy.
 */
export function mapFields(
  record: Record<string, unknown>,
  mappings: readonly FieldMapping[],
  excludedFields: readonly string[] = [],
): Record<string, unknown> {
  /*
   * No mapping means "copy the record as it was read". Returning an empty
   * object instead wrote EMPTY records: a sync configured without a visit to
   * the mapping step — which is every run of a wizard config whose objects
   * were added but never mapped — reached Salesforce with `{}` per row. The
   * only end-to-end test of the orchestrator then stubbed this service, so
   * nothing read what it returned.
   */
  if (mappings.length === 0 && excludedFields.length === 0) return { ...record };

  const excluded = new Set(excludedFields.map(nameKey));
  const read = Object.fromEntries(
    Object.entries(record).filter(([field]) => !excluded.has(nameKey(field))),
  );
  const dropped = notSentAsRead(mappings, excludedFields);
  const result = Object.fromEntries(
    Object.entries(read).filter(([field]) => !dropped.has(nameKey(field))),
  );

  for (const mapping of mappings) {
    const value = applyMapping(read, mapping);
    if (value === undefined) continue;
    result[mapping.targetField] = value;
  }

  return result;
}

/** The value of `field` in `record`, matched whatever its case. */
function valueOf(record: Record<string, unknown>, field: string): unknown {
  if (field in record) return record[field];
  const wanted = nameKey(field);
  const key = Object.keys(record).find((name) => nameKey(name) === wanted);
  return key === undefined ? undefined : record[key];
}

/** Symbol returned when a mapping produces no value (exclude type) */
const EXCLUDE = Symbol('exclude');

/**
 * Apply a single field mapping to a source record: the value it writes, its
 * own rules applied once, or undefined when it writes none (an exclude, or a
 * source field the record does not carry).
 */
function applyMapping(record: Record<string, unknown>, mapping: FieldMapping): unknown {
  const handler = MAPPING_HANDLERS[mapping.type];
  const value = handler(record, mapping);
  if (value === EXCLUDE || value === undefined) {
    return undefined;
  }
  return mapping.transformRules && mapping.transformRules.length > 0
    ? pipeline.transform(value, mapping.transformRules)
    : value;
}

type MappingHandler = (record: Record<string, unknown>, mapping: FieldMapping) => unknown;

/**
 * What each mapping type writes, before its rules. A transform mapping's rules
 * ran here with rules of their own — an empty field became "" — and then again
 * in the transform pipeline: a prefix went on twice. They run once now, with
 * the pipeline's, in {@link applyMapping}.
 */
const MAPPING_HANDLERS: Record<MappingType, MappingHandler> = {
  direct: (record, mapping) => valueOf(record, mapping.sourceField),

  rename: (record, mapping) => valueOf(record, mapping.sourceField),

  transform: (record, mapping) => valueOf(record, mapping.sourceField),

  constant: (_record, mapping) => (mapping.targetField ? mapping.sourceField : undefined),

  formula: (record, mapping) => evaluateFormula(record, mapping.sourceField),

  exclude: () => EXCLUDE,

  add_on: (record, mapping) => valueOf(record, mapping.sourceField),
};

/**
 * Evaluate a simple formula expression against a record.
 * The formula is the source field name by default; complex formulas
 * concatenate field references in {FieldName} syntax.
 */
function evaluateFormula(record: Record<string, unknown>, formula: string): unknown {
  const fieldRefPattern = /\{(\w+)\}/g;
  if (!fieldRefPattern.test(formula)) {
    return record[formula];
  }

  return formula.replace(/\{(\w+)\}/g, (_match, fieldName: string) => {
    const val = record[fieldName];
    return val !== null && val !== undefined ? String(val) : '';
  });
}
