import type {
  SubjectIdentifierKind,
  SubjectIdentifiers,
  SubjectRecord,
  SubjectSearchObject,
  SubjectSearchedField,
} from '@sandforge/shared';
import { phoneDigits, SUBJECT_PHONE_MATCH_DIGITS } from '@sandforge/shared';

import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { describedObjectSchema } from './DataQualityScanner.js';
import type { DescribedField } from './DataQualityScanner.js';
import type { OrgSession } from './RecordRemoval.js';
import { isRecordId } from './RecordRemoval.js';
import { subjectSearchFields } from './personalDataFields.js';

/** What a subject search is asked. */
export interface SubjectSearchRequest {
  objects: string[];
  identifiers: SubjectIdentifiers;
  /** Records listed per object, at most. */
  limit: number;
}

/**
 * The digits a phone search compares: the last ones typed. A number is stored
 * as it was typed, with or without its country code, so two spellings of one
 * line share their last digits and little else.
 */
export function phoneTail(phone: string): string {
  return phoneDigits(phone).slice(-SUBJECT_PHONE_MATCH_DIGITS);
}

/**
 * A `LIKE` pattern that matches the tail however the number is punctuated:
 * each digit, in order, with anything between. The org cannot strip spaces
 * and dots from a phone field, so it is asked for a superset, and each record
 * it returns is compared digit by digit before it is listed.
 */
export function phoneLikePattern(tail: string): string {
  return `%${tail.split('').join('%')}%`;
}

/** A field searched, and the condition that finds the identifier in it. */
interface Condition {
  field: DescribedField;
  kind: SubjectIdentifierKind;
  soql: string;
  matches: (value: unknown) => boolean;
}

/** Text compared the way the org compares it with `=`: whatever the case. */
function sameText(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === expected.trim().toLowerCase();
}

/** The condition that finds `identifiers` in one field, when the field is searched for them. */
function conditionFor(
  field: DescribedField,
  kind: SubjectIdentifierKind,
  identifiers: SubjectIdentifiers,
): Condition | undefined {
  const name = assertSoqlIdentifier(field.name);
  if (kind === 'email' && identifiers.email) {
    const email = identifiers.email.trim();
    return {
      field,
      kind,
      soql: `${name} = '${sanitizeSoqlValue(email)}'`,
      matches: (value) => sameText(value, email),
    };
  }
  if (kind === 'phone' && identifiers.phone) {
    const tail = phoneTail(identifiers.phone);
    return {
      field,
      kind,
      soql: `${name} LIKE '${phoneLikePattern(tail)}'`,
      matches: (value) => typeof value === 'string' && phoneDigits(value).includes(tail),
    };
  }
  if (kind === 'name' && identifiers.name) {
    const person = identifiers.name.trim();
    return {
      field,
      kind,
      soql: `${name} = '${sanitizeSoqlValue(person)}'`,
      matches: (value) => sameText(value, person),
    };
  }
  return undefined;
}

/** Search one object. A describe or a query the org refuses fails the object, not the search. */
async function searchObject(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  requested: string,
  request: SubjectSearchRequest,
): Promise<SubjectSearchObject> {
  try {
    const described = describedObjectSchema.parse(
      await conn.describe(assertSoqlIdentifier(requested)),
    );
    const objectApiName = assertSoqlIdentifier(described.name);
    if (described.queryable === false) throw new Error(`${objectApiName} cannot be queried.`);

    const conditions = subjectSearchFields(described).flatMap(({ field, kind }) => {
      const condition = conditionFor(field, kind, request.identifiers);
      return condition ? [condition] : [];
    });
    if (conditions.length === 0) {
      return { status: 'skipped', objectApiName: requested, label: described.label };
    }
    const searched: SubjectSearchedField[] = conditions.map((c) => ({
      fieldApiName: c.field.name,
      label: c.field.label,
      kind: c.kind,
    }));
    const where = conditions.map((c) => c.soql).join(' OR ');

    // Counted first: an object that holds none of it costs one query that
    // returns no record.
    const counted = (await conn.query(`SELECT COUNT() FROM ${objectApiName} WHERE ${where}`))
      .totalSize;
    if (counted === 0) {
      return {
        status: 'searched',
        objectApiName: requested,
        label: described.label,
        counted,
        records: [],
        truncated: false,
        searched,
      };
    }

    const nameField = described.fields.find((f) => f.nameField === true);
    const columns = [
      ...new Set([
        'Id',
        ...(nameField ? [nameField.name] : []),
        ...conditions.map((c) => c.field.name),
      ]),
    ].map(assertSoqlIdentifier);
    const answer = await conn.query(
      `SELECT ${columns.join(', ')} FROM ${objectApiName} WHERE ${where} ` +
        `ORDER BY Id LIMIT ${request.limit}`,
    );
    const records: SubjectRecord[] = [];
    for (const raw of answer.records) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      if (!isRecordId(record.Id)) continue;
      const matchedBy = [
        ...new Set(
          conditions.filter((c) => c.matches(record[c.field.name])).map((c) => c.field.name),
        ),
      ];
      // A phone pattern lets through numbers that hold the digits apart; the
      // digit comparison leaves them out.
      if (matchedBy.length === 0) continue;
      const name = nameField ? record[nameField.name] : null;
      records.push({
        id: record.Id,
        name: typeof name === 'string' ? name : null,
        matchedBy,
      });
    }
    return {
      status: 'searched',
      objectApiName: requested,
      label: described.label,
      counted,
      records,
      truncated: counted > request.limit,
      searched,
    };
  } catch (err: unknown) {
    return {
      status: 'failed',
      objectApiName: requested,
      message: withoutIdentifiers(extractErrorMessage(err), request.identifiers),
    };
  }
}

/**
 * An error message with the identifiers searched for taken out. The org
 * quotes the query it refuses, and the query holds them; the message goes on
 * to the page and to whatever the page does with it.
 */
export function withoutIdentifiers(message: string, identifiers: SubjectIdentifiers): string {
  let cleaned = message;
  for (const value of [identifiers.email, identifiers.name, identifiers.phone]) {
    const needle = value?.trim();
    if (!needle) continue;
    cleaned = cleaned.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '…');
  }
  return cleaned;
}

/**
 * Find the records of `request.objects` that hold one person's email address,
 * name or phone number.
 *
 * An address is looked for in the object's email fields and a number in its
 * phone fields, by the type the org gives them; a name in the record's name
 * field. Each object is counted first (`SELECT COUNT()`), and only an object
 * that holds something is read, up to `request.limit` records by Id. A search
 * that matched more says so: only the records listed can be exported or erased.
 *
 * @param conn - The org.
 * @param request - The objects, the identifiers, and the bound.
 */
export async function searchSubject(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  request: SubjectSearchRequest,
): Promise<SubjectSearchObject[]> {
  const objects: SubjectSearchObject[] = [];
  for (const objectApiName of request.objects) {
    objects.push(await searchObject(conn, objectApiName, request));
  }
  return objects;
}
