/**
 * The decisions a run's config holds about what the target would refuse or
 * change in its rows — taken on Review's Gaps tab, kept in templates — applied
 * once to each row before it is written, in a simulation as in a real run, and
 * counted for the run's summary.
 *
 * - A picklist value written as another (`picklistValueMappings`), or left
 *   out (`to: null`), for every row of the object or for the rows that go in
 *   with one record type of the target.
 * - A value given to a field the row leaves empty (`defaultValues`).
 * - A text cut to the length the target's field holds (`truncateFields`).
 * - A source record type written as a target one, or as the object's default
 *   (`recordTypeMappings`): resolved to ids once a run, by
 *   {@link recordTypeDecisionMappings}, and applied with the run's own mapping.
 *
 * What the run leaves out by name (`excludedObjects`) goes with the objects
 * the user unchecked, and the gaps the user chose to leave (`ignoredGaps`)
 * change no write: a simulation reports them still, marked ignored.
 */

import type {
  ForgeConfig,
  ForgeDecisionApplied,
  ForgeDefaultValue,
  ForgePicklistValueMapping,
  ForgeRecordTypeMapping,
} from '@sandforge/shared';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';
import type { RecordTypeAvailability } from '../../../core/metadata/recordTypeAvailability.js';

/** The decisions of a run's config, as the executor is handed them. */
export type ForgeRunDecisions = Pick<
  ForgeConfig,
  | 'picklistValueMappings'
  | 'recordTypeMappings'
  | 'defaultValues'
  | 'truncateFields'
  | 'ignoredGaps'
>;

/** Whether a row leaves a field empty: absent, null, or an empty text. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The rows each decision changed, by what it did, in the order first met: the
 * run's summary says each once, with its count.
 */
export class DecisionTally {
  private readonly entries = new Map<string, ForgeDecisionApplied>();

  /** How many decisions changed a row. */
  get size(): number {
    return this.entries.size;
  }

  /** Count one row a decision changed. */
  add(applied: Omit<ForgeDecisionApplied, 'rows'>, rows = 1): void {
    const key = [
      applied.kind,
      applied.objectApiName,
      applied.field ?? '',
      applied.recordType ?? '',
      applied.from ?? '',
      applied.to ?? '',
    ].join('\u0000');
    const known = this.entries.get(key);
    if (known) {
      known.rows += rows;
      return;
    }
    this.entries.set(key, { ...applied, rows });
  }

  /** The decisions applied, each with the rows it changed. */
  list(): ForgeDecisionApplied[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}

/** The decisions of a run, indexed by object for the rows written. */
export class RunDecisions {
  private readonly picklists = new Map<string, ForgePicklistValueMapping[]>();
  private readonly defaults = new Map<string, ForgeDefaultValue[]>();
  private readonly truncated = new Map<string, Set<string>>();
  /** The gaps the user chose to leave as they are, by id. */
  readonly ignoredGaps: ReadonlySet<string>;

  constructor(decisions: ForgeRunDecisions | undefined) {
    for (const mapping of decisions?.picklistValueMappings ?? []) {
      const list = this.picklists.get(mapping.object) ?? [];
      list.push(mapping);
      this.picklists.set(mapping.object, list);
    }
    for (const value of decisions?.defaultValues ?? []) {
      const list = this.defaults.get(value.object) ?? [];
      list.push(value);
      this.defaults.set(value.object, list);
    }
    for (const { object, field } of decisions?.truncateFields ?? []) {
      const fields = this.truncated.get(object) ?? new Set<string>();
      fields.add(field);
      this.truncated.set(object, fields);
    }
    this.ignoredGaps = new Set(decisions?.ignoredGaps ?? []);
  }

  /** Whether any decision may change a row of `objectApiName` before its picklists are checked. */
  changesRowsOf(objectApiName: string): boolean {
    return this.picklists.has(objectApiName) || this.defaults.has(objectApiName);
  }

  /**
   * Apply to one cleaned row of `objectApiName` the picklist mappings that hold
   * for it, then the defaults of the fields it leaves empty. Changes `row` in
   * place, before its picklist values are checked: a value mapped to one the
   * target still refuses is caught there as any other.
   *
   * A mapping scoped to a record type holds for the rows that go in with it,
   * by its DeveloperName; one with none, for every row. A multi-select value
   * is mapped one selection at a time.
   *
   * @param recordType - The DeveloperName of the target record type the row
   *   goes in with, when the run knows it.
   * @param tally - Where each row changed is counted.
   */
  applyToRow(
    objectApiName: string,
    row: Record<string, unknown>,
    recordType: string | undefined,
    tally: DecisionTally,
  ): void {
    for (const mapping of this.picklists.get(objectApiName) ?? []) {
      if (mapping.recordType !== undefined && mapping.recordType !== recordType) continue;
      const value = row[mapping.field];
      if (typeof value !== 'string' || value === '') continue;
      const parts = value.split(';');
      if (!parts.includes(mapping.from)) continue;
      const kept = parts.flatMap((part) =>
        part !== mapping.from ? [part] : mapping.to === null ? [] : [mapping.to],
      );
      if (kept.length === 0) delete row[mapping.field];
      else row[mapping.field] = [...new Set(kept)].join(';');
      tally.add({
        kind: mapping.to === null ? 'leave_empty' : 'map_value',
        objectApiName,
        field: mapping.field,
        ...(mapping.recordType !== undefined ? { recordType: mapping.recordType } : {}),
        from: mapping.from,
        ...(mapping.to !== null ? { to: mapping.to } : {}),
      });
    }
    for (const { field, value } of this.defaults.get(objectApiName) ?? []) {
      if (!isEmpty(row[field])) continue;
      row[field] = value;
      tally.add({ kind: 'set_default', objectApiName, field, to: String(value) });
    }
  }

  /**
   * Cut, in a payload about to be written, each text the user chose to cut to
   * the length its field holds in the target. Changes `payload` in place.
   *
   * @param lengths - The most characters each field takes in the target, by name.
   */
  truncate(
    objectApiName: string,
    payload: Record<string, unknown>,
    lengths: ReadonlyMap<string, number>,
    tally: DecisionTally,
  ): void {
    for (const field of this.truncated.get(objectApiName) ?? []) {
      const value = payload[field];
      const length = lengths.get(field);
      if (typeof value !== 'string' || length === undefined || length <= 0) continue;
      if (value.length <= length) continue;
      payload[field] = value.slice(0, length);
      tally.add({ kind: 'truncate', objectApiName, field });
    }
  }

  /** The fields of `objectApiName` the user chose to cut. */
  truncatedFieldsOf(objectApiName: string): ReadonlySet<string> {
    return this.truncated.get(objectApiName) ?? new Set<string>();
  }
}

/** The record types of one object in both orgs, as their describes give them. */
export interface RecordTypesOfAnObject {
  readonly objectApiName: string;
  readonly source: readonly RecordTypeAvailability[];
  readonly target: readonly RecordTypeAvailability[];
}

/** What the record type decisions of a run come to, in ids. */
export interface RecordTypeDecisionMappings {
  /** Source to target record type, by id: added to, or put over, the run's own mapping. */
  readonly mappings: RecordTypeMapping[];
  /**
   * The decision each source record type a decision names is under, by its
   * id: `to: null` sends its rows to the object's default, written without
   * `RecordTypeId`, which the platform gives the running user's.
   */
  readonly bySource: ReadonlyMap<string, ForgeRecordTypeMapping>;
  /** The decisions that could not be applied, and why: said once, as notes of the run. */
  readonly unresolved: Array<{ decision: ForgeRecordTypeMapping; reason: string }>;
}

/**
 * The ids the record type decisions of a run name, from the record types of
 * each object in both orgs. A decision whose source record type the source
 * does not have, or whose target one the target does not have, is not
 * applied, and says why.
 */
export function recordTypeDecisionMappings(
  decisions: readonly ForgeRecordTypeMapping[],
  recordTypes: readonly RecordTypesOfAnObject[],
): RecordTypeDecisionMappings {
  const byObject = new Map(recordTypes.map((types) => [types.objectApiName, types]));
  const mappings: RecordTypeMapping[] = [];
  const bySource = new Map<string, ForgeRecordTypeMapping>();
  const unresolved: Array<{ decision: ForgeRecordTypeMapping; reason: string }> = [];
  for (const decision of decisions) {
    const types = byObject.get(decision.object);
    const source = types?.source.find((t) => t.developerName === decision.from && !t.master);
    if (!source) {
      unresolved.push({
        decision,
        reason: `the source has no ${decision.object} record type named ${decision.from}`,
      });
      continue;
    }
    if (decision.to === null) {
      bySource.set(source.recordTypeId, decision);
      continue;
    }
    const target = types?.target.find((t) => t.developerName === decision.to && !t.master);
    if (!target) {
      unresolved.push({
        decision,
        reason: `the target has no ${decision.object} record type named ${decision.to}`,
      });
      continue;
    }
    bySource.set(source.recordTypeId, decision);
    mappings.push({
      sourceId: source.recordTypeId,
      targetId: target.recordTypeId,
      developerName: target.developerName,
    });
  }
  return { mappings, bySource, unresolved };
}

/**
 * The run's record type mapping with its decisions over it: a source record
 * type a decision names goes where the decision says, whatever the names
 * matched; those sent to the object's default leave the mapping.
 *
 * @param base - The mapping matched by DeveloperName, when it was read.
 */
export function withRecordTypeDecisions(
  base: readonly RecordTypeMapping[] | undefined,
  decided: RecordTypeDecisionMappings,
): RecordTypeMapping[] | undefined {
  if (decided.bySource.size === 0) return base ? [...base] : undefined;
  return [...(base ?? []).filter((m) => !decided.bySource.has(m.sourceId)), ...decided.mappings];
}
