import type { SeedObjectConfig, FieldRule } from '@sandforge/shared';
import type { AIDataGenerator } from './AIDataGenerator';
import type { FakerFallback } from './FakerFallback';
import { fillDigitMask } from './LocaleData';

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

    // The AI call yields no records when AI is off or the call is refused, and
    // may return fewer records or fields than asked. A field it left out was
    // inserted blank; it now gets a generated sentence, so the run writes what
    // the rule promised and the refusal stays a log line.
    const aiGaps = hasMissingAiValues(aiRules, aiRecords, recordCount);
    const aiFallbackRecords = aiGaps
      ? this.deps.fakerFallback.generate(aiRules.map(toSentenceRule), recordCount)
      : [];

    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < recordCount; i++) {
      const record: Record<string, unknown> = {};

      for (const rule of otherRules) {
        record[rule.fieldApiName] = generateValue(rule, i, existingIds);
      }

      if (aiRecords[i]) {
        Object.assign(record, aiRecords[i]);
      }

      for (const rule of aiGaps ? aiRules : []) {
        if (record[rule.fieldApiName] === undefined || record[rule.fieldApiName] === null) {
          record[rule.fieldApiName] = aiFallbackRecords[i]?.[rule.fieldApiName] ?? null;
        }
      }

      if (fakerRecords[i]) {
        Object.assign(record, fakerRecords[i]);
      }

      records.push(record);
    }

    return records;
  }
}

/** Whether any record lacks a value for one of the AI rules. */
function hasMissingAiValues(
  aiRules: FieldRule[],
  aiRecords: Record<string, unknown>[],
  recordCount: number,
): boolean {
  if (aiRules.length === 0) return false;
  if (aiRecords.length < recordCount) return true;
  return aiRecords.some((record) =>
    aiRules.some(
      (rule) => record[rule.fieldApiName] === undefined || record[rule.fieldApiName] === null,
    ),
  );
}

/**
 * An AI rule restated as a faker rule that writes a sentence. SeedValidator
 * refuses AI rules on fields that cannot hold text, so the sentence fits.
 */
function toSentenceRule(rule: FieldRule): FieldRule {
  return {
    fieldApiName: rule.fieldApiName,
    ruleType: 'faker',
    config: { fakerMethod: 'sentence' },
  };
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
      return generatePatternValue(rule, index);

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

/**
 * Fill the digit mask the rule carries.
 *
 * `regexPattern` holds a mask, the shape personas and the wizard write it in:
 * '#' stands for a digit and every other character is literal. The mask says
 * what the value looks like — returning it unchanged put '###########00##' in
 * the SIRET column of every inserted record. Patterns written in regex syntax
 * are not expanded: they contain no '#' and come back as they were written.
 */
function generatePatternValue(rule: FieldRule, index: number): string | null {
  const mask = rule.config.regexPattern;
  if (!mask) {
    return null;
  }
  return fillDigitMask(mask, index);
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
