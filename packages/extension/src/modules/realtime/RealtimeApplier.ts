import type {
  AddOnField,
  ConflictStrategy,
  FieldMapping,
  FieldResolution,
  RealTimeEventOutcome,
  SyncObjectConfig,
  TransformRule,
} from '@sandforge/shared';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { lookupsThePlatformFills } from '../../core/common/platformRecords.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import { FieldMappingService } from '../sync/FieldMapping.js';
import { TransformPipeline } from '../sync/TransformPipeline.js';
import type { ChangeEvent } from './changeEvent.js';

/** How the changes of one object are written to the target. */
export interface ApplyPlan {
  /** API name of the object. */
  objectApiName: string;
  /** Target field a record is found by: `Id`, or an external id field. */
  keyField: string;
  /** Source field the key is read from; `Id` is the source record's own id. */
  keySource: string;
  /** Field mappings of a saved Sync configuration; none copies fields by name. */
  fieldMappings: FieldMapping[];
  /** Add-on fields of that configuration. */
  addOnFields: AddOnField[];
  /** Object-level transform rules of that configuration. */
  transformRules: TransformRule[];
  /** Whether a record deleted in the source is deleted in the target. */
  applyDeletes: boolean;
}

/** One field of a describe, as far as real-time replication reads it. */
export interface DescribedField {
  name: string;
  type?: string;
  createable?: boolean;
  updateable?: boolean;
  /** Offered as a key the target record can be found by. */
  externalId?: boolean;
}

/** Reads one org. */
export interface OrgReader {
  /**
   * Every record a SOQL query returns, every page of it. `includeDeleted`
   * reads the recycle bin too.
   */
  query(soql: string, options?: { includeDeleted?: boolean }): Promise<Record<string, unknown>[]>;
  /** The fields of an object. */
  describe(objectApiName: string): Promise<{ fields: DescribedField[] }>;
}

/** Sync's write path, record by record (`DataSync.write`). */
export type TargetWrite = (
  config: SyncObjectConfig,
  records: Record<string, unknown>[],
) => Promise<{ outcomes: OperationOutcome[]; notes: string[] }>;

/**
 * The records a session wrote, with the `LastModifiedDate` its write left on
 * each. An edit of the target newer than a change is a collision — unless it is
 * the session's own write of an earlier change to the same record, which is
 * what two quick edits of one source record look like from here.
 */
export class OwnWriteLedger {
  private readonly stamps = new Map<string, number>();

  /** @param capacity - Most records remembered; the oldest go first. */
  constructor(private readonly capacity = 10_000) {}

  /** Remember that the session's write left `recordId` last modified at `lastModified`. */
  record(recordId: string, lastModified: number): void {
    this.stamps.delete(recordId);
    this.stamps.set(recordId, lastModified);
    if (this.stamps.size > this.capacity) {
      const oldest = this.stamps.keys().next().value;
      if (oldest !== undefined) this.stamps.delete(oldest);
    }
  }

  /** Whether the last modification of `recordId` at `lastModified` was the session's own. */
  wrote(recordId: string, lastModified: number): boolean {
    return this.stamps.get(recordId) === lastModified;
  }
}

/** Dependencies of a {@link RealtimeApplier}. */
export interface ApplierDeps {
  /** The org the changes come from. */
  source: OrgReader;
  /** The org they are written to. */
  target: OrgReader;
  /** Sync's write path to the target. */
  write: TargetWrite;
  /** What a collision with a newer target edit comes to. */
  conflictStrategy: ConflictStrategy;
  /** The session's own writes. */
  ownWrites: OwnWriteLedger;
}

/** What became of one change event. */
export interface EventResult {
  outcome: RealTimeEventOutcome;
  error?: string;
}

/** A change held back for a decision, because the target record was edited after it. */
export interface HeldChange {
  /** How the webview names it: `${objectApiName}:${recordId}:${replayId}`. */
  conflictId: string;
  objectApiName: string;
  /** The source record. */
  recordId: string;
  replayId: number;
  changeType: string;
  kind: 'upsert' | 'delete';
  /** What the change would write, the key included. */
  record: Record<string, unknown>;
  /** The target record. */
  targetId: string;
  /** What the target holds for the same fields. */
  targetValues: Record<string, unknown>;
  /** When the target record was last edited, ISO. */
  targetLastModified: string;
}

/** What resolving a held change did. */
export interface Resolution {
  success: boolean;
  /** What was written, key included; empty when nothing was. */
  resolvedValues: Record<string, unknown>;
  error?: string;
}

/**
 * Records per `IN (...)` read and per write: a `FIELDS(ALL)` query returns at
 * most 200 rows, and an sObject Collections call takes at most 200 records.
 */
const READ_CHUNK = 200;

/** Describe types whose values are written into SOQL unquoted. */
const NUMERIC_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);

const OVERFLOW_ERROR =
  'The org sent an overflow notice instead of this change: one transaction changed more ' +
  'records than change events carry. A Sync run brings the target up to date.';

/** One source record's share of the events of a flush. */
interface Change {
  recordId: string;
  /** The events it stands for, by index in the flush. */
  eventIndexes: number[];
  changeType: string;
  /** Its values hold the whole record (a creation or a restore). */
  full: boolean;
  /** A GAP event: the org sent no values, so the record is read back. */
  needsRead: boolean;
  values: Record<string, unknown>;
  /** Earliest commit of the events it stands for. */
  commitTimestamp: number;
  /** Latest replay id of the events it stands for. */
  replayId: number;
}

type ItemResult = EventResult;

function isDeletion(changeType: string): boolean {
  return changeType === 'DELETE' || changeType === 'GAP_DELETE';
}

function isWholeRecord(changeType: string): boolean {
  return changeType === 'CREATE' || changeType === 'UNDELETE';
}

/**
 * A Salesforce date-time as epoch milliseconds. REST answers `+0000`, which
 * not every parser reads as an offset.
 */
export function parseSalesforceDate(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : time;
}

/** A query row without jsforce's `attributes` envelope, which is never a field. */
function withoutAttributes(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'attributes'));
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A key as the target record is looked up by. The org compares a text
 * external id without regard to case, in the read as in the upsert, so the
 * lookup does too; an 18-character Id stays unique folded.
 */
function keyOf(value: unknown): string {
  return String(value).toLowerCase();
}

/**
 * Writes the changes of one watched object to the target, through the path a
 * Sync run writes with.
 *
 * A change is addressed to its target record by the plan's key. Before
 * anything is written the target record is read: when it was edited after the
 * change was made — and not by this session — the change collides with that
 * edit, and the conflict strategy decides. `source_wins` writes anyway;
 * `target_wins` keeps the edit, and so does `newest_wins`, since the target's
 * edit is by definition the newer one; `merge` writes only what the source did
 * not clear; `manual` holds the change for a decision.
 */
export class RealtimeApplier {
  private readonly mapping = new FieldMappingService();
  private readonly transforms = new TransformPipeline();
  private readonly objectConfig: SyncObjectConfig;

  /**
   * @param plan - How the object's changes are written.
   * @param deps - Both orgs, the write path and the collision rule.
   */
  constructor(
    readonly plan: ApplyPlan,
    private readonly deps: ApplierDeps,
  ) {
    this.objectConfig = {
      objectApiName: plan.objectApiName,
      operation: plan.keyField === 'Id' ? 'update' : 'upsert',
      externalIdField: plan.keyField,
      fieldMappings: [],
      transformRules: plan.transformRules,
      excludedFields: [],
      addOnFields: [],
      batchSize: READ_CHUNK,
      insertOrder: 0,
    };
  }

  /**
   * Write the changes of a flush, in the order they were made.
   *
   * @param events - Change events of this object, oldest first.
   * @returns One result per event, and the changes held for a decision.
   */
  async apply(
    events: readonly ChangeEvent[],
  ): Promise<{ results: EventResult[]; held: HeldChange[] }> {
    const perEvent: ItemResult[][] = events.map(() => []);
    const held: HeldChange[] = [];

    // Consecutive changes of one kind are written together, and a record
    // changed twice in one flush is written once, with its latest values; a
    // run of creations never overtakes a deletion made before it.
    const segments: Array<{ kind: 'upsert' | 'delete'; changes: Map<string, Change> }> = [];
    events.forEach((event, index) => {
      if (event.changeType === 'GAP_OVERFLOW') {
        perEvent[index].push({ outcome: 'failed', error: OVERFLOW_ERROR });
        return;
      }
      if (event.recordIds.length === 0) {
        perEvent[index].push({ outcome: 'failed', error: 'The change named no record.' });
        return;
      }
      const kind = isDeletion(event.changeType) ? 'delete' : 'upsert';
      if (kind === 'delete' && !this.plan.applyDeletes) {
        perEvent[index].push({ outcome: 'deletes-off' });
        return;
      }
      let segment = segments[segments.length - 1];
      if (!segment || segment.kind !== kind) {
        segment = { kind, changes: new Map() };
        segments.push(segment);
      }
      for (const recordId of event.recordIds) {
        const seen = segment.changes.get(recordId);
        if (seen) {
          seen.eventIndexes.push(index);
          seen.values = { ...seen.values, ...event.values };
          seen.full = seen.full || isWholeRecord(event.changeType);
          seen.needsRead = seen.needsRead || event.changeType.startsWith('GAP_');
          seen.commitTimestamp = Math.min(seen.commitTimestamp, event.commitTimestamp);
          seen.replayId = Math.max(seen.replayId, event.replayId);
        } else {
          segment.changes.set(recordId, {
            recordId,
            eventIndexes: [index],
            changeType: event.changeType,
            full: isWholeRecord(event.changeType),
            needsRead: event.changeType.startsWith('GAP_') && kind === 'upsert',
            values: { ...event.values },
            commitTimestamp: event.commitTimestamp,
            replayId: event.replayId,
          });
        }
      }
    });

    for (const segment of segments) {
      const changes = [...segment.changes.values()];
      const report = (change: Change, result: ItemResult): void => {
        for (const index of change.eventIndexes) perEvent[index].push(result);
      };
      try {
        if (segment.kind === 'upsert') await this.applyUpserts(changes, report, held);
        else await this.applyDeletes(changes, report, held);
      } catch (err: unknown) {
        // A read or a describe the org refused: every change of the segment
        // is reported with that answer rather than dropped.
        const error = extractErrorMessage(err);
        for (const change of changes) report(change, { outcome: 'failed', error });
      }
    }

    return { results: perEvent.map(summarize), held };
  }

  /**
   * Decide a held change.
   *
   * @param change - The change as it was held.
   * @param resolution - `source_wins` writes it, `merge` writes what it did not
   *   clear, `target_wins` and `newest_wins` keep the target, `manual` writes
   *   the values picked field by field — none picked writes nothing.
   * @param fieldResolutions - The picks of a `manual` resolution.
   */
  async resolve(
    change: HeldChange,
    resolution: ConflictStrategy,
    fieldResolutions?: Record<string, FieldResolution>,
  ): Promise<Resolution> {
    const keyValue = change.record[this.plan.keyField];
    let values: Record<string, unknown> | null;
    if (change.kind === 'delete') {
      values = resolution === 'source_wins' ? {} : null;
    } else {
      values = this.resolvedValues(change, resolution, fieldResolutions);
    }
    if (values === null) return { success: true, resolvedValues: {} };

    try {
      if (change.kind === 'delete') {
        const outcome = await this.writeOne('delete', { Id: change.targetId });
        return outcome.success
          ? { success: true, resolvedValues: { Id: change.targetId } }
          : { success: false, resolvedValues: {}, error: outcome.errors[0] ?? 'Delete refused.' };
      }
      const record = await this.coerced({ ...values, [this.plan.keyField]: keyValue });
      const outcome = await this.writeOne(this.objectConfig.operation, record);
      if (!outcome.success) {
        return { success: false, resolvedValues: {}, error: outcome.errors[0] ?? 'Write refused.' };
      }
      await this.rememberWrites([outcome.id ?? change.targetId]);
      return { success: true, resolvedValues: record };
    } catch (err: unknown) {
      return { success: false, resolvedValues: {}, error: extractErrorMessage(err) };
    }
  }

  /** The values a resolution writes, without the key; `null` when it writes nothing. */
  private resolvedValues(
    change: HeldChange,
    resolution: ConflictStrategy,
    fieldResolutions?: Record<string, FieldResolution>,
  ): Record<string, unknown> | null {
    const fields = Object.fromEntries(
      Object.entries(change.record).filter(([field]) => field !== this.plan.keyField),
    );
    switch (resolution) {
      case 'source_wins':
        return fields;
      case 'merge': {
        const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
        return Object.keys(kept).length > 0 ? kept : null;
      }
      case 'manual': {
        const picked = Object.fromEntries(
          Object.entries(fieldResolutions ?? {})
            .filter(([field]) => field in fields)
            .map(([field, choice]) => [field, choice.value]),
        );
        return Object.keys(picked).length > 0 ? picked : null;
      }
      case 'target_wins':
      case 'newest_wins':
        return null;
    }
  }

  /** A typed-in value turned into what the target field holds. */
  private async coerced(record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const described = await this.deps.target.describe(this.plan.objectApiName);
    const types = new Map(described.fields.map((f) => [f.name, f.type ?? '']));
    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      const type = types.get(field) ?? '';
      if (typeof value === 'string' && type === 'boolean') {
        result[field] = value.trim().toLowerCase() === 'true';
      } else if (typeof value === 'string' && NUMERIC_TYPES.has(type) && value.trim() !== '') {
        const n = Number(value);
        result[field] = Number.isNaN(n) ? value : n;
      } else {
        result[field] = value;
      }
    }
    return result;
  }

  private async writeOne(
    operation: SyncObjectConfig['operation'],
    record: Record<string, unknown>,
  ): Promise<OperationOutcome> {
    const { outcomes } = await this.deps.write({ ...this.objectConfig, operation, batchSize: 1 }, [
      record,
    ]);
    return outcomes[0] ?? { success: false, errors: ['The target answered nothing.'] };
  }

  /** Creations, updates, restores. */
  private async applyUpserts(
    changes: Change[],
    report: (change: Change, result: ItemResult) => void,
    held: HeldChange[],
  ): Promise<void> {
    const object = this.plan.objectApiName;
    const fields = new Map(
      (await this.deps.target.describe(object)).fields.map((f) => [f.name, f] as const),
    );
    if (this.plan.keyField !== 'Id' && !fields.has(this.plan.keyField)) {
      throw new Error(`${object} has no field ${this.plan.keyField} in the target org.`);
    }

    // A GAP event carries no value: the record is read back whole.
    await this.readWhole(
      changes.filter((c) => c.needsRead),
      report,
    );
    let pending = changes.filter((c) => !c.needsRead || c.full);

    const keys = await this.keysOf(pending, report, false);
    pending = pending.filter((c) => keys.has(c.recordId));

    const targetRows = await this.readTarget(
      [...new Set([...keys.values()])],
      fields,
      this.writtenFieldsOf(pending, keys),
    );

    const toWrite: Array<{ change: Change; record: Record<string, unknown>; targetId?: string }> =
      [];
    const incomplete: Change[] = [];
    for (const change of pending) {
      const key = keys.get(change.recordId);
      const rows = targetRows.get(keyOf(key)) ?? [];
      if (rows.length > 1) {
        report(change, {
          outcome: 'failed',
          error: `${rows.length} records of ${object} in the target have ${this.plan.keyField} = ${String(key)}.`,
        });
        continue;
      }
      const row = rows[0];
      if (!row) {
        if (this.plan.keyField === 'Id') {
          report(change, {
            outcome: 'failed',
            error:
              'No record in the target has this Id: it was made after the two orgs were copied. ' +
              'Match on an external id to copy records made since.',
          });
        } else if (!change.full) {
          // An update of a record the target does not have yet: written as
          // it stands in the source, or the target would get a record made of
          // one changed field.
          incomplete.push(change);
        } else {
          toWrite.push({ change, record: this.recordFor(change, key, fields, false) });
        }
        continue;
      }

      const targetId = String(row['Id']);
      const record = this.recordFor(change, key, fields, true);
      const edited = parseSalesforceDate(row['LastModifiedDate']);
      const collides =
        edited !== null &&
        edited > change.commitTimestamp &&
        !this.deps.ownWrites.wrote(targetId, edited);
      if (!collides) {
        toWrite.push({ change, record, targetId });
        continue;
      }
      switch (this.deps.conflictStrategy) {
        case 'source_wins':
          toWrite.push({ change, record, targetId });
          break;
        case 'merge': {
          const kept = Object.fromEntries(
            Object.entries(record).filter(([f, v]) => v !== null || f === this.plan.keyField),
          );
          if (Object.keys(kept).length > 1) toWrite.push({ change, record: kept, targetId });
          else report(change, { outcome: 'kept-target' });
          break;
        }
        case 'manual':
          held.push(this.held(change, 'upsert', record, row));
          report(change, { outcome: 'held' });
          break;
        case 'target_wins':
        case 'newest_wins':
          report(change, { outcome: 'kept-target' });
          break;
      }
    }

    if (incomplete.length > 0) {
      for (const change of incomplete) change.needsRead = true;
      await this.readWhole(incomplete, report);
      for (const change of incomplete.filter((c) => c.full)) {
        toWrite.push({
          change,
          record: this.recordFor(change, keys.get(change.recordId), fields, false),
        });
      }
    }

    if (toWrite.length === 0) return;
    const { outcomes } = await this.deps.write(
      this.objectConfig,
      toWrite.map((w) => w.record),
    );
    const written: string[] = [];
    toWrite.forEach((w, i) => {
      const outcome = outcomes[i];
      if (outcome?.success) {
        report(w.change, { outcome: 'applied' });
        const id = outcome.id ?? w.targetId;
        if (id) written.push(id);
      } else {
        report(w.change, {
          outcome: 'failed',
          error: outcome?.errors[0] ?? 'The target answered nothing for this record.',
        });
      }
    });
    await this.rememberWrites(written);
  }

  /** Deletions, when the plan applies them. */
  private async applyDeletes(
    changes: Change[],
    report: (change: Change, result: ItemResult) => void,
    held: HeldChange[],
  ): Promise<void> {
    const object = this.plan.objectApiName;
    const fields = new Map(
      (await this.deps.target.describe(object)).fields.map((f) => [f.name, f] as const),
    );
    const keys = await this.keysOf(changes, report, true);
    const pending = changes.filter((c) => keys.has(c.recordId));
    const targetRows = await this.readTarget([...new Set([...keys.values()])], fields, []);

    const toDelete: Array<{ change: Change; targetId: string }> = [];
    for (const change of pending) {
      const key = keys.get(change.recordId);
      const rows = targetRows.get(keyOf(key)) ?? [];
      if (rows.length > 1) {
        report(change, {
          outcome: 'failed',
          error: `${rows.length} records of ${object} in the target have ${this.plan.keyField} = ${String(key)}.`,
        });
        continue;
      }
      const row = rows[0];
      if (!row) {
        // Nothing left to delete: the target is where the source is.
        report(change, { outcome: 'applied' });
        continue;
      }
      const targetId = String(row['Id']);
      const edited = parseSalesforceDate(row['LastModifiedDate']);
      const collides =
        edited !== null &&
        edited > change.commitTimestamp &&
        !this.deps.ownWrites.wrote(targetId, edited);
      if (!collides || this.deps.conflictStrategy === 'source_wins') {
        toDelete.push({ change, targetId });
      } else if (this.deps.conflictStrategy === 'manual') {
        held.push(this.held(change, 'delete', { [this.plan.keyField]: key }, row));
        report(change, { outcome: 'held' });
      } else {
        report(change, { outcome: 'kept-target' });
      }
    }

    if (toDelete.length === 0) return;
    const { outcomes } = await this.deps.write(
      { ...this.objectConfig, operation: 'delete' },
      toDelete.map((d) => ({ Id: d.targetId })),
    );
    toDelete.forEach((d, i) => {
      const outcome = outcomes[i];
      report(
        d.change,
        outcome?.success
          ? { outcome: 'applied' }
          : {
              outcome: 'failed',
              error: outcome?.errors[0] ?? 'The target answered nothing for this record.',
            },
      );
    });
  }

  /** A held change, as the Conflicts tab shows it. */
  private held(
    change: Change,
    kind: 'upsert' | 'delete',
    record: Record<string, unknown>,
    row: Record<string, unknown>,
  ): HeldChange {
    const shown = Object.keys(record).filter((f) => f !== this.plan.keyField);
    return {
      conflictId: `${this.plan.objectApiName}:${change.recordId}:${change.replayId}`,
      objectApiName: this.plan.objectApiName,
      recordId: change.recordId,
      replayId: change.replayId,
      changeType: change.changeType,
      kind,
      record,
      targetId: String(row['Id']),
      targetValues: Object.fromEntries(shown.map((f) => [f, row[f] ?? null])),
      targetLastModified: new Date(parseSalesforceDate(row['LastModifiedDate']) ?? 0).toISOString(),
    };
  }

  /**
   * The key of each change's target record, by source record id. A change
   * whose key cannot be known is reported and left out.
   */
  private async keysOf(
    changes: Change[],
    report: (change: Change, result: ItemResult) => void,
    deleted: boolean,
  ): Promise<Map<string, unknown>> {
    const { keySource } = this.plan;
    const missing = changes.filter(
      (c) =>
        keySource !== 'Id' && isBlank(c.values[keySource]) && !(keySource in c.values && c.full),
    );
    if (missing.length > 0) {
      const rows = await this.readSource(
        missing.map((c) => c.recordId),
        `Id, ${assertSoqlIdentifier(keySource)}`,
        deleted,
      );
      for (const change of missing) {
        const row = rows.get(change.recordId);
        if (row) change.values = { ...change.values, [keySource]: row[keySource] ?? null };
      }
    }

    const keys = new Map<string, unknown>();
    for (const change of changes) {
      if (keySource !== 'Id' && !(keySource in change.values)) {
        report(change, {
          outcome: 'failed',
          error: deleted
            ? 'The deleted record can no longer be read in the source (it left the recycle ' +
              'bin), so the record to delete in the target cannot be found.'
            : 'The source record could not be read back, so its record in the target cannot be found.',
        });
        continue;
      }
      const key =
        this.plan.keyField === 'Id' ? change.recordId : this.mapped(change)[this.plan.keyField];
      if (isBlank(key)) {
        report(change, {
          outcome: 'failed',
          error: `The source record has no ${keySource}, so its record in the target cannot be found.`,
        });
        continue;
      }
      keys.set(change.recordId, key);
    }
    return keys;
  }

  /** The change as the plan's mapping, transforms and add-ons make it. */
  private mapped(change: Change): Record<string, unknown> {
    const sourceShaped: Record<string, unknown> = { ...change.values, Id: change.recordId };
    let record = this.mapping.apply(sourceShaped, this.plan.fieldMappings);
    if (this.plan.keySource !== 'Id' && record[this.plan.keyField] === undefined) {
      record[this.plan.keyField] = sourceShaped[this.plan.keySource];
    }
    record = this.transforms.transformRecord(record, this.objectConfig);
    return this.mapping.applyAddOns(record, this.plan.addOnFields);
  }

  /**
   * What a change writes: the fields the target lets the running user write —
   * update them when the record exists, create them when it does not — and the
   * key the write is addressed by.
   *
   * A record created goes without the lookups the platform fills in itself,
   * as every other write of a copy does: an email's task, unless the email is
   * on a case. Sent with the id read from the source, the email is refused,
   * "you cannot modify this field". See `lookupsThePlatformFills`.
   */
  private recordFor(
    change: Change,
    key: unknown,
    fields: ReadonlyMap<string, DescribedField>,
    exists: boolean,
  ): Record<string, unknown> {
    const mapped = this.mapped(change);
    const filled = exists ? [] : lookupsThePlatformFills(this.plan.objectApiName, mapped);
    const record: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(mapped)) {
      if (value === undefined || field === 'Id' || field === this.plan.keyField) continue;
      if (filled.includes(field)) continue;
      const described = fields.get(field);
      if (!described) continue;
      if (exists ? described.updateable !== true : described.createable !== true) continue;
      record[field] = value;
    }
    record[this.plan.keyField] = key;
    return record;
  }

  /** The fields some change will write, for the target read to fetch alongside. */
  private writtenFieldsOf(changes: Change[], keys: Map<string, unknown>): string[] {
    const names = new Set<string>();
    for (const change of changes) {
      if (!keys.has(change.recordId)) continue;
      for (const [field, value] of Object.entries(this.mapped(change))) {
        if (value !== undefined) names.add(field);
      }
    }
    return [...names];
  }

  /** Read whole records back from the source; a change whose record is gone is reported. */
  private async readWhole(
    changes: Change[],
    report: (change: Change, result: ItemResult) => void,
  ): Promise<void> {
    if (changes.length === 0) return;
    const rows = await this.readSource(
      changes.map((c) => c.recordId),
      'FIELDS(ALL)',
      false,
    );
    for (const change of changes) {
      const row = rows.get(change.recordId);
      if (!row) {
        report(change, {
          outcome: 'failed',
          error: 'The source record could not be read back: it was deleted since.',
        });
        continue;
      }
      change.values = { ...withoutAttributes(row), ...change.values };
      change.full = true;
    }
  }

  /** Source records by id. */
  private async readSource(
    ids: string[],
    select: string,
    includeDeleted: boolean,
  ): Promise<Map<string, Record<string, unknown>>> {
    const object = sanitizeSoqlObjectName(this.plan.objectApiName);
    const rows = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const chunk = ids.slice(i, i + READ_CHUNK);
      const list = chunk.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
      const limit = select === 'FIELDS(ALL)' ? ` LIMIT ${READ_CHUNK}` : '';
      const found = await this.deps.source.query(
        `SELECT ${select} FROM ${object} WHERE Id IN (${list})${limit}`,
        { includeDeleted },
      );
      for (const row of found) rows.set(String(row['Id']), row);
    }
    return rows;
  }

  /** Target records by key, with their last edit and the fields asked for. */
  private async readTarget(
    keys: unknown[],
    fields: ReadonlyMap<string, DescribedField>,
    alongside: string[],
  ): Promise<Map<string, Array<Record<string, unknown>>>> {
    const object = sanitizeSoqlObjectName(this.plan.objectApiName);
    const keyField = assertSoqlIdentifier(this.plan.keyField);
    const numeric = NUMERIC_TYPES.has(fields.get(this.plan.keyField)?.type ?? '');
    const extra = alongside.filter(
      (f) => f !== 'Id' && f !== this.plan.keyField && f !== 'LastModifiedDate' && fields.has(f),
    );
    const select = ['Id', ...(keyField === 'Id' ? [] : [keyField]), 'LastModifiedDate', ...extra];
    const byKey = new Map<string, Array<Record<string, unknown>>>();
    for (let i = 0; i < keys.length; i += READ_CHUNK) {
      const chunk = keys.slice(i, i + READ_CHUNK);
      const list = chunk
        .map((k) => (numeric ? String(Number(k)) : `'${sanitizeSoqlValue(String(k))}'`))
        .join(', ');
      const where = `WHERE ${keyField} IN (${list})`;
      let found: Record<string, unknown>[];
      try {
        found = await this.deps.target.query(
          `SELECT ${select.map(assertSoqlIdentifier).join(', ')} FROM ${object} ${where}`,
        );
      } catch {
        // A field the running user cannot read in the target: the collision
        // check needs only the key and the last edit.
        found = await this.deps.target.query(
          `SELECT Id${keyField === 'Id' ? '' : `, ${keyField}`}, LastModifiedDate FROM ${object} ${where}`,
        );
      }
      for (const row of found) {
        const key = keyOf(row[this.plan.keyField]);
        byKey.set(key, [...(byKey.get(key) ?? []), withoutAttributes(row)]);
      }
    }
    return byKey;
  }

  /** Note the edit the session's writes left, so they never count as a collision. */
  private async rememberWrites(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const object = sanitizeSoqlObjectName(this.plan.objectApiName);
    try {
      for (let i = 0; i < ids.length; i += READ_CHUNK) {
        const list = ids
          .slice(i, i + READ_CHUNK)
          .map((id) => `'${sanitizeSoqlValue(id)}'`)
          .join(', ');
        const rows = await this.deps.target.query(
          `SELECT Id, LastModifiedDate FROM ${object} WHERE Id IN (${list})`,
        );
        for (const row of rows) {
          const edited = parseSalesforceDate(row['LastModifiedDate']);
          if (edited !== null) this.deps.ownWrites.record(String(row['Id']), edited);
        }
      }
    } catch {
      // Without the stamp a later change to the same record may be taken for
      // a collision with the session's own write; it is still written or held,
      // never lost.
    }
  }
}

/** One event's result, from the results of the records it named. */
function summarize(results: ItemResult[]): EventResult {
  const failed = results.find((r) => r.outcome === 'failed');
  if (failed) return failed;
  if (results.some((r) => r.outcome === 'held')) return { outcome: 'held' };
  if (results.length > 0 && results.every((r) => r.outcome === 'kept-target')) {
    return { outcome: 'kept-target' };
  }
  if (results.length > 0 && results.every((r) => r.outcome === 'deletes-off')) {
    return { outcome: 'deletes-off' };
  }
  return { outcome: 'applied' };
}
