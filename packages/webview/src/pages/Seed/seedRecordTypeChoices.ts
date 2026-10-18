import type { FieldRule, SeedRecordTypeOption } from '@sandforge/shared';

/**
 * Whether the record types chosen for an object mix a person account's with
 * a business account's: the two kinds take different fields, a run writes one
 * set, and the extension refuses such a run as the command line does.
 *
 * @param options - The record types the target offers on the object.
 * @param chosen - The ids chosen among them.
 */
export function recordTypesMixed(
  options: readonly SeedRecordTypeOption[],
  chosen: readonly string[],
): boolean {
  const picked = options.filter((option) => chosen.includes(option.recordTypeId));
  return picked.some((option) => option.person) && picked.some((option) => !option.person);
}

/** Whether the record types chosen for an object are all a person account's. */
export function recordTypesPerson(
  options: readonly SeedRecordTypeOption[],
  chosen: readonly string[],
): boolean {
  const picked = options.filter((option) => chosen.includes(option.recordTypeId));
  return picked.length > 0 && picked.every((option) => option.person);
}

/**
 * Whether the wizard offers a choice of record type on an object: two or more
 * open to the user, or a person account's, which writes another kind of
 * account than the user's default may.
 */
export function offersRecordTypes(options: readonly SeedRecordTypeOption[] | undefined): boolean {
  return (options?.length ?? 0) > 1 || (options ?? []).some((option) => option.person);
}

/**
 * The rule that gives an object's records the record types chosen, as the
 * command line's `--record-type` gives it: one type to every record, or
 * several taking turns at random.
 */
export function recordTypeFieldRule(chosen: readonly string[]): FieldRule {
  return chosen.length === 1
    ? {
        fieldApiName: 'RecordTypeId',
        fieldType: 'reference',
        ruleType: 'static',
        config: { staticValue: chosen[0] },
      }
    : {
        fieldApiName: 'RecordTypeId',
        fieldType: 'reference',
        ruleType: 'picklist_random',
        config: { picklistValues: [...chosen] },
      };
}
