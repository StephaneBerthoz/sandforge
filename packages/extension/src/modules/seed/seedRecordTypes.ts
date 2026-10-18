/**
 * The record types a seed from the panel gives an object's records, and what
 * a person account's type changes about the accounts it writes — the rules
 * the command line has followed since `--record-type` (`sandforge-seed`).
 *
 * The panel offered no record type: every record took the running user's
 * default, and person accounts could be seeded from the command line only.
 * Run into an org with person accounts, its accounts were sent with every
 * field the describe gave, a person's and a company's at once, and the org
 * refused them.
 *
 * A record type is given by a `RecordTypeId` rule, as the command line gives
 * it: one type to every record, or several taking turns. Accounts given person
 * account types are written as person accounts — without `Name`, which the
 * platform builds from the first and last names and refuses from a write;
 * accounts given none, or business types, as business accounts — without any
 * field only a person account holds (`leftOutForAccountKind`). A person type
 * and a business type together are refused: the two kinds take different
 * fields, and a run writes one set.
 */

import type { SeedRecordTypeOption, SeedTemplate } from '@sandforge/shared';

import { ACCOUNT, leftOutForAccountKind } from '../../core/common/platformRecords.js';
import { parseRecordTypeInfos } from '../../core/metadata/recordTypeAvailability.js';

/** The org's person account record types. */
const PERSON_TYPES_SOQL =
  "SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true";

/** A person account record type of the org. */
export interface PersonRecordType {
  id: string;
  developerName: string;
}

/**
 * The org's person account record types: none when it has no person accounts
 * — such an org has no `IsPersonType`, and refuses the read.
 */
export async function personRecordTypes(conn: {
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}): Promise<PersonRecordType[]> {
  try {
    const answer = await conn.query(PERSON_TYPES_SOQL);
    return answer.records.flatMap((row) =>
      typeof row.Id === 'string' && typeof row.DeveloperName === 'string'
        ? [{ id: row.Id, developerName: row.DeveloperName }]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * The record types a seed can give an object's records: those of its describe
 * that are active and open to the running user, never the master; on Account,
 * a person account's marked.
 *
 * @param recordTypeInfos - The object's describe's `recordTypeInfos`.
 * @param personTypes - The org's person account record types.
 */
export function seedRecordTypeOptions(
  objectApiName: string,
  recordTypeInfos: unknown,
  personTypes: readonly PersonRecordType[],
): SeedRecordTypeOption[] {
  const persons = new Set(
    objectApiName === ACCOUNT ? personTypes.map((type) => type.id.slice(0, 15)) : [],
  );
  return parseRecordTypeInfos(recordTypeInfos)
    .filter((info) => !info.master && info.active && info.available)
    .map((info) => ({
      recordTypeId: info.recordTypeId,
      developerName: info.developerName,
      label: info.name,
      person: persons.has(info.recordTypeId.slice(0, 15)),
      isDefault: info.defaultRecordTypeMapping,
    }));
}

/** The record type ids a field rule gives a record: one, or several taking turns. */
function recordTypeIdsOf(rule: SeedTemplate['objects'][number]['fieldRules'][number]): string[] {
  const { staticValue, picklistValues } = rule.config;
  if (rule.ruleType === 'static' && typeof staticValue === 'string') return [staticValue];
  if (rule.ruleType === 'picklist_random') return [...(picklistValues ?? [])];
  return [];
}

/**
 * The template as the org takes its accounts, or why it cannot: each Account
 * object written as the kind its record types give it, without the fields the
 * other kind holds. Nothing changes in an org without person accounts, whose
 * accounts hold no person's field.
 *
 * @param personTypes - The org's person account record types; none when it
 *   has no person accounts.
 */
export function templateForAccountKinds(
  template: SeedTemplate,
  personTypes: readonly PersonRecordType[],
): { template: SeedTemplate; personObjects: string[] } | { refusal: string } {
  if (personTypes.length === 0) return { template, personObjects: [] };
  const persons = new Map(personTypes.map((type) => [type.id.slice(0, 15), type.developerName]));
  const personObjects: string[] = [];
  const objects: SeedTemplate['objects'] = [];
  for (const object of template.objects) {
    if (object.objectApiName !== ACCOUNT) {
      objects.push(object);
      continue;
    }
    const typed = object.fieldRules.find((rule) => rule.fieldApiName === 'RecordTypeId');
    const ids = typed ? recordTypeIdsOf(typed) : [];
    const personIds = ids.filter((id) => persons.has(id.slice(0, 15)));
    if (personIds.length > 0 && personIds.length < ids.length) {
      const named = personIds.map((id) => persons.get(id.slice(0, 15))).join(', ');
      return {
        refusal:
          `${ACCOUNT}: ${named} ${personIds.length === 1 ? 'is a person account record type' : 'are person account record types'} ` +
          'and the other record types chosen are not: a person account and a business account ' +
          'take different fields. Seed one kind in a run.',
      };
    }
    const kind = personIds.length > 0 ? 'person' : 'business';
    if (kind === 'person') personObjects.push(object.objectApiName);
    objects.push({
      ...object,
      fieldRules: object.fieldRules.filter(
        (rule) => !leftOutForAccountKind(ACCOUNT, rule.fieldApiName, kind),
      ),
    });
  }
  return { template: { ...template, objects }, personObjects };
}
