/**
 * Which fields of an account each kind of account takes: the rule every
 * module that writes accounts follows, and the one the Seed wizard lists an
 * account's fields by, so the step that sets their rules shows what the run
 * will send.
 */

/** The object a person account is a record of. */
const ACCOUNT = 'Account';

/** The name parts only a person account holds; `Salutation` "is available on person accounts". */
const PERSON_NAME_FIELDS: ReadonlySet<string> = new Set([
  'FirstName',
  'LastName',
  'MiddleName',
  'Suffix',
  'Salutation',
]);

/**
 * Whether only a person account holds a field of an account: its name parts,
 * the standard fields named `Person…`, and the custom fields of its contact
 * (`__pc`). "If the IsPersonAccount field has the value false, the following
 * fields have a null value and can't be modified" (Object Reference for the
 * Salesforce Platform, Account, IsPersonAccount Fields): sent with a business
 * account, they were refused with it.
 */
export function isPersonAccountField(name: string): boolean {
  return (
    PERSON_NAME_FIELDS.has(name) ||
    name.endsWith('__pc') ||
    (name.startsWith('Person') && !name.includes('__'))
  );
}

/**
 * How the target takes a row of an account it is sent: a business account, a
 * person account, or a person account it takes as a business one — it has no
 * person accounts, or the record type the row gets there is a business
 * account's.
 */
export type AccountKind = 'business' | 'person' | 'personAsBusiness';

/**
 * Whether a row goes without a field for the kind of account it is, as every
 * module that writes accounts leaves it out.
 *
 * A business account goes without every field only a person account holds
 * (`isPersonAccountField`): run into an org with person accounts, a Sync sent
 * them, empty, with each of its 630 business accounts, and the target refused
 * every one — "INVALID_FIELD_FOR_INSERT_UPDATE: bad field names on
 * insert/update call: …__pc, FirstName, LastName". So does a person account the
 * target takes as a business one, which keeps its name: the platform computes
 * none for it, and refused it without one. A person account goes without its
 * `Name`, which the platform computes from its first and last names and
 * refuses from a write ("Unable to create/update fields: Name"). A row of any
 * other object keeps every field.
 */
export function leftOutForAccountKind(
  objectApiName: string,
  field: string,
  kind: AccountKind,
): boolean {
  if (objectApiName !== ACCOUNT) return false;
  if (kind === 'person') return field === 'Name';
  return isPersonAccountField(field);
}

/**
 * The kind of account a field of an account is required of, where the
 * platform requires it of one kind only: a business account's `Name`, a
 * person account's `LastName`. Undefined for any other field, and on any
 * other object.
 *
 * Neither is required by the describe of an org with person accounts: the
 * platform computes a person account's name, and a business account has no
 * last name. Read from the describe alone, a frozen load of such an org asked
 * no default for the names its rules cleared, ignored the one declared, and
 * every business account was refused "REQUIRED_FIELD_MISSING: Required fields
 * are missing: [Name]".
 */
export function accountKindRequiring(
  objectApiName: string,
  field: string,
): 'business' | 'person' | undefined {
  if (objectApiName !== ACCOUNT) return undefined;
  if (field === 'Name') return 'business';
  if (field === 'LastName') return 'person';
  return undefined;
}
