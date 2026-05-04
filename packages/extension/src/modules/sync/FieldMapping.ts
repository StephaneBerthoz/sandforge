import type { FieldMapping, AddOnField, MappingType, TransformRule } from '@sandforge/shared';

/**
 * Applies field mappings to transform a source record into a target record.
 * Supports direct copy, rename, transform, constant, formula, and exclude mapping types.
 * Also handles add-on fields that inject constant values.
 */
export class FieldMappingService {
  /**
   * Apply field mappings to a source record, producing a mapped target record.
   * Each mapping type controls how the source field value is transferred.
   */
  apply(record: Record<string, unknown>, mappings: FieldMapping[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const mapping of mappings) {
      const value = applyMapping(record, mapping);
      if (value !== undefined) {
        result[mapping.targetField] = value;
      }
    }

    return result;
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

/** Symbol returned when a mapping produces no value (exclude type) */
const EXCLUDE = Symbol('exclude');

/**
 * Apply a single field mapping to a source record.
 * Returns undefined for exclude mappings, the mapped value otherwise.
 */
function applyMapping(record: Record<string, unknown>, mapping: FieldMapping): unknown {
  const handler = MAPPING_HANDLERS[mapping.type];
  const value = handler(record, mapping);
  if (value === EXCLUDE) {
    return undefined;
  }
  return value;
}

type MappingHandler = (record: Record<string, unknown>, mapping: FieldMapping) => unknown;

const MAPPING_HANDLERS: Record<MappingType, MappingHandler> = {
  direct: (record, mapping) => record[mapping.sourceField],

  rename: (record, mapping) => record[mapping.sourceField],

  transform: (record, mapping) => {
    let value = record[mapping.sourceField];
    if (mapping.transformRules) {
      for (const rule of mapping.transformRules) {
        value = applyTransformRule(value, rule);
      }
    }
    return value;
  },

  constant: (_record, mapping) => (mapping.targetField ? mapping.sourceField : undefined),

  formula: (record, mapping) => evaluateFormula(record, mapping.sourceField),

  exclude: () => EXCLUDE,

  add_on: (record, mapping) => record[mapping.sourceField],
};

/**
 * Apply a single transform rule to a value.
 * Delegates to the TransformPipeline for actual transformation logic.
 */
function applyTransformRule(value: unknown, rule: TransformRule): unknown {
  const strValue = String(value ?? '');

  switch (rule.type) {
    case 'uppercase':
      return strValue.toUpperCase();
    case 'lowercase':
      return strValue.toLowerCase();
    case 'trim':
      return strValue.trim();
    case 'truncate':
      return strValue.slice(0, Number(rule.config.length ?? strValue.length));
    case 'prefix':
      return `${String(rule.config.prefix ?? '')}${strValue}`;
    case 'suffix':
      return `${strValue}${String(rule.config.suffix ?? '')}`;
    default:
      return value;
  }
}

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
