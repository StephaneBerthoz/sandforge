/**
 * Target schema alignment: brings every record of the frozen
 * dataset in line with what the TARGET org actually accepts, listing every
 * divergence in the report — never a silent exclusion:
 *
 *   - fields absent from the target describe (or not createable) are
 *     REMOVED and listed;
 *   - fields the target encrypts, of a dataset whose manifest does not say
 *     its extraction left out what it read masked, are REMOVED and listed,
 *     unless the load is told to write them (`leaveOutEncrypted`);
 *   - restricted picklist values inactive at the global level are
 *     cleared/replaced per the DECLARED rule and listed;
 *   - RecordType assignment gaps: a value active globally may be
 *     unassigned to the record's RecordType — invisible to describe, which
 *     the UI API `picklist-values/{recordTypeId}/{field}` tells. Rejected
 *     values follow the same declared rule and are listed with scope
 *     'record-type'. A record type never given values of the field is a gap
 *     the UI API does not see: it answers the field's whole value set for it,
 *     and the record type takes none. The target refuses such a value at
 *     insert, and the loader writes the record again on the declared rule;
 *   - required fields missing from EVERY record the load writes (a lookup
 *     turned required after the source data was created) are
 *     reported for the placeholder pattern; records are never dropped.
 */

import {
  ACCOUNT,
  accountKindRequiring,
  heldToAccountKind,
  leftOutForAccountKind,
  type AccountKind,
} from '../../core/common/platformRecords.js';
import { ENCRYPTED_FIELD_TYPE } from '../sync/encryptedFields.js';
import type { FrozenRecord } from './types.js';
import type {
  FieldRemoval,
  MissingRequiredField,
  PicklistAdjustment,
  PicklistRule,
  SchemaAlignObjectResult,
  TargetObjectDescribe,
  TargetOrgAccess,
} from './loadTypes.js';

/** Inputs of one object's alignment. */
export interface SchemaAlignObjectInput {
  orgId: string;
  objectApiName: string;
  /** Frozen records — RecordTypeId already resolved to a target ID (or absent). */
  records: FrozenRecord[];
  /** Target describe of the object. */
  describe: TargetObjectDescribe;
  /** referenceId → resolved target RecordType ID (records without RT are absent). */
  resolvedRecordTypes: ReadonlyMap<string, string>;
  /** Declared picklist rule lookup (`Object.field` specific, else default). */
  ruleFor: (objectApiName: string, field: string) => PicklistRule;
  /**
   * The records, by referenceId, the load links to what the target already
   * holds and never writes: the standard price book, a selling model found by
   * its natural key, a record a reload reuses. Aligned like the others; left
   * out of the required-field check, which is about what an insert sends.
   */
  linked?: ReadonlySet<string>;
  /**
   * For the accounts, the kind each record goes in as, by referenceId: what
   * it leaves out (`leftOutForAccountKind`) and what it is held to
   * (`accountKindRequiring`). Absent for any other object.
   */
  accountKindOf?: (referenceId: string) => AccountKind;
  /**
   * Leave out the values of the fields the target encrypts, each listed with
   * the records that held one (`may-hold-masks`): the dataset's manifest does
   * not say its extraction left out the encrypted fields its user read
   * masked, and a dataset extracted before it did holds the masks, such as
   * `****1234`, as values a load would write.
   */
  leaveOutEncrypted?: boolean;
}

/** Why a field is removed, as its removal says it. */
type RemovalReason = FieldRemoval['reason'];

/**
 * Aligns dataset records with the target schema. Holds a per-run cache of
 * UI API picklist reads keyed by (object, recordTypeId, field).
 */
export class SchemaAligner {
  private readonly uiApiCache = new Map<string, string[] | null>();

  constructor(private readonly orgAccess: Omit<TargetOrgAccess, 'count'>) {}

  /** Align one object's records against its target describe. */
  async alignObject(input: SchemaAlignObjectInput): Promise<SchemaAlignObjectResult> {
    const fieldsByName = new Map(input.describe.fields.map((f) => [f.name, f]));
    const removalCounts = new Map<string, { reason: RemovalReason; count: number }>();
    const adjustments: PicklistAdjustment[] = [];
    const uiApiWarnings: string[] = [];
    const alignedRecords: Array<Record<string, unknown>> = [];

    for (const record of input.records) {
      const out: Record<string, unknown> = {};
      const kind = input.accountKindOf?.(record.referenceId);
      for (const [field, value] of Object.entries(record.fields)) {
        // What the kind of account the record goes in as cannot hold is the
        // platform's, never the dataset's: a person account's name, computed
        // from its first and last names, and refused from an insert; a
        // business account's person fields, which it holds empty.
        if (kind !== undefined && leftOutForAccountKind(ACCOUNT, field, kind)) continue;
        const fd = fieldsByName.get(field);
        if (!fd) {
          this.countRemoval(removalCounts, field, 'not-in-target');
          continue;
        }
        if (!fd.createable) {
          this.countRemoval(removalCounts, field, 'not-createable');
          continue;
        }
        if (input.leaveOutEncrypted === true && fd.type === ENCRYPTED_FIELD_TYPE) {
          // An empty one writes nothing, mask or not.
          if (value !== null && value !== undefined && value !== '') {
            this.countRemoval(removalCounts, field, 'may-hold-masks');
          }
          continue;
        }
        let aligned = value;
        if (
          typeof aligned === 'string' &&
          aligned !== '' &&
          fd.restrictedPicklist === true &&
          (fd.type === 'picklist' || fd.type === 'multipicklist')
        ) {
          aligned = await this.alignPicklistValue(
            input,
            fd.name,
            fd.type,
            record,
            aligned,
            adjustments,
            uiApiWarnings,
          );
        }
        out[field] = aligned;
      }
      alignedRecords.push(out);
    }

    return {
      objectApiName: input.objectApiName,
      alignedRecords,
      removals: [...removalCounts.entries()].map(([field, r]) => ({
        objectApiName: input.objectApiName,
        field,
        reason: r.reason,
        affectedRecords: r.count,
      })),
      adjustments,
      missingRequired: this.detectMissingRequired(input, alignedRecords),
      uiApiWarnings,
    };
  }

  /**
   * Required-at-insert fields (createable, non-nillable, no platform
   * default) absent from every record the load writes. Reported for the
   * placeholder pattern — partial presence is left to per-record DML
   * outcomes.
   */
  private detectMissingRequired(
    input: SchemaAlignObjectInput,
    alignedRecords: Array<Record<string, unknown>>,
  ): MissingRequiredField[] {
    // A record the load only links is never sent, so what an insert requires
    // says nothing of it. Checked with the others, the selling model a load
    // found by its key made it ask for a default for the name the rules had
    // cleared — and refuse to write anything until one was declared.
    const written = alignedRecords.filter(
      (_, i) => !input.linked?.has(input.records[i].referenceId),
    );
    // "Absent from every record" is only a finding when there is a record.
    // With none, every required field of the object qualified, and the load
    // asked for a default — or created a placeholder in the target — for an
    // object it had nothing to write to.
    if (written.length === 0) return [];
    const missing: MissingRequiredField[] = [];
    // An account's name is required of a business account and its last name
    // of a person account, which an org with person accounts does not
    // describe as required: each is checked on the records of its kind.
    const kindOf = input.accountKindOf;
    const writtenKinds = kindOf
      ? input.records
          .filter((r) => !input.linked?.has(r.referenceId))
          .map((r) => kindOf(r.referenceId))
      : [];
    for (const fd of input.describe.fields) {
      const ofKind = kindOf ? accountKindRequiring(ACCOUNT, fd.name) : undefined;
      if (!fd.createable || (fd.nillable && ofKind === undefined) || fd.defaultedOnCreate) {
        continue;
      }
      const held = written.filter(
        (_, i) => ofKind === undefined || heldToAccountKind(ofKind, writtenKinds[i]),
      );
      if (held.length === 0) continue;
      const present = held.some((r) => {
        const v = r[fd.name];
        return v !== undefined && v !== null && v !== '';
      });
      if (!present) {
        // What a default for it must do: give each record a value of its own
        // for a field the target keeps unique, or for the object's name.
        const distinct = fd.unique ? 'unique' : fd.nameField ? 'name' : undefined;
        missing.push({
          objectApiName: input.objectApiName,
          field: fd.name,
          isLookup: (fd.referenceTo?.length ?? 0) > 0,
          referenceTo: fd.referenceTo ?? [],
          ...(distinct ? { distinct } : {}),
          ...(ofKind ? { accountKind: ofKind } : {}),
        });
      }
    }
    return missing;
  }

  /** Apply the global and record-type picklist checks to one value. */
  private async alignPicklistValue(
    input: SchemaAlignObjectInput,
    fieldName: string,
    fieldType: string,
    record: FrozenRecord,
    value: string,
    adjustments: PicklistAdjustment[],
    uiApiWarnings: string[],
  ): Promise<string> {
    const isMulti = fieldType === 'multipicklist';
    const components = isMulti ? value.split(';') : [value];
    const fd = input.describe.fields.find((f) => f.name === fieldName);
    const activeGlobal = new Set(
      (fd?.picklistValues ?? []).filter((p) => p.active).map((p) => p.value),
    );
    const inactiveGlobal = components.filter((c) => !activeGlobal.has(c));
    if (inactiveGlobal.length > 0) {
      const rule = input.ruleFor(input.objectApiName, fieldName);
      adjustments.push({
        objectApiName: input.objectApiName,
        field: fieldName,
        referenceId: record.referenceId,
        value,
        rule,
        scope: 'global',
      });
      return this.applyRule(rule, components, inactiveGlobal, isMulti);
    }

    // RecordType assignment gap — only visible through the UI API, only when the record carries a resolved RecordType.
    const recordTypeId = input.resolvedRecordTypes.get(record.referenceId);
    if (!recordTypeId) {
      return value;
    }
    const uiValues = await this.uiApiValues(input, recordTypeId, fieldName, uiApiWarnings);
    if (uiValues === null) {
      return value; // read failed — conservative: keep the value, warning listed
    }
    const notAssigned = components.filter((c) => !uiValues.includes(c));
    if (notAssigned.length === 0) {
      return value;
    }
    const rule = input.ruleFor(input.objectApiName, fieldName);
    adjustments.push({
      objectApiName: input.objectApiName,
      field: fieldName,
      referenceId: record.referenceId,
      value,
      rule,
      scope: 'record-type',
    });
    return this.applyRule(rule, components, notAssigned, isMulti);
  }

  /** Cached UI API read — `null` (listed once) when the read fails. */
  private async uiApiValues(
    input: SchemaAlignObjectInput,
    recordTypeId: string,
    fieldName: string,
    uiApiWarnings: string[],
  ): Promise<string[] | null> {
    const key = `${input.orgId}|${input.objectApiName}|${recordTypeId}|${fieldName}`;
    const cached = this.uiApiCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const values = await this.orgAccess.picklistValues(
        input.orgId,
        input.objectApiName,
        recordTypeId,
        fieldName,
      );
      this.uiApiCache.set(key, values);
      return values;
    } catch (err) {
      this.uiApiCache.set(key, null);
      uiApiWarnings.push(
        `UI API picklist-values read failed for ${input.objectApiName}.${fieldName} ` +
          `(recordType ${recordTypeId}): ${err instanceof Error ? err.message : String(err)}. ` +
          'Record-type assignment gap check skipped for this field.',
      );
      return null;
    }
  }

  /** Apply a declared rule: replace the whole field, or clear the rejected value(s). */
  private applyRule(
    rule: PicklistRule,
    components: string[],
    rejected: string[],
    isMulti: boolean,
  ): string {
    if (rule.action === 'replace') {
      return rule.value;
    }
    if (!isMulti) {
      return '';
    }
    return components.filter((c) => !rejected.includes(c)).join(';');
  }

  private countRemoval(
    counts: Map<string, { reason: RemovalReason; count: number }>,
    field: string,
    reason: RemovalReason,
  ): void {
    const entry = counts.get(field);
    if (entry) {
      entry.count++;
    } else {
      counts.set(field, { reason, count: 1 });
    }
  }
}
