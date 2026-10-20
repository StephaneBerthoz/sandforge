import type { FieldRule, SeedRecordTypeOption } from '@sandforge/shared';
import { accountKindRequiring, leftOutForAccountKind } from '@sandforge/shared';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

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
 * The kind of account an object's records are written as, by the record types
 * chosen, as the extension reads them before the run
 * (`templateForAccountKinds`): person accounts when every type chosen is a
 * person account's; business accounts when none is, or none is chosen.
 * Undefined when the two are mixed, which the run refuses, and when a type
 * chosen is not among those the target offers, whose kind the wizard cannot
 * tell.
 */
function accountKindOfChoice(
  options: readonly SeedRecordTypeOption[],
  chosen: readonly string[],
): 'person' | 'business' | undefined {
  if (recordTypesMixed(options, chosen)) return undefined;
  if (chosen.some((id) => !options.some((option) => option.recordTypeId === id))) return undefined;
  return recordTypesPerson(options, chosen) ? 'person' : 'business';
}

/**
 * An object's fields as the run sends them for the record types chosen: on
 * Account, without the fields the kind of account written does not take
 * (`leftOutForAccountKind`) — no Name on a person account, no first or last
 * name, `Person…` or `__pc` field on a business one — and the name that kind
 * requires marked required. The step listed every field the describe gave,
 * and the extension dropped some before the run: Name was set a rule on a
 * person account that never received it. Any other object, and an Account
 * whose types are mixed, keeps every field.
 *
 * @param chosen - The record types chosen for the object.
 */
export function fieldsForAccountKind(
  config: ObjectFieldConfig,
  chosen: readonly string[],
): ObjectFieldConfig {
  const kind = accountKindOfChoice(config.recordTypes ?? [], chosen);
  if (kind === undefined) return config;
  const object = config.objectApiName;
  return {
    ...config,
    fields: config.fields
      .filter((field) => !leftOutForAccountKind(object, field.fieldApiName, kind))
      .map((field) =>
        !field.required && accountKindRequiring(object, field.fieldApiName) === kind
          ? { ...field, required: true }
          : field,
      ),
  };
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
