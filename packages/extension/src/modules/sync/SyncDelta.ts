/**
 * Delta runs of a saved Sync configuration: each object reads only the
 * records its source changed since the object's last good run.
 *
 * The point a delta read starts from is a watermark: the source's latest
 * `SystemModstamp` for the object, read from the org before the run read the
 * object — the org's own time, never this machine's, whose clock can stand
 * minutes away from the org's. It is recorded once the object's run has
 * finished cleanly, and kept as it was when the run failed, stopped, was cut
 * short by a read bound, or could not carry a deletion: the next run then
 * reads from the same point and writes again what it reaches.
 *
 * A read starts five minutes before the watermark. A record saved in a
 * transaction that had not committed when the watermark was read carries a
 * stamp below it; the overlap reads it next time. What the overlap reads twice
 * is written twice, which only a write that finds its record can do without
 * making a second copy: an upsert on an External ID, or an update by Id. The
 * bridge refuses a delta configuration holding any other operation.
 *
 * A watermark belongs to one scope. Recorded beside it is a fingerprint of
 * what decides which records the object reads and what it writes of them —
 * its filter, operation, key, mappings, transforms and add-ons, the run's
 * direction and conflict strategy, and whether it copies the files of its
 * records. A change to any of them reads the object whole once: the records
 * the target holds were written under another scope — with files turned on,
 * the records a delta read would pass over have files that were never copied.
 */

import { createHash } from 'node:crypto';
import * as z from 'zod';
import type {
  SyncConfig,
  SyncDeltaOutcome,
  SyncFullReadReason,
  SyncObjectConfig,
} from '@sandforge/shared';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { assertSoqlIdentifier, assertSoqlWhere } from '../../core/common/soqlValidator.js';
import { queryAllPages, type PagedQuerySource, type QueryPage } from '../forge/queryAllPages.js';
import { keyBatches, simulationKey, soqlLiteral } from './SyncSimulation.js';

/** How far before its watermark a delta read starts. */
export const DELTA_OVERLAP_MS = 5 * 60_000;

/** Most watermarks one configuration keeps: one per object, and a run takes at most this many. */
const MAX_WATERMARKS = 500;

/** One object's watermark, as stored beside its configuration. */
export const syncWatermarkSchema = z.object({
  sourceOrgId: z.string().min(1).max(200),
  targetOrgId: z.string().min(1).max(200),
  objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  /** The source's latest `SystemModstamp` for the object before the run read it. */
  watermark: z.iso.datetime(),
  /** {@link scopeFingerprint} of the object as the run that recorded it ran it. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** When it was recorded, by this machine's clock: said, never read from. */
  recordedAt: z.iso.datetime(),
  /**
   * On a configuration that copies files: the newest stamp of a file link, a
   * file version or an attachment the run's lookups for files gained since
   * looked at, by the org's clock. The next run looks only past it, so files
   * already looked at are not found again run after run while the records do
   * not change and the watermark stays put.
   */
  filesSeen: z.iso.datetime().optional(),
  /**
   * When a removal took back records or files a run had created for the
   * object: the next run reads it whole, since the copies the watermark counted
   * on are gone. A clean run records over it.
   */
  removedAt: z.iso.datetime().optional(),
});

/** Every watermark of one configuration. */
export const syncDeltaStateSchema = z.object({
  version: z.literal(1),
  entries: z.array(syncWatermarkSchema).max(MAX_WATERMARKS),
  /** When "Run full next time" cleared them, so the next full read says why. */
  resetAt: z.iso.datetime().optional(),
});

export type SyncWatermark = z.infer<typeof syncWatermarkSchema>;
export type SyncDeltaState = z.infer<typeof syncDeltaStateSchema>;

/** What the store holds for a configuration. */
export type SyncDeltaLoad =
  | { kind: 'none' }
  | { kind: 'stored'; state: SyncDeltaState }
  | { kind: 'unreadable'; issue: string };

/**
 * What a store holds, read as watermarks or not at all. Stored data that does
 * not read is never half used: every object of the run reads whole, says why,
 * and the first clean run records over it.
 */
export function readDeltaState(raw: unknown): SyncDeltaLoad {
  if (raw === undefined || raw === null) return { kind: 'none' };
  const parsed = syncDeltaStateSchema.safeParse(raw);
  if (parsed.success) return { kind: 'stored', state: parsed.data };
  const issue = parsed.error.issues[0];
  return { kind: 'unreadable', issue: `${issue.path.join('.') || 'state'}: ${issue.message}` };
}

/**
 * Where the watermarks of the run's configuration are kept: see
 * `SyncConfigStore`.
 */
export interface SyncDeltaStore {
  /**
   * The watermarks of a configuration, or `null` when no configuration is
   * saved under that id: a watermark is kept for a saved configuration only,
   * since nothing else is ever run again under the same id.
   */
  load(configId: string): SyncDeltaLoad | null;
  /** Record one object's watermark, replacing the one it had. */
  record(configId: string, watermark: SyncWatermark): void;
}

/** JSON with the keys of every object sorted and `undefined` left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** An empty box is no value: the bridge reads an empty External ID box that way. */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * What decides which records of an object a run reads and what it writes of
 * them, as one hash. Its read order is left out: it changes neither.
 */
export function scopeFingerprint(
  config: Pick<SyncConfig, 'direction' | 'conflictStrategy' | 'files'>,
  objectConfig: SyncObjectConfig,
): string {
  const scope = {
    direction: config.direction,
    conflictStrategy: config.conflictStrategy,
    // Left out when off, so a watermark recorded before files could be copied
    // still reads as the scope it was recorded under. The caps are not in it:
    // a file past them is read again, and copied, by a later run.
    copiesFiles: config.files ? true : undefined,
    objectApiName: objectConfig.objectApiName,
    operation: objectConfig.operation,
    externalIdField: blankToNull(objectConfig.externalIdField),
    where: blankToNull(objectConfig.where),
    fieldMappings: objectConfig.fieldMappings ?? [],
    transformRules: objectConfig.transformRules ?? [],
    excludedFields: objectConfig.excludedFields ?? [],
    addOnFields: objectConfig.addOnFields ?? [],
  };
  return createHash('sha256').update(canonicalJson(scope)).digest('hex');
}

/** How a run reads one object of a delta configuration. */
export type ObjectReadPlan =
  | { read: 'delta'; since: string; fingerprint: string; filesSeen?: string }
  | { read: 'full'; reason: SyncFullReadReason; fingerprint: string };

/**
 * How a run reads `objectConfig`: from its watermark, when the store holds one
 * for this pair of orgs recorded under the same scope, or whole, with the
 * reason.
 *
 * @param load - What the store holds, or `null` when the configuration is not saved.
 */
export function planObjectRead(
  config: Pick<
    SyncConfig,
    'sourceOrgId' | 'targetOrgId' | 'direction' | 'conflictStrategy' | 'files'
  >,
  objectConfig: SyncObjectConfig,
  load: SyncDeltaLoad | null,
): ObjectReadPlan {
  const fingerprint = scopeFingerprint(config, objectConfig);
  if (load === null) return { read: 'full', reason: 'not_saved', fingerprint };
  if (load.kind === 'unreadable') return { read: 'full', reason: 'unreadable', fingerprint };
  if (load.kind === 'none') return { read: 'full', reason: 'first_run', fingerprint };
  const entry = load.state.entries.find(
    (e) =>
      e.sourceOrgId === config.sourceOrgId &&
      e.targetOrgId === config.targetOrgId &&
      e.objectApiName === objectConfig.objectApiName,
  );
  if (!entry) {
    return { read: 'full', reason: load.state.resetAt ? 'reset' : 'first_run', fingerprint };
  }
  if (entry.fingerprint !== fingerprint) {
    return { read: 'full', reason: 'scope_changed', fingerprint };
  }
  if (entry.removedAt !== undefined) return { read: 'full', reason: 'removed', fingerprint };
  return {
    read: 'delta',
    since: entry.watermark,
    fingerprint,
    ...(entry.filesSeen !== undefined ? { filesSeen: entry.filesSeen } : {}),
  };
}

/** A SOQL datetime literal, to the second, in UTC. */
const SOQL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The point a delta read starts from, as SOQL writes a datetime: the watermark
 * less the overlap, rounded down to the second — SOQL's literal has no
 * fraction, and rounding down reads a little more, never less.
 */
export function changedSinceLiteral(watermark: string, overlapMs = DELTA_OVERLAP_MS): string {
  const at = Date.parse(watermark);
  if (!Number.isFinite(at)) throw new Error(`Not a watermark: "${watermark}".`);
  const from = Math.floor((at - overlapMs) / 1000) * 1000;
  return new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A date the org wrote, as a SOQL literal to the second: the org stamps its
 * records to the second, so the literal of a stamp is that stamp, and a read
 * of what is after it leaves the stamp itself out.
 */
export function soqlDateTimeOf(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) throw new Error(`Not a date: "${iso}".`);
  return new Date(Math.floor(at / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A SOQL datetime literal as {@link changedSinceLiteral} writes one, or an error. */
export function assertSoqlDateTime(literal: string): string {
  if (!SOQL_DATETIME.test(literal) || !Number.isFinite(Date.parse(literal))) {
    throw new Error(`Not a SOQL datetime: "${literal}".`);
  }
  return literal;
}

/**
 * The WHERE a source read runs: the object's own filter and, on a delta read,
 * only the records changed after `changedSince`. The filter is checked where
 * it becomes query text and kept whole inside parentheses, so an `OR` of its
 * own cannot reach past the bound.
 */
export function sourceReadWhere(
  where: string | undefined,
  changedSince: string | undefined,
): string | undefined {
  const own = where?.trim() ? assertSoqlWhere(where) : undefined;
  if (changedSince === undefined) return own;
  const bound = `SystemModstamp > ${assertSoqlDateTime(changedSince)}`;
  return own ? `${bound} AND (${own})` : bound;
}

/**
 * A datetime as the org writes it (`2026-10-13T09:41:07.000+0000`) as an ISO
 * string, or `null` when it is none.
 */
export function orgDateTime(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** What a delta run asks the two orgs, beside the reads and writes every run makes. */
export interface SyncDeltaReads {
  /**
   * The latest `SystemModstamp` of the object's records in the source, as an
   * ISO string, or `null` when it holds none. Asked before the object is read.
   */
  latestModstamp(objectApiName: string): Promise<string | null>;
  /**
   * The rows of the object the source deleted that `where` selects — the
   * recycle bin, read with `queryAll` — with their `Id`, `SystemModstamp` and
   * `fields`. `truncated` when a bound stopped the read.
   */
  deletedRows(
    objectApiName: string,
    fields: readonly string[],
    where: string,
  ): Promise<{ records: Record<string, unknown>[]; truncated: boolean }>;
  /**
   * Of `values` of `field`, those a record of the source still holds, by the
   * value as `simulationKey` gives it.
   */
  heldInSource(
    objectApiName: string,
    field: string,
    values: readonly (string | number | boolean)[],
  ): Promise<ReadonlySet<string>>;
  /**
   * The target records holding each of `keys` in `keyField`, by the key as
   * `simulationKey` gives it; a key no record holds is absent.
   */
  targetIdsByKey(
    objectApiName: string,
    keyField: string,
    keys: readonly (string | number | boolean)[],
  ): Promise<ReadonlyMap<string, string[]>>;
}

/** A paged query that can read the recycle bin, as a jsforce connection offers it. */
export interface DeltaQuerySource {
  query(soql: string, options?: { scanAll?: boolean }): Promise<QueryPage<Record<string, unknown>>>;
  queryMore(nextRecordsUrl: string): Promise<QueryPage<Record<string, unknown>>>;
}

/**
 * {@link SyncDeltaReads} over the two orgs' connections.
 *
 * @param signal - The run's cancel, honoured between two lookups.
 */
export function orgDeltaReads(
  source: DeltaQuerySource,
  target: PagedQuerySource<Record<string, unknown>>,
  signal?: AbortSignal,
): SyncDeltaReads {
  const live: PagedQuerySource<Record<string, unknown>> = {
    query: (q) => source.query(q),
    queryMore: (url) => source.queryMore(url),
  };
  const recycleBin: PagedQuerySource<Record<string, unknown>> = {
    query: (q) => source.query(q, { scanAll: true }),
    queryMore: (url) => source.queryMore(url),
  };
  const stopIfCancelled = (): void => {
    if (signal?.aborted) throw new Error('The run was cancelled.');
  };

  return {
    async latestModstamp(objectApiName) {
      const object = sanitizeSoqlObjectName(objectApiName);
      // SystemModstamp is indexed on every object that carries it, so this
      // reads one row however large the object is.
      const page = await source.query(
        `SELECT SystemModstamp FROM ${object} ORDER BY SystemModstamp DESC LIMIT 1`,
      );
      const row = page.records[0];
      if (!row) return null;
      const stamp = orgDateTime(row.SystemModstamp);
      if (stamp === null) {
        throw new Error(`${object} answered a SystemModstamp that is not a date.`);
      }
      return stamp;
    },

    async deletedRows(objectApiName, fields, where) {
      const object = sanitizeSoqlObjectName(objectApiName);
      const selected = new Set(['Id', 'SystemModstamp', ...fields.map(assertSoqlIdentifier)]);
      const { records, truncated } = await queryAllPages(
        recycleBin,
        `SELECT ${[...selected].join(', ')} FROM ${object} ` +
          `WHERE IsDeleted = true AND (${assertSoqlWhere(where)})`,
      );
      return { records, truncated };
    },

    async heldInSource(objectApiName, field, values) {
      const object = sanitizeSoqlObjectName(objectApiName);
      const column = assertSoqlIdentifier(field);
      const held = new Set<string>();
      for (const batch of keyBatches(values)) {
        stopIfCancelled();
        const { records } = await queryAllPages(
          live,
          `SELECT ${column} FROM ${object} WHERE ${column} IN (${batch.map(soqlLiteral).join(', ')})`,
        );
        for (const row of records) {
          const key = simulationKey(row[column]);
          if (key !== null) held.add(key);
        }
      }
      return held;
    },

    async targetIdsByKey(objectApiName, keyField, keys) {
      const object = sanitizeSoqlObjectName(objectApiName);
      const column = assertSoqlIdentifier(keyField);
      const selected = column === 'Id' ? 'Id' : `Id, ${column}`;
      const ids = new Map<string, string[]>();
      for (const batch of keyBatches(keys)) {
        stopIfCancelled();
        const { records } = await queryAllPages(
          target,
          `SELECT ${selected} FROM ${object} WHERE ${column} IN (${batch.map(soqlLiteral).join(', ')})`,
        );
        for (const row of records) {
          const key = simulationKey(row[column]);
          if (key === null || typeof row.Id !== 'string') continue;
          ids.set(key, [...(ids.get(key) ?? []), row.Id]);
        }
      }
      return ids;
    },
  };
}

/** The mapping types that carry a source field's value onto the target field. */
const KEY_CARRYING_MAPPINGS: ReadonlySet<string> = new Set(['direct', 'rename', 'transform']);

/**
 * The source field a delete ties a deleted source record to its target record
 * by, or why there is none.
 *
 * An update finds its record by `Id`, which two orgs share only when one was
 * copied from the other, so the deleted record's own Id is the target's. An
 * upsert finds it by its External ID field, written from the source field a
 * mapping carries onto it — the same-named field when the object has no
 * mapping. A key a constant, a formula or an add-on writes is the same for
 * every record, or not the source's at all: it ties no deleted record to one
 * target record, and deletions are not carried for that object.
 */
export function deletionKeyOf(
  objectConfig: Pick<
    SyncObjectConfig,
    'objectApiName' | 'operation' | 'externalIdField' | 'fieldMappings' | 'addOnFields'
  >,
): { sourceField: string; keyField: string } | { refused: string } {
  const name = objectConfig.objectApiName;
  if (objectConfig.operation === 'insert' || objectConfig.operation === 'delete') {
    return {
      refused:
        `${name} is written by ${objectConfig.operation}, which finds no record by a key: ` +
        `a deleted source record cannot be tied to a target record.`,
    };
  }
  if (objectConfig.operation === 'update') return { sourceField: 'Id', keyField: 'Id' };
  // As the writer sends an upsert: on its External ID field.
  const keyField = blankToNull(objectConfig.externalIdField) ?? 'Id';
  if ((objectConfig.addOnFields ?? []).some((addOn) => addOn.fieldApiName === keyField)) {
    return {
      refused:
        `${name}: an add-on writes ${keyField}, the key the upsert matches on, so it ties ` +
        `no deleted source record to one target record.`,
    };
  }
  const mappings = objectConfig.fieldMappings ?? [];
  if (mappings.length === 0) return { sourceField: keyField, keyField };
  const carrying = mappings.find((m) => m.targetField === keyField);
  if (!carrying || !KEY_CARRYING_MAPPINGS.has(carrying.type)) {
    return {
      refused:
        `${name}: no source field is carried onto ${keyField}, the key the upsert matches on, ` +
        `so no deleted source record can be tied to a target record.`,
    };
  }
  return { sourceField: carrying.sourceField, keyField };
}

/** Rows a deletion pass left alone, and why. */
export interface DeletionTally {
  /** Target ids to delete: each the only target record holding a deleted source record's key. */
  ids: string[];
  /** Deleted source rows read. */
  read: number;
  /** Rows whose key a source record still holds: deleted and created again, or merged. */
  stillInSource: number;
  /** Rows whose key more than one target record holds. */
  ambiguous: number;
  /** Rows carrying no key. */
  noKey: number;
  /** Whether a bound stopped the read of the deleted rows. */
  truncated: boolean;
}

/**
 * What a deletion pass would delete in the target: the deleted source rows
 * `where` selects, each tied to its target record by `keyOf`, which computes
 * the key exactly as the write computed it. A row is tied only when its key
 * is held by no record the source still has and by exactly one target record.
 */
export async function tallyDeletions(
  reads: SyncDeltaReads,
  objectConfig: SyncObjectConfig,
  key: { sourceField: string; keyField: string },
  where: string,
  keyOf: (row: Record<string, unknown>) => unknown,
): Promise<DeletionTally> {
  const name = objectConfig.objectApiName;
  const { records, truncated } = await reads.deletedRows(name, [key.sourceField], where);
  const tally: DeletionTally = {
    ids: [],
    read: records.length,
    stillInSource: 0,
    ambiguous: 0,
    noKey: 0,
    truncated,
  };
  if (records.length === 0) return tally;

  const rows: Array<{ raw: string | number | boolean; key: string | number | boolean }> = [];
  for (const record of records) {
    const raw = record[key.sourceField];
    const written = keyOf(record);
    if (simulationKey(raw) === null || simulationKey(written) === null) {
      tally.noKey++;
      continue;
    }
    rows.push({
      raw: raw as string | number | boolean,
      key: written as string | number | boolean,
    });
  }
  if (rows.length === 0) return tally;

  // An Id is never deleted and live at once; an External ID can be.
  const live =
    key.sourceField === 'Id'
      ? new Set<string>()
      : await reads.heldInSource(
          name,
          key.sourceField,
          rows.map((r) => r.raw),
        );
  const candidates = rows.filter((row) => {
    if (!live.has(simulationKey(row.raw) as string)) return true;
    tally.stillInSource++;
    return false;
  });
  if (candidates.length === 0) return tally;

  const held = await reads.targetIdsByKey(
    name,
    key.keyField,
    candidates.map((r) => r.key),
  );
  const seen = new Set<string>();
  for (const row of candidates) {
    const ids = held.get(simulationKey(row.key) as string) ?? [];
    if (ids.length > 1) {
      tally.ambiguous++;
    } else if (ids.length === 1 && !seen.has(ids[0])) {
      seen.add(ids[0]);
      tally.ids.push(ids[0]);
    }
  }
  return tally;
}

/** What a deletion pass left alone, in words, for the object's result. */
export function deletionNotes(tally: DeletionTally, keyField: string): string[] {
  const notes: string[] = [];
  if (tally.stillInSource > 0) {
    notes.push(
      `${tally.stillInSource} record(s) deleted in the source share their ${keyField} with a ` +
        `record the source still holds: their target record was kept.`,
    );
  }
  if (tally.ambiguous > 0) {
    notes.push(
      `${tally.ambiguous} record(s) deleted in the source match more than one target record on ` +
        `${keyField}: none of those target records was deleted.`,
    );
  }
  if (tally.noKey > 0) {
    notes.push(
      `${tally.noKey} record(s) deleted in the source carry no ${keyField}: no target record ` +
        `is tied to them.`,
    );
  }
  if (tally.truncated) {
    notes.push(
      `The source's deleted records were read up to a bound: the rest are read by the next ` +
        `run, from the same watermark.`,
    );
  }
  return notes;
}

/** The outcome an object of a delta configuration reports, from what its run did. */
export function deltaOutcomeOf(
  plan: ObjectReadPlan,
  changed: number,
  deletions?: {
    deleted: number;
    deleteFailed: number;
    error?: string;
  },
  recorded?: string,
): SyncDeltaOutcome {
  return {
    read: plan.read,
    ...(plan.read === 'delta' ? { since: plan.since } : { reason: plan.reason }),
    changed,
    deletionsChecked: deletions !== undefined,
    deleted: deletions?.deleted ?? 0,
    deleteFailed: deletions?.deleteFailed ?? 0,
    ...(deletions?.error !== undefined ? { deletionError: deletions.error } : {}),
    ...(recorded !== undefined ? { recorded } : {}),
  };
}
