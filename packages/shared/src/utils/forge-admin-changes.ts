import type { ForgeGap } from '../types/forge.types.js';
import { forgeGapParts } from './forge-gaps.js';

/**
 * A change to the target's metadata that would let the rows a gap is about go
 * in as they are, made by whoever administers the target — never by a run:
 * - `add_picklist_value`: a value the field's list does not hold, or holds
 *   inactive, added to it (and, of a record type, selected for it);
 * - `select_picklist_value`: a value the field holds, selected for the record
 *   type the rows go in with;
 * - `allow_dependent_value`: a dependent value allowed under the value of its
 *   controlling field;
 * - `make_field_optional`: a field the target requires made optional, or given
 *   a default;
 * - `lengthen_field`: a text field made as long as the longest value;
 * - `widen_number`: a number field given more digits before its point;
 * - `create_record_type`: a record type of the source created in the target;
 * - `install_package`: the package that brings a record type of the source
 *   installed in the target, or upgraded there: a namespaced record type is
 *   its package's to create, and New in Setup would make another one;
 * - `open_record_type`: a record type made available to the user the run
 *   writes as;
 * - `activate_currency`: a currency activated;
 * - `loosen_lookup_filter`: a lookup filter made optional, or widened;
 * - `deactivate_validation_rule`, `deactivate_duplicate_rule`: a rule turned
 *   off, or kept quiet for the user the run writes as;
 * - `grant_create`: Create on the object given to the user the run writes as;
 * - `grant_edit`: Edit given to that user on a record an object hangs from,
 *   which opens an object no permission set gives Create on;
 * - `enable_feature`: the feature or licence an object comes with turned on
 *   for that user, which Modify All Data does not open.
 */
export type ForgeAdminChangeKind =
  | 'add_picklist_value'
  | 'select_picklist_value'
  | 'allow_dependent_value'
  | 'make_field_optional'
  | 'lengthen_field'
  | 'widen_number'
  | 'create_record_type'
  | 'install_package'
  | 'open_record_type'
  | 'activate_currency'
  | 'loosen_lookup_filter'
  | 'deactivate_validation_rule'
  | 'deactivate_duplicate_rule'
  | 'grant_create'
  | 'grant_edit'
  | 'enable_feature';

/** One change to make in the target's metadata, and the gap it answers. */
export interface ForgeAdminChange {
  change: ForgeAdminChangeKind;
  /** The gap it answers (`ForgeGap.id`). */
  gapId: string;
  objectApiName: string;
  field?: string;
  /**
   * What the change is about: a picklist value, a currency code, the source
   * record type's name, a rule's name, the object Edit is given on.
   */
  value?: string;
  /** Of a dependent value, the field whose value decides. */
  controllingField?: string;
  /** Of a package to install, its namespace. */
  namespace?: string;
  /** Of a text, the length of the longest value the rows hold. */
  length?: number;
  /** How many of the run's rows it touches; 0 when read from metadata alone. */
  rows: number;
  /** The step in Setup, in English, as the command line says it. */
  setup: string;
}

/** The changes of one object, and of one of its record types when they hold for one. */
export interface ForgeAdminChangeGroup {
  objectApiName: string;
  /** The target record type's DeveloperName; absent for the object as a whole. */
  recordType?: string;
  changes: ForgeAdminChange[];
}

/** A text of a gap's detail, when it holds one. */
function detailText(gap: ForgeGap, key: string): string | undefined {
  const value = gap.detail?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A number of a gap's detail, when it holds one. */
function detailNumber(gap: ForgeGap, key: string): number | undefined {
  const value = gap.detail?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A rule's name, as its gap says it: in its detail, or in its id. */
function ruleName(gap: ForgeGap): string {
  return (
    detailText(gap, 'developerName') ??
    detailText(gap, 'rule') ??
    gap.value ??
    forgeGapParts(gap.id)?.value ??
    ''
  );
}

/**
 * The namespace a record type's name says, as the host writes one: `ns__Retail`
 * is package `ns`'s Retail, a bare `Retail` the org's own.
 */
function recordTypeNamespace(name: string | undefined): string | undefined {
  const at = name?.indexOf('__') ?? -1;
  return name !== undefined && at > 0 && at < name.length - 2 ? name.slice(0, at) : undefined;
}

/** The step in Setup a change takes, in English. */
function setupOf(change: Omit<ForgeAdminChange, 'setup'>, recordType: string | undefined): string {
  const object = `Setup > Object Manager > ${change.objectApiName}`;
  const field = `${object} > Fields & Relationships > ${change.field ?? ''}`;
  const value = `"${change.value ?? ''}"`;
  const user = `Setup > Users > the profile or a permission set of the user SandForge writes as > Object Settings > ${change.objectApiName}`;
  switch (change.change) {
    case 'add_picklist_value':
      return recordType
        ? `${field} > Values: add or activate ${value}, then select it for record type ${recordType}`
        : `${field} > Values: add or activate ${value}`;
    case 'select_picklist_value':
      return `${object} > Record Types > ${recordType ?? ''} > ${change.field ?? ''} > Edit: add ${value} to the selected values`;
    case 'allow_dependent_value':
      return `${object} > Fields & Relationships > ${change.controllingField ?? ''} > Field Dependencies > Edit: include ${value} of ${change.field ?? ''} under the controlling values it comes with`;
    case 'make_field_optional':
      return `${field} > Edit: untick Required, or give it a default value`;
    case 'lengthen_field':
      return change.length !== undefined
        ? `${field} > Edit: set its length to ${change.length} characters or more`
        : `${field} > Edit: make it longer`;
    case 'widen_number':
      return `${field} > Edit: give it more digits before the decimal point`;
    case 'create_record_type':
      return `${object} > Record Types > New: ${change.value ?? ''}`;
    case 'install_package':
      return `Install or upgrade the package with namespace ${change.namespace ?? ''} in the target: record type ${change.value ?? ''} comes with it, and Setup cannot create it`;
    case 'open_record_type':
      return `${user} > Edit: make record type ${recordType ?? ''} available`;
    case 'activate_currency':
      return `Setup > Company Settings > Manage Currencies: activate ${change.value ?? ''}`;
    case 'loosen_lookup_filter':
      return `${field} > Edit: make its lookup filter optional, or let it take the records the clone names`;
    case 'deactivate_validation_rule':
      return `${object} > Validation Rules > ${change.value ?? ''} > Edit: untick Active, or give the user SandForge writes as the custom permission that bypasses it`;
    case 'deactivate_duplicate_rule':
      return `Setup > Duplicate Rules > ${change.value ?? ''}: deactivate it, or set it to Allow on create`;
    case 'grant_create':
      return `${user} > Edit: tick Create`;
    case 'grant_edit':
      return `Setup > Users > the profile or a permission set of the user SandForge writes as > Object Settings > ${change.value ?? ''} > Edit: tick Read and Edit`;
    case 'enable_feature':
      return `Turn on in the target the feature ${change.objectApiName} comes with, or assign the user SandForge writes as the permission set licence that includes it; then ${user} > Edit: tick Create`;
  }
}

/** The texts a gap's detail holds under `key`, when it holds a list of them. */
function detailTexts(gap: ForgeGap, key: string): string[] {
  const value = gap.detail?.[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : [];
}

/**
 * What a gap asks of the target's metadata: one change, several — Edit on
 * each record an object hangs from — or none when no metadata change cures it.
 */
function changesOf(gap: ForgeGap): Array<Omit<ForgeAdminChange, 'setup'>> {
  const base = {
    gapId: gap.id,
    objectApiName: gap.objectApiName,
    rows: gap.rows,
  };
  switch (gap.kind) {
    case 'object_through_parent':
      // No Object Settings page holds the object: asked to tick Create on an
      // opportunity's products, the admin found none to tick.
      return detailTexts(gap, 'editOn').map((parent) => ({
        ...base,
        value: parent,
        change: 'grant_edit' as const,
      }));
    case 'object_feature_off':
      return [{ ...base, change: 'enable_feature' }];
    default: {
      const change = changeOf(gap);
      return change ? [change] : [];
    }
  }
}

/** What a gap asks of the target's metadata, or undefined when no metadata change cures it. */
function changeOf(gap: ForgeGap): Omit<ForgeAdminChange, 'setup'> | undefined {
  const base = {
    gapId: gap.id,
    objectApiName: gap.objectApiName,
    ...(gap.field !== undefined ? { field: gap.field } : {}),
    rows: gap.rows,
  };
  const value = gap.value !== undefined ? { value: gap.value } : {};
  switch (gap.kind) {
    case 'picklist_value_refused': {
      const controllingField = detailText(gap, 'controllingField');
      if (detailText(gap, 'reason') === 'controlling-value' && controllingField) {
        return { ...base, ...value, change: 'allow_dependent_value', controllingField };
      }
      return {
        ...base,
        ...value,
        change:
          detailText(gap, 'reason') === 'record-type' && gap.recordType !== undefined
            ? 'select_picklist_value'
            : 'add_picklist_value',
      };
    }
    case 'dependent_value_invalid': {
      const controllingField = detailText(gap, 'controllingField');
      return {
        ...base,
        ...value,
        change: 'allow_dependent_value',
        ...(controllingField ? { controllingField } : {}),
      };
    }
    case 'required_field_missing':
      // Left out by the user's own decision: taking the decision back cures it.
      return detailText(gap, 'reason') === 'excluded'
        ? undefined
        : { ...base, change: 'make_field_optional' };
    case 'value_too_long': {
      const longest = detailNumber(gap, 'longest');
      return {
        ...base,
        change: 'lengthen_field',
        ...(longest !== undefined ? { length: longest } : {}),
      };
    }
    case 'number_out_of_range':
      return { ...base, change: 'widen_number' };
    case 'record_type_unmapped': {
      const namespace = recordTypeNamespace(gap.value);
      return namespace !== undefined
        ? { ...base, ...value, namespace, change: 'install_package' }
        : { ...base, ...value, change: 'create_record_type' };
    }
    case 'record_type_unavailable':
      return { ...base, change: 'open_record_type' };
    case 'currency_inactive':
      return { ...base, ...value, change: 'activate_currency' };
    case 'lookup_filter':
      return { ...base, change: 'loosen_lookup_filter' };
    case 'validation_rule':
      return { ...base, value: ruleName(gap), change: 'deactivate_validation_rule' };
    case 'duplicate_rule':
      return { ...base, value: ruleName(gap), change: 'deactivate_duplicate_rule' };
    case 'object_not_createable':
      return { ...base, change: 'grant_create' };
    default:
      // A value already in the target, the day's API requests, what a
      // rehearsal saw refused for a reason no read named, a value that goes in
      // inactive: no change of its metadata says what to do.
      return undefined;
  }
}

/**
 * The changes to the target's metadata that would let the rows go in as they
 * are, for whoever administers the target: one per gap that refuses rows or
 * changes them and that a change of the target's metadata cures — a picklist
 * value a record type refuses, a field it requires, a record type closed to
 * the user the run writes as, a rule — grouped by object, then record type,
 * each with its step in Setup. A gap that refuses nothing is left out. Shown,
 * and never made: SandForge does not change the target's metadata.
 *
 * Changing it for the clone is the admin's to decide. The Gaps tab gave each
 * gap with the decisions a run can take about it, and nothing an admin could
 * act on: which value to add to which record type, which rule to turn off.
 */
export function adminChangesOf(gaps: readonly ForgeGap[]): ForgeAdminChangeGroup[] {
  const groups = new Map<string, ForgeAdminChangeGroup>();
  for (const gap of gaps) {
    if (gap.severity === 'info') continue;
    const changes = changesOf(gap);
    if (changes.length === 0) continue;
    const recordType = gap.recordType;
    const key = `${gap.objectApiName}|${recordType ?? ''}`;
    const group = groups.get(key) ?? {
      objectApiName: gap.objectApiName,
      ...(recordType !== undefined ? { recordType } : {}),
      changes: [],
    };
    for (const change of changes)
      group.changes.push({ ...change, setup: setupOf(change, recordType) });
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.objectApiName.localeCompare(b.objectApiName) ||
        (a.recordType ?? '').localeCompare(b.recordType ?? ''),
    )
    .map((group) => ({
      ...group,
      changes: group.changes.sort(
        (a, b) =>
          (a.field ?? '').localeCompare(b.field ?? '') ||
          (a.value ?? '').localeCompare(b.value ?? '') ||
          a.change.localeCompare(b.change),
      ),
    }));
}
