/**
 * The rule the Seed wizard gives a field it has just described, before anyone
 * edits it.
 *
 * The wizard used to give every text, number, date and checkbox field a faker
 * rule with no method, which SeedValidator refuses ('Faker rule requires a
 * fakerMethod'), and every picklist a random-pick rule with no values, which
 * it refuses too: a run nobody had edited never reached the org. The rule
 * built here names a method the generator implements, or is not a faker rule.
 */
import type { FieldRuleConfig, FieldRuleType } from '../types/seed.types.js';
import type { FakerMethodName } from './faker-methods.js';

/** Method by describe type, for the types whose type alone says what they hold. */
export const FAKER_METHOD_BY_FIELD_TYPE: Readonly<Record<string, FakerMethodName>> = {
  email: 'email',
  phone: 'phone',
  url: 'url',
  date: 'pastDate',
  datetime: 'pastDate',
  int: 'integer',
  double: 'integer',
  currency: 'integer',
  percent: 'integer',
};

/**
 * Method by field name, for text fields, checked in order against the API
 * name without its `__c` suffix. A text field no pattern matches gets a
 * sentence.
 */
export const FAKER_METHOD_BY_FIELD_NAME: ReadonlyArray<{
  pattern: RegExp;
  method: FakerMethodName;
}> = [
  { pattern: /first_?name$/i, method: 'firstName' },
  { pattern: /last_?name$/i, method: 'lastName' },
  { pattern: /name$/i, method: 'name' },
];

/** Describe types read by field name. */
const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'textarea']);

/**
 * The faker method a field of this type and name gets by default, or
 * undefined for a type no method fills sensibly (boolean, id, base64, …).
 */
export function defaultFakerMethod(
  fieldType: string,
  fieldApiName: string,
): FakerMethodName | undefined {
  const type = fieldType.toLowerCase();
  if (TEXT_FIELD_TYPES.has(type)) {
    const name = fieldApiName.replace(/__c$/i, '');
    return (
      FAKER_METHOD_BY_FIELD_NAME.find(({ pattern }) => pattern.test(name))?.method ?? 'sentence'
    );
  }
  // Own keys only: a describe type is data from the org.
  return Object.prototype.hasOwnProperty.call(FAKER_METHOD_BY_FIELD_TYPE, type)
    ? FAKER_METHOD_BY_FIELD_TYPE[type]
    : undefined;
}

/** A createable field as `seed:describe-object` reports it. */
export interface DescribedSeedField {
  fieldApiName: string;
  type: string;
  picklistValues: string[];
  referenceTo: string[];
  /** Maximum length of a text value, 0 for types that have none. */
  length: number;
}

/**
 * The rule a described field starts with. A faker rule carries the field's
 * length, so a generated value longer than the field is cut before the
 * insert instead of failing it with STRING_TOO_LONG.
 */
export function describedFieldRule(field: DescribedSeedField): {
  ruleType: FieldRuleType;
  config: FieldRuleConfig;
} {
  if (field.referenceTo.length > 0) {
    return {
      ruleType: 'reference',
      config: { referenceObject: field.referenceTo[0], referenceField: 'Id' },
    };
  }
  if (field.type === 'picklist') {
    return field.picklistValues.length > 0
      ? { ruleType: 'picklist_random', config: { picklistValues: [...field.picklistValues] } }
      : { ruleType: 'static', config: {} };
  }
  const fakerMethod = defaultFakerMethod(field.type, field.fieldApiName);
  if (fakerMethod) {
    return {
      ruleType: 'faker',
      config: field.length > 0 ? { fakerMethod, maxLength: field.length } : { fakerMethod },
    };
  }
  // A checkbox is unchecked on create unless told otherwise; any other type
  // is left for the author to set, and inserts blank until then.
  return field.type === 'boolean'
    ? { ruleType: 'static', config: { staticValue: false } }
    : { ruleType: 'static', config: {} };
}
