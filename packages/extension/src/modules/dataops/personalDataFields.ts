import type {
  ErasureMethod,
  PiiClassification,
  PiiDetectionMethod,
  SubjectIdentifierKind,
} from '@sandforge/shared';

import type { FieldDescribe, PIIDetector, PIIField } from '../../core/precheck/PIIDetector.js';
import { PERSONA_FIELD_MAP } from '../autopilot/SmartAnonymizer.js';
import type { DescribedField, DescribedObject } from './DataQualityScanner.js';

/**
 * Which fields of a record hold a person's data, what a subject search looks
 * for in each, and how an erasure overwrites it: the rules the inventory, the
 * search and the erasure share, so the three never disagree about a field.
 */

/**
 * Types whose value says something about a person: text, a number, a date, a
 * picked value. A checkbox holds a flag and a lookup a pointer, so neither is
 * listed, searched or overwritten — the detector names `HasOptedOutOfEmail`
 * from its label, and there is no address in it. Compound fields (an address,
 * a location) are read and written through their parts.
 */
const VALUE_TYPES = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'encryptedstring',
  'picklist',
  'multipicklist',
  'combobox',
  'date',
  'datetime',
  'int',
  'long',
  'double',
  'currency',
  'percent',
]);

/** Types whose value is text, the only values the detector reads content in. */
const TEXT_TYPES = new Set(['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring']);

/** The parts a person's name is written through where the name itself cannot be. */
const NAME_PARTS = ['FirstName', 'MiddleName', 'LastName'];

/** Whether a value read from a record says anything: not null, not blank. */
export function isFilledValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Whether a field holds a value about the record rather than a flag or a pointer. */
export function holdsValue(field: DescribedField): boolean {
  return VALUE_TYPES.has(field.type);
}

/** Whether a field holds text the detector can read content in. */
export function holdsText(field: DescribedField): boolean {
  return TEXT_TYPES.has(field.type);
}

/** The detector's words for how it found a field, in the inventory's. */
const DETECTED_BY: Record<PIIField['detectionMethod'], PiiDetectionMethod> = {
  name_pattern: 'name',
  type_analysis: 'type',
  content_pattern: 'content',
};

/** A field the detector names, with what it said about it. */
export interface PersonalDataField {
  field: DescribedField;
  classification: PiiClassification;
  detectedBy: PiiDetectionMethod;
  pattern: string;
}

/** A described field in the shape the detector reads. */
function toDetectorField(field: DescribedField): FieldDescribe {
  return { apiName: field.name, label: field.label, type: field.type };
}

/** Whether a person or an integration writes the field, rather than the org. */
export function isWrittenByPeople(field: DescribedField): boolean {
  return field.createable === true || field.updateable === true;
}

/**
 * The records as the detector reads their values: only the fields people
 * write. The org's own values — a photo URL, an id — are strings of capitals
 * and digits that the detector's bank-account pattern takes for an IBAN:
 * measured on a sandbox, `PhotoUrl` read as one on every contact sampled.
 */
function valuesPeopleWrote(
  fields: readonly DescribedField[],
  records: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const written = fields.filter(isWrittenByPeople).map((f) => f.name);
  return records.map((record) => {
    const values: Record<string, unknown> = {};
    for (const name of written) values[name] = record[name];
    return values;
  });
}

/**
 * The fields of `fields` the pre-flight detector names: from their API names,
 * labels and types, and — given records — from the values people wrote in
 * them. Only fields that hold a value are put to it.
 *
 * @param detector - The detector the Seed and Sync pre-flight runs.
 * @param objectApiName - The object the fields belong to.
 * @param fields - The object's described fields.
 * @param records - Records whose text values the detector reads, if any.
 */
export function detectPersonalData(
  detector: Pick<PIIDetector, 'detectPII'>,
  objectApiName: string,
  fields: readonly DescribedField[],
  records?: Array<Record<string, unknown>>,
): PersonalDataField[] {
  const candidates = fields.filter(holdsValue);
  const byName = new Map(candidates.map((f) => [f.name, f]));
  const found = detector.detectPII(
    objectApiName,
    candidates.map(toDetectorField),
    records && records.length > 0 ? valuesPeopleWrote(candidates, records) : undefined,
  );
  return found.piiFields.flatMap((detection) => {
    const field = byName.get(detection.fieldApiName);
    return field
      ? [
          {
            field,
            classification: detection.classification,
            detectedBy: DETECTED_BY[detection.detectionMethod],
            pattern: detection.pattern ?? detection.detectionMethod,
          },
        ]
      : [];
  });
}

/**
 * What a subject search looks for in a field: an address in an email field, a
 * number in a phone field — and in a text field whose name ends like one,
 * such as the Web Phone a case keeps as text. A text field that only mentions
 * one — `EmailBouncedReason` — is not searched. Only where the org lets
 * records be filtered on the field.
 */
export function searchKindOf(field: DescribedField): 'email' | 'phone' | undefined {
  if (field.filterable !== true) return undefined;
  if (field.type === 'email') return 'email';
  if (field.type === 'phone') return 'phone';
  if (field.type !== 'string') return undefined;
  if (/email(?:__c)?$/i.test(field.name)) return 'email';
  if (/phone(?:__c)?$/i.test(field.name)) return 'phone';
  return undefined;
}

/**
 * The field a subject search looks in for a person's name: the record's name
 * field, when the org lets records be filtered on it and does not number it
 * itself — a case number is no one's name.
 */
export function subjectNameField(object: DescribedObject): DescribedField | undefined {
  return object.fields.find(
    (f) =>
      f.nameField === true &&
      f.filterable === true &&
      f.autoNumber !== true &&
      (f.type === 'string' || f.type === 'textarea'),
  );
}

/** Every field of an object a subject search looks in, and for what. */
export function subjectSearchFields(
  object: DescribedObject,
): Array<{ field: DescribedField; kind: SubjectIdentifierKind }> {
  const found: Array<{ field: DescribedField; kind: SubjectIdentifierKind }> = [];
  for (const field of object.fields) {
    const kind = searchKindOf(field);
    if (kind) found.push({ field, kind });
  }
  const name = subjectNameField(object);
  if (name) found.push({ field: name, kind: 'name' });
  return found;
}

/**
 * The fields that make up a person's name on a record: the name field when it
 * can be written — an account's — and otherwise the first, middle and last
 * names it is composed from — a contact's, a lead's. The detector names none
 * of them, and an erasure that left the name would erase nothing.
 */
function nameFieldsOf(object: DescribedObject): DescribedField[] {
  const name = object.fields.find((f) => f.nameField === true && f.autoNumber !== true);
  if (name && name.updateable === true && holdsText(name)) return [name];
  return object.fields.filter((f) => NAME_PARTS.includes(f.name));
}

/** How an erasure overwrites one field. */
export interface ErasedField {
  field: DescribedField;
  method: ErasureMethod;
}

/** What an erasure writes on an object, and what it leaves. */
export interface ErasurePlan {
  /** The fields overwritten, and how. */
  fields: ErasedField[];
  /** Fields holding personal data the connected user may not write. */
  kept: DescribedField[];
}

/**
 * How an erasure overwrites a field: with a made-up value where the
 * anonymizer knows one of the kind (a name, an address, an email, a phone),
 * with nothing where the field may be empty, and with the anonymizer's opaque
 * token where it may not. A made-up value keeps the record valid where a
 * validation rule or a required field would refuse an empty one.
 */
export function erasureMethodOf(field: DescribedField): ErasureMethod {
  if (PERSONA_FIELD_MAP[field.name] !== undefined) return 'fake';
  return field.nillable === true ? 'nullify' : 'fake';
}

/**
 * The detector's value patterns an erasure takes at their word: an email
 * address, a social security number. Its phone, card and bank-account
 * patterns match any long run of digits or of capitals and digits — measured
 * on a sandbox, company registration numbers read as phone numbers on every
 * account that had one — and an erasure acting on them would empty business
 * data. The inventory still lists what they find, with how many values match.
 */
const ERASED_CONTENT_PATTERNS = new Set(['email_content', 'ssn_content']);

/**
 * The fields an erasure overwrites on an object: those the detector names on
 * the records being erased — by name or type, or by an address or a social
 * security number in their values — and the person's name. A field the
 * connected user may not write is kept, and said to be. A formula or a number
 * the org assigns holds nothing of its own: it follows the fields it is
 * computed from.
 *
 * @param object - The object's describe.
 * @param detected - What the detector named on the records being erased.
 */
export function planErasure(
  object: DescribedObject,
  detected: readonly PersonalDataField[],
): ErasurePlan {
  const seen = new Set<string>();
  const candidates: DescribedField[] = [];
  const trusted = detected.filter(
    (d) => d.detectedBy !== 'content' || ERASED_CONTENT_PATTERNS.has(d.pattern),
  );
  for (const field of [...trusted.map((d) => d.field), ...nameFieldsOf(object)]) {
    if (seen.has(field.name) || !holdsValue(field)) continue;
    if (field.calculated === true || field.autoNumber === true) continue;
    seen.add(field.name);
    candidates.push(field);
  }
  const fields: ErasedField[] = [];
  const kept: DescribedField[] = [];
  for (const field of candidates) {
    if (field.updateable === true) fields.push({ field, method: erasureMethodOf(field) });
    else kept.push(field);
  }
  return { fields, kept };
}
