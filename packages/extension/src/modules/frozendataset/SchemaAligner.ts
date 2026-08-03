/**
 * Target schema alignment (spec §6): brings every record of the frozen
 * dataset in line with what the TARGET org actually accepts, listing every
 * divergence in the report — never a silent exclusion:
 *
 *   - fields absent from the target describe (or not createable) are
 *     REMOVED and listed;
 *   - restricted picklist values inactive at the global level are
 *     cleared/replaced per the DECLARED rule and listed;
 *   - RecordType assignment gaps (spec pitfall 2): a value active
 *     globally may be unassigned to the record's RecordType — invisible
 *     to describe, only the UI API `picklist-values/{recordTypeId}/{field}`
 *     sees it. Rejected values follow the same declared rule and are
 *     listed with scope 'record-type';
 *   - required fields missing from EVERY record (spec pitfall 3 — a
 *     lookup turned required after the source data was created) are
 *     reported for the placeholder pattern; records are never dropped.
 */

import type { FrozenRecord } from './types.js';
import type {
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
}

/**
 * Aligns dataset records with the target schema. Holds a per-run cache of
 * UI API picklist reads keyed by (object, recordTypeId, field).
 */
export class SchemaAligner {
  private readonly uiApiCache = new Map<string, string[] | null>();

  constructor(private readonly orgAccess: TargetOrgAccess) {}

  /** Align one object's records against its target describe. */
  async alignObject(input: SchemaAlignObjectInput): Promise<SchemaAlignObjectResult> {
    const fieldsByName = new Map(input.describe.fields.map((f) => [f.name, f]));
    const removalCounts = new Map<
      string,
      { reason: 'not-in-target' | 'not-createable'; count: number }
    >();
    const adjustments: PicklistAdjustment[] = [];
    const uiApiWarnings: string[] = [];
    const alignedRecords: Array<Record<string, unknown>> = [];

    for (const record of input.records) {
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(record.fields)) {
        const fd = fieldsByName.get(field);
        if (!fd) {
          this.countRemoval(removalCounts, field, 'not-in-target');
          continue;
        }
        if (!fd.createable) {
          this.countRemoval(removalCounts, field, 'not-createable');
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
   * default) absent from every record. Reported for the placeholder
   * pattern — partial presence is left to per-record DML outcomes.
   */
  private detectMissingRequired(
    input: SchemaAlignObjectInput,
    alignedRecords: Array<Record<string, unknown>>,
  ): MissingRequiredField[] {
    const missing: MissingRequiredField[] = [];
    for (const fd of input.describe.fields) {
      if (!fd.createable || fd.nillable || fd.defaultedOnCreate) {
        continue;
      }
      const present = alignedRecords.some((r) => {
        const v = r[fd.name];
        return v !== undefined && v !== null && v !== '';
      });
      if (!present) {
        missing.push({
          objectApiName: input.objectApiName,
          field: fd.name,
          isLookup: (fd.referenceTo?.length ?? 0) > 0,
          referenceTo: fd.referenceTo ?? [],
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

    // RecordType assignment gap (spec pitfall 2) — only visible through the
    // UI API, only when the record carries a resolved RecordType.
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
    counts: Map<string, { reason: 'not-in-target' | 'not-createable'; count: number }>,
    field: string,
    reason: 'not-in-target' | 'not-createable',
  ): void {
    const entry = counts.get(field);
    if (entry) {
      entry.count++;
    } else {
      counts.set(field, { reason, count: 1 });
    }
  }
}
