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
 * name without its `__c` or `__pc` suffix. A field these leave unanswered and
 * whose name ends in `Name` holds the name its object gives it (see
 * {@link defaultFakerMethod}); any other text field gets a sentence.
 */
export const FAKER_METHOD_BY_FIELD_NAME: ReadonlyArray<{
  pattern: RegExp;
  method: FakerMethodName;
}> = [
  { pattern: /first_?name$/i, method: 'firstName' },
  { pattern: /last_?name$/i, method: 'lastName' },
  // A middle name is a given name: a full name written in it reads as two people.
  { pattern: /middle_?name$/i, method: 'firstName' },
  // Where the field says whose name it holds, its object does not decide: a
  // web case's supplied name and a contact's name kept on another object are
  // a person's, a lead's company and a user's company name are a company's.
  { pattern: /(contact|person|assistant|supplied)_?name$/i, method: 'name' },
  { pattern: /(company|account)_?name$|company$/i, method: 'company' },
];

/** Describe types read by field name. */
const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'textarea']);

/**
 * Objects whose records are people, compared in lower case. Their `…Name`
 * fields hold a person's name; the `…Name` fields of every other object hold a
 * company's: an account named like a person reads as a contact everywhere it
 * appears.
 */
const PERSON_OBJECTS: ReadonlySet<string> = new Set(['contact', 'lead', 'user', 'individual']);

/**
 * A field of the person half of a person account, on the account itself: a
 * standard one is prefixed `Person` (`PersonAssistantName`), a custom one ends
 * in `__pc`.
 */
const PERSON_ACCOUNT_FIELD = /^Person[A-Z]|__pc$/;

/**
 * The faker method a field of this type and name gets by default, or
 * undefined for a type no method fills sensibly (boolean, id, base64, …).
 *
 * A `…Name` text field whose name says no more is a person's name on a person
 * — Contact, Lead, User, or a person account's own fields — and a company's
 * name on any other object. Without an object it is a company's: the standard
 * name fields of a person say whose name they hold (first, last, middle,
 * assistant), and the `Name` of a contact, a lead or a user is a compound no
 * insert writes, so a `Name` a seed fills belongs to something else.
 */
export function defaultFakerMethod(
  fieldType: string,
  fieldApiName: string,
  objectApiName?: string,
): FakerMethodName | undefined {
  const type = fieldType.toLowerCase();
  if (TEXT_FIELD_TYPES.has(type)) {
    const name = fieldApiName.replace(/__p?c$/i, '');
    const byName = FAKER_METHOD_BY_FIELD_NAME.find(({ pattern }) => pattern.test(name))?.method;
    if (byName) return byName;
    if (!/name$/i.test(name)) return 'sentence';
    const person =
      PERSON_ACCOUNT_FIELD.test(fieldApiName) ||
      (objectApiName !== undefined && PERSON_OBJECTS.has(objectApiName.toLowerCase()));
    return person ? 'name' : 'company';
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
  /**
   * The object the field belongs to, which decides whose name a `…Name` field
   * holds: a person's on a contact, a company's on an account.
   */
  objectApiName?: string;
}

/**
 * The digits a number field holds before its decimal point, 0 for any other
 * type. The describe gives an integer field's as `digits`, and a double's,
 * currency's or percent's as its `precision` less its `scale`. A seed draws a
 * field's default number within them.
 */
export function integerDigitsOf(field: {
  type: string;
  precision?: number;
  scale?: number;
  digits?: number;
}): number {
  if (field.type === 'int') return field.digits ?? 0;
  return Math.max(0, (field.precision ?? 0) - (field.scale ?? 0));
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
  const fakerMethod = defaultFakerMethod(field.type, field.fieldApiName, field.objectApiName);
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
