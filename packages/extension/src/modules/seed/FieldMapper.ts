import type { SeedObjectConfig, FieldRule } from '@sandforge/shared';
import type { AIDataGenerator } from './AIDataGenerator';
import type { FakerFallback } from './FakerFallback';

/** Dependencies required by FieldMapper */
export interface FieldMapperDependencies {
  aiGenerator: AIDataGenerator;
  fakerFallback: FakerFallback;
}

/**
 * Maps field rules to generated values for a given object configuration.
 * Delegates AI and faker generation to their respective sub-services
 * and handles all other rule types internally.
 */
export class FieldMapper {
  private readonly deps: FieldMapperDependencies;

  constructor(deps: FieldMapperDependencies) {
    this.deps = deps;
  }

  /**
   * Generate an array of records for the given object configuration.
   * Uses existingIds to resolve reference fields to previously created records.
   */
  async mapFields(
    objectConfig: SeedObjectConfig,
    existingIds: Map<string, string[]>,
  ): Promise<Record<string, unknown>[]> {
    const { recordCount, fieldRules } = objectConfig;

    if (recordCount <= 0 || fieldRules.length === 0) {
      return [];
    }

    const aiRules = fieldRules.filter((r) => r.ruleType === 'ai_generate');
    const fakerRules = fieldRules.filter((r) => r.ruleType === 'faker');
    const otherRules = fieldRules.filter(
      (r) => r.ruleType !== 'ai_generate' && r.ruleType !== 'faker',
    );

    const aiRecords =
      aiRules.length > 0 ? await this.deps.aiGenerator.generate(aiRules, recordCount) : [];

    const fakerRecords =
      fakerRules.length > 0 ? this.deps.fakerFallback.generate(fakerRules, recordCount) : [];

    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < recordCount; i++) {
      const record: Record<string, unknown> = {};

      for (const rule of otherRules) {
        record[rule.fieldApiName] = generateValue(rule, i, existingIds);
      }

      if (aiRecords[i]) {
        Object.assign(record, aiRecords[i]);
      }

      if (fakerRecords[i]) {
        Object.assign(record, fakerRecords[i]);
      }

      records.push(record);
    }

    return records;
  }
}

/**
 * Generate a value for a single field rule at the given record index.
 * Handles static, random, sequence, picklist_random, and reference rule types.
 */
export function generateValue(
  rule: FieldRule,
  index: number,
  existingIds: Map<string, string[]>,
): unknown {
  switch (rule.ruleType) {
    case 'static':
      return rule.config.staticValue ?? null;

    case 'random':
      return generateRandomValue(rule, index);

    case 'sequence':
      return generateSequenceValue(rule, index);

    case 'picklist_random':
      return generatePicklistValue(rule);

    case 'reference':
      return generateReferenceValue(rule, existingIds);

    case 'formula':
      return rule.config.formula ?? null;

    case 'regex':
      return rule.config.regexPattern ?? null;

    case 'from_csv':
      return null;

    default:
      return null;
  }
}

/** Generate a random value respecting min/max constraints */
function generateRandomValue(rule: FieldRule, _index: number): unknown {
  const min = rule.config.minValue ?? 0;
  const max = rule.config.maxValue ?? 1000;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Generate a sequence value with optional prefix */
function generateSequenceValue(rule: FieldRule, index: number): string {
  const start = rule.config.sequenceStart ?? 1;
  const step = rule.config.sequenceStep ?? 1;
  const prefix = rule.config.sequencePrefix ?? '';
  return `${prefix}${start + index * step}`;
}

/** Pick a random value from the configured picklist values */
function generatePicklistValue(rule: FieldRule): unknown {
  const values = rule.config.picklistValues;
  if (!values || values.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
}

/** Resolve a reference to a random ID from the target object's created IDs */
function generateReferenceValue(rule: FieldRule, existingIds: Map<string, string[]>): unknown {
  const targetObject = rule.config.referenceObject;
  if (!targetObject) {
    return null;
  }

  const ids = existingIds.get(targetObject);
  if (!ids || ids.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * ids.length);
  return ids[randomIndex];
}
