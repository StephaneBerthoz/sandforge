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
  /** Digits a number field holds before its decimal point; 0 or absent when unknown. */
  integerDigits?: number;
}

/** The most a generated whole number reaches when no rule says otherwise. */
const DEFAULT_MOST = 1000;

/**
 * A coordinate: the latitude or longitude of a standard address
 * (`BillingLatitude`) or of a geolocation field (`Site__Latitude__s`).
 */
const COORDINATE_FIELD = /(latitude|longitude)(__s)?$/i;

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
  // A coordinate drawn like any other number lands past 90 or 180, and the
  // org refuses the record: in a real sandbox every account a wizard run wrote
  // with its default rules was refused on its billing latitude. One drawn in
  // bounds would point nowhere near the address generated beside it, so a
  // coordinate is left for the author to set, like a type no generator fits.
  if (field.type === 'double' && COORDINATE_FIELD.test(field.fieldApiName)) {
    return { ruleType: 'static', config: {} };
  }
  const fakerMethod = defaultFakerMethod(field.type, field.fieldApiName);
  // A whole number is drawn up to 1000, which a field of fewer digits refuses:
  // a two-digit score on a real sandbox's accounts turned every one of them
  // down. It is drawn within what the field holds, and a percentage within
  // 100, past which the org refused every opportunity's probability.
  const digits = field.integerDigits ?? 0;
  const most = Math.min(
    digits > 0 ? 10 ** digits - 1 : DEFAULT_MOST,
    field.type === 'percent' ? 100 : DEFAULT_MOST,
  );
  if (fakerMethod === 'integer' && most < DEFAULT_MOST) {
    return { ruleType: 'faker', config: { fakerMethod, maxValue: most } };
  }
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
