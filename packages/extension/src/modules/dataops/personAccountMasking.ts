/**
 * What a masking run masks of the person accounts of Account.
 *
 * A person account is a person held as an account: its first and last names,
 * its email, its phones, its birthdate and its mailing address are fields of
 * the account — `FirstName`, `PersonEmail`, `PersonBirthdate`, the custom
 * fields of its contact as `__pc` — and the templates name none of them.
 * Run on the accounts of an org with person accounts, the GDPR template masked
 * the billing street and the phone of every account, and left every person's
 * name, email, phones, birthdate and mailing address in clear.
 *
 * So a template masks on a person account what it masks on a contact: each of
 * its Contact rules applies to the field of the account that holds, for a
 * person account, what the contact's field holds. The fields only a person
 * account holds that the personal data detector names, and that no rule
 * covers, are overwritten as an erasure overwrites them. Those rules apply to
 * person accounts only, never to a business account, which holds none of
 * them but its phone; and no rule writes on a row a field the kind of account
 * it is cannot hold (`leftOutForAccountKind`): a person account's name is the
 * platform's, computed from its first and last names, and refused from an
 * update.
 */

import type { AnonymizationTemplateRule, DataOpsAnonymizationRule } from '@sandforge/shared';

import {
  ACCOUNT,
  CONTACT,
  accountKindOf,
  isPersonAccountField,
  leftOutForAccountKind,
} from '../../core/common/platformRecords.js';
import type { PIIDetector } from '../../core/precheck/PIIDetector.js';
import type { DescribedField } from './DataQualityScanner.js';
import { detectPersonalData, erasureMethodOf } from './personalDataFields.js';

/** The flag of an account that tells a person account's row, read with the rows a run masks. */
export const PERSON_ACCOUNT_FLAG = 'IsPersonAccount';

/**
 * The fields of a contact a person account holds under the same name: the
 * parts of its name, and the phone and fax it shares with its account.
 */
const SAME_NAME_ON_THE_ACCOUNT: ReadonlySet<string> = new Set([
  'FirstName',
  'LastName',
  'MiddleName',
  'Suffix',
  'Salutation',
  'Phone',
  'Fax',
]);

/**
 * The field of an account that holds, for a person account, what `field`
 * holds on its contact: the same name for the parts of the name, the phone
 * and the fax; `Person` before the name for the contact's other standard
 * fields — `Email` is `PersonEmail`, `MailingStreet` is `PersonMailingStreet`;
 * `__pc` for a custom field. A field the account does not have is not in its
 * describe, and its rule masks nothing.
 *
 * @param field - A field of Contact, as a template names it.
 */
export function personAccountFieldOf(field: string): string | undefined {
  if (SAME_NAME_ON_THE_ACCOUNT.has(field)) return field;
  if (field.endsWith('__c')) return `${field.slice(0, -'__c'.length)}__pc`;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) return undefined;
  return `Person${field}`;
}

/**
 * The rules a template applies to the person accounts of Account: each of its
 * Contact rules, on the field of the account that holds what the contact's
 * does (`personAccountFieldOf`). A field the template names on Account itself
 * keeps the template's rule.
 *
 * @param rules - Every rule of the template.
 */
export function personAccountRules(
  rules: readonly AnonymizationTemplateRule[],
): AnonymizationTemplateRule[] {
  const fieldOf = (rule: AnonymizationTemplateRule, object: string): string | undefined =>
    rule.fieldPattern.startsWith(`${object}.`)
      ? rule.fieldPattern.slice(object.length + 1)
      : undefined;
  const named = new Set(
    rules.flatMap((rule) => {
      const field = fieldOf(rule, ACCOUNT);
      return field === undefined ? [] : [field.toLowerCase()];
    }),
  );
  const derived: AnonymizationTemplateRule[] = [];
  for (const rule of rules) {
    const contactField = fieldOf(rule, CONTACT);
    const field = contactField === undefined ? undefined : personAccountFieldOf(contactField);
    if (field === undefined || named.has(field.toLowerCase())) continue;
    named.add(field.toLowerCase());
    derived.push({ ...rule, fieldPattern: `${ACCOUNT}.${field}` });
  }
  return derived;
}

/** A field of the account as its describe gives it, as far as the masking reads it. */
export interface MaskableField {
  name: string;
  label?: string;
  type?: string;
  updateable?: boolean;
  nillable?: boolean;
  calculated?: boolean;
}

/** What a masking run applies to the person accounts of an object, beside the template's own rules. */
export interface PersonAccountMasking {
  /** The rules on fields of the person accounts, under the names the describe gives them. */
  rules: DataOpsAnonymizationRule[];
  /** The fields those rules mask: on a person account only, never on a business one. */
  personOnly: ReadonlySet<string>;
}

/**
 * What a run masks of the person accounts of an object, or nothing where it
 * has none: an object other than Account, or an org without person accounts,
 * whose account has no `IsPersonAccount`.
 *
 * The rules a template derives for them (`personAccountRules`), on the fields
 * the describe has and that no rule of the template's own already masks; then
 * the fields only a person account holds that the detector names from their
 * API names, labels and types, that an update can set and that no rule covers,
 * each overwritten as an erasure overwrites it (`erasureMethodOf`): a made-up
 * value where the anonymizer knows one of the kind, nothing where the field
 * may be empty.
 *
 * @param input.objectApiName - The object the run masks.
 * @param input.fields - Its describe's fields.
 * @param input.kept - The template's own rules the describe kept.
 * @param input.derived - The rules the template derives for person accounts.
 * @param input.detector - The personal data detector the session runs.
 */
export function personAccountMasking(input: {
  objectApiName: string;
  fields: readonly MaskableField[];
  kept: readonly DataOpsAnonymizationRule[];
  derived: readonly DataOpsAnonymizationRule[];
  detector: Pick<PIIDetector, 'detectPII'>;
}): PersonAccountMasking | undefined {
  if (input.objectApiName.toLowerCase() !== ACCOUNT.toLowerCase()) return undefined;
  if (!input.fields.some((f) => f.name === PERSON_ACCOUNT_FLAG)) return undefined;
  const byName = new Map(input.fields.map((f) => [f.name.toLowerCase(), f]));
  const taken = new Set(input.kept.map((rule) => rule.fieldApiName.toLowerCase()));
  const rules: DataOpsAnonymizationRule[] = [];
  const personOnly = new Set<string>();
  const add = (rule: DataOpsAnonymizationRule, field: MaskableField): void => {
    taken.add(field.name.toLowerCase());
    personOnly.add(field.name);
    rules.push({ ...rule, objectApiName: ACCOUNT, fieldApiName: field.name });
  };
  for (const rule of input.derived) {
    const field = byName.get(rule.fieldApiName.toLowerCase());
    if (!field || taken.has(field.name.toLowerCase())) continue;
    add(rule, field);
  }
  // Put to the detector under the contact's names, so it names on a person
  // account what it names on a contact: its patterns read `MailingStreet`,
  // and `PersonMailingStreet` runs the words together.
  const candidates = input.fields.filter(
    (f) =>
      isPersonAccountField(f.name) &&
      f.updateable === true &&
      f.calculated !== true &&
      !taken.has(f.name.toLowerCase()),
  );
  const asContact = new Map<string, MaskableField>();
  const described: DescribedField[] = candidates.map((f) => {
    const name = contactFieldOf(f.name);
    asContact.set(name, f);
    return { ...f, name, label: f.label ?? f.name, type: f.type ?? 'string' };
  });
  for (const found of detectPersonalData(input.detector, CONTACT, described)) {
    const field = asContact.get(found.field.name);
    if (!field || taken.has(field.name.toLowerCase())) continue;
    add(
      {
        objectApiName: ACCOUNT,
        fieldApiName: field.name,
        method: erasureMethodOf({ ...found.field, name: field.name }),
        config: {},
      },
      field,
    );
  }
  return { rules, personOnly };
}

/**
 * The field of a contact a field only a person account holds stands for: the
 * one `personAccountFieldOf` gives it from, `PersonEmail` for `Email`.
 */
function contactFieldOf(field: string): string {
  if (field.endsWith('__pc')) return `${field.slice(0, -'__pc'.length)}__c`;
  if (field.startsWith('Person') && !field.includes('__')) return field.slice('Person'.length);
  return field;
}

/**
 * The rules a row of `objectApiName` is masked by: on Account, without those
 * on a field the kind of account the row is cannot hold, and without those of
 * the person accounts on a business account; on any other object, all of them.
 *
 * @param row - The row as the run read it, `IsPersonAccount` included.
 * @param rules - Every rule the run applies to the object.
 * @param personOnly - The fields masked on person accounts only.
 */
export function rulesOfRow(
  objectApiName: string,
  row: Record<string, unknown>,
  rules: readonly DataOpsAnonymizationRule[],
  personOnly: ReadonlySet<string>,
): DataOpsAnonymizationRule[] {
  if (objectApiName.toLowerCase() !== ACCOUNT.toLowerCase()) return [...rules];
  const kind = accountKindOf(row, false);
  return rules.filter(
    (rule) =>
      !leftOutForAccountKind(ACCOUNT, rule.fieldApiName, kind) &&
      (kind === 'person' || !personOnly.has(rule.fieldApiName)),
  );
}
