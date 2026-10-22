/**
 * What a Sync run writes over, kept before it writes: the values the records
 * of the target an update or an upsert reaches hold, of the fields the call
 * writes, read from the target before each call and kept in the DataOps
 * backup store — on disk, its owner's alone to read, under the retention of
 * `sandforge.backup.maxAgeDays` and deletable from the Restore tab — and named
 * in the run's file by id, so that removing the run gives them back
 * (`SyncRunRestore`).
 *
 * An update overwrote the record holding the source record's id, an upsert
 * the one holding its key, and nothing kept what they held: Review said it,
 * and no removal could take it back. DataOps' masking keeps the values it
 * masks first, and writes nothing it could not keep; so does this. A call
 * whose records' values cannot be read or kept is not sent: its rows are
 * answered refused, with why, and the run goes on with the next call.
 *
 * What is kept is what a call is about to change and nothing else: the fields
 * it writes, of the records the target holds under its key — not those an
 * upsert creates, nor those the run created itself, which its removal
 * deletes — each field of a record once, as it was before the run first wrote
 * it. A call writing a record again — the lookups a second pass sets — keeps
 * only the fields the first did not write. A field holding a file's content
 * (base64), which a query of several records does not return, is not kept.
 */

import type { BulkOperation } from '../../core/engine/BulkApiExecutor.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { OperationOutcome } from './DataSync.js';
import type { SyncCreationRecorder } from './SyncRunCreations.js';
import type { TargetWriteFields } from './targetWriteFields.js';
import { ENCRYPTED_FIELD_TYPE } from './encryptedFields.js';

/** Where the values a run writes over go before it writes: one backup of the DataOps store. */
export interface OverwriteBackup {
  /** The backup's id, which the run's file names. */
  readonly id: string;
  /**
   * Keep `records` of `objectApiName` — each its `Id` and the values of the
   * fields about to be written — on disk, before the call that writes over
   * them goes. Throws when they could not be kept.
   */
  keep(objectApiName: string, records: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/** What the keeper needs. */
export interface SyncOverwriteKeeperDeps {
  /** Every row a statement over the target returns. */
  query: (soql: string) => Promise<Array<Record<string, unknown>>>;
  backup: OverwriteBackup;
  /** The run's recorder: the records written over go into its file by id. */
  recorder: Pick<SyncCreationRecorder, 'overwriting' | 'overwrote' | 'flush' | 'unkept'>;
  /**
   * What the target says of the object's fields, the describe the write reads
   * too: a field holding a file's content is not read. Absent, every field
   * the call writes is read.
   */
  describe?: (objectApiName: string) => Promise<TargetWriteFields>;
  /**
   * Whether the run's user reads classic encrypted fields in clear
   * (`viewsEncryptedDataOnce`), asked the first time a call writes one.
   * Without it they read masked, and are not kept: the mask kept as the value
   * from before was written back by the run's removal, or counted given back.
   * Absent, they are kept as any field.
   */
  viewsEncrypted?: () => Promise<boolean>;
}

/** See the module's comment. */
export interface SyncOverwriteKeeper {
  /**
   * Before a call of `rows` of `objectName`: read what it writes over and
   * keep it. Answers why the call must not go when that could not be done,
   * nothing otherwise.
   */
  before(
    objectName: string,
    operation: BulkOperation,
    rows: ReadonlyArray<Record<string, unknown>>,
    externalIdField?: string,
  ): Promise<string | undefined>;
  /** A call answered, one outcome per row it sent: what it wrote over, and what it created. */
  answered(
    objectName: string,
    operation: BulkOperation,
    outcomes: readonly OperationOutcome[],
  ): void;
}

/**
 * The id of the backup a run keeps what it writes over in: named after the
 * run, in the letters a backup's files are named with, never `__`.
 */
export function overwriteBackupIdOf(runId: string): string {
  return `sync-before-${runId.replace(/[^A-Za-z0-9-]+/g, '-')}`.slice(0, 200);
}

/**
 * The least time between two writes of a run's backup metadata as records
 * are kept: a second. Each write is a whole write of the store VS Code keeps
 * the metadata in, and a call answers in less.
 */
export const BACKUP_META_EVERY_MS = 1_000;

/** What a backup's metadata is kept in: the config store DataOps lists its backups from. */
export interface BackupMetaStore {
  set<T>(key: string, value: T, category?: string): void;
}

/** The files of the DataOps backup store a backup's records go to (`BackupRecordStore`). */
export interface BackupRecordFiles {
  begin(operationId: string, objectApiName: string): Promise<void>;
  append(operationId: string, objectApiName: string, records: readonly unknown[]): Promise<void>;
}

/**
 * A run's backup in the DataOps store, as a DataOps backup of the target is
 * kept: its records in the store's files, one to a line, and its metadata
 * under `backup:<id>`, which lists it on the Restore tab, where it can be
 * restored or deleted, and which the retention of `sandforge.backup.maxAgeDays`
 * goes by. `origin` and `runId` say it is a Sync run's.
 *
 * The metadata is written before an object's first records, so the store's
 * sweep of files without metadata never takes them; again as records are
 * kept, {@link BACKUP_META_EVERY_MS} at most between two, marked partial,
 * with how many records it holds so far; and once the run ends (`close`),
 * whole. It was written only before the first records and at the end: a
 * window that closed under a run of one object left its backup listed on
 * the Restore tab as a whole backup of 0 records, which invited its
 * deletion, and with it what the run's removal gives back.
 */
export function storeOverwriteBackup(input: {
  runId: string;
  /** The org the run wrote to, as the Restore tab lists its backups. */
  orgId: string;
  /** Its own Organization id, when known: a restore into another org is told. */
  organizationId?: string;
  files: BackupRecordFiles;
  meta: BackupMetaStore;
  now?: () => Date;
  /** The least time between two writes of the metadata as records are kept: {@link BACKUP_META_EVERY_MS}. */
  everyMs?: number;
}): OverwriteBackup & { close(): void } {
  const id = overwriteBackupIdOf(input.runId);
  const counts = new Map<string, number>();
  const every = input.everyMs ?? BACKUP_META_EVERY_MS;
  const clock = (): number => (input.now?.() ?? new Date()).getTime();
  let timestamp: string | undefined;
  /** When the metadata was last written as records were kept. */
  let written = Number.NEGATIVE_INFINITY;
  /** The write the throttle put off, which says the last records kept within a moment. */
  let later: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const writeMeta = (partial: boolean): void => {
    if (timestamp === undefined) return;
    const objects = [...counts].map(([objectApiName, recordCount]) => ({
      objectApiName,
      recordCount,
      truncated: false,
    }));
    input.meta.set(
      `backup:${id}`,
      {
        operationId: id,
        orgId: input.orgId,
        ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        objects,
        partial,
        timestamp,
        totalRecords: objects.reduce((sum, object) => sum + object.recordCount, 0),
        origin: 'sync',
        runId: input.runId,
      },
      'backups',
    );
  };
  /** The records kept so far said, partial: now, or once the throttle allows. */
  const sayKept = (): void => {
    if (closed) return;
    const wait = written + every - clock();
    if (wait <= 0) {
      if (later !== undefined) clearTimeout(later);
      later = undefined;
      written = clock();
      writeMeta(true);
      return;
    }
    later ??= setTimeout(() => {
      later = undefined;
      if (closed) return;
      written = clock();
      try {
        writeMeta(true);
      } catch {
        // Said again by the next records kept, or whole by `close`.
      }
    }, wait);
    // A timer of its own never keeps the host, or a command line, running.
    later.unref?.();
  };
  return {
    id,
    keep: async (objectApiName, records) => {
      if (records.length === 0) return;
      if (!counts.has(objectApiName)) {
        timestamp ??= (input.now?.() ?? new Date()).toISOString();
        counts.set(objectApiName, 0);
        writeMeta(true);
        await input.files.begin(id, objectApiName);
      }
      await input.files.append(id, objectApiName, records);
      counts.set(objectApiName, (counts.get(objectApiName) ?? 0) + records.length);
      sayKept();
    },
    close: () => {
      closed = true;
      if (later !== undefined) clearTimeout(later);
      later = undefined;
      writeMeta(false);
    },
  };
}

/** Records one statement names at most: what one `IN` list holds, short enough for a URL. */
const KEYS_PER_QUERY = 200;

/** Columns past which a statement names fewer records, so it stays short enough for a URL. */
const WIDE_COLUMNS = 100;

/** The most characters the `IN` list of one statement takes: an external id can be long. */
const KEY_CHARACTERS_PER_QUERY = 4_000;

/** A record by its first fifteen characters: the same record, whichever length its id is in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * A value of the key a call matches records on, as the target compares it:
 * an id by its first fifteen characters, as written; a text external id
 * without regard to case, as Salesforce matches one; a number as a number.
 * Undefined for a row that carries none.
 */
function keyOf(value: unknown, byId: boolean): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `#${value}`;
  if (typeof value !== 'string' || value === '') return undefined;
  return byId ? recordKey(value) : value.toLowerCase();
}

/** A key's value as an `IN` list carries it. */
function literalOf(value: unknown): string {
  return typeof value === 'number' ? String(value) : `'${sanitizeSoqlValue(String(value))}'`;
}

/** Values in lists one statement each, by count and by length. */
function inLists(values: readonly unknown[], perQuery: number): string[][] {
  const lists: string[][] = [];
  let list: string[] = [];
  let length = 0;
  for (const value of values) {
    const literal = literalOf(value);
    if (
      list.length > 0 &&
      (list.length >= perQuery || length + literal.length > KEY_CHARACTERS_PER_QUERY)
    ) {
      lists.push(list);
      list = [];
      length = 0;
    }
    list.push(literal);
    length += literal.length + 2;
  }
  if (list.length > 0) lists.push(list);
  return lists;
}

/** Why a call is not sent: what it would have written over could not be kept. */
function refusalOf(objectName: string, rows: number, err: unknown): string {
  return (
    `What these ${rows} ${objectName} record(s) would write over in the target could not be ` +
    `read and kept first (${extractErrorMessage(err)}), so none of them was written: a run ` +
    'writes over nothing it cannot put back.'
  );
}

/**
 * The keeper of one run: see the module's comment.
 *
 * @param deps - The target's reads, the backup, the run's recorder.
 */
export function syncOverwriteKeeper(deps: SyncOverwriteKeeperDeps): SyncOverwriteKeeper {
  /** Per object, per record, the fields whose values from before are kept, and written over. */
  const kept = new Map<string, Map<string, Set<string>>>();
  /**
   * Per object, per record, the fields the backup holds the values of: those
   * a call the target then refused kept too, which its rows sent again find
   * there, unchanged, and do not add a second time.
   */
  const inBackup = new Map<string, Map<string, Set<string>>>();
  /** The records the run created, by key: its removal deletes them, so nothing of them is kept. */
  const created = new Set<string>();
  /**
   * Per object, the call under way that names records: the record each row
   * reaches, those named, and the fields it kept of each.
   */
  const calls = new Map<
    string,
    {
      reaches: Array<string | undefined>;
      named: string[];
      added: ReadonlyMap<string, ReadonlySet<string>>;
    }
  >();
  /** Per object, the fields that hold a file's content, read once. */
  const unreadable = new Map<string, Promise<ReadonlySet<string>>>();
  /** Per object, the encrypted fields the run's user reads masked, read once. */
  const maskedOf = new Map<string, Promise<ReadonlySet<string>>>();
  /** Per object, the encrypted fields its file names as not kept already. */
  const unkeptNamed = new Map<string, Set<string>>();

  const maskedFieldsOf = (objectName: string): Promise<ReadonlySet<string>> => {
    const describe = deps.describe;
    const views = deps.viewsEncrypted;
    if (!describe || !views) return Promise.resolve(new Set());
    let fields = maskedOf.get(objectName);
    if (!fields) {
      fields = describe(objectName).then(
        async (answer) => {
          const encrypted = (answer.fields ?? [])
            .filter((field) => field.type === ENCRYPTED_FIELD_TYPE)
            .map((field) => field.name);
          return encrypted.length > 0 && !(await views()) ? new Set(encrypted) : new Set<string>();
        },
        () => new Set<string>(),
      );
      maskedOf.set(objectName, fields);
    }
    return fields;
  };

  const contentFieldsOf = (objectName: string): Promise<ReadonlySet<string>> => {
    const describe = deps.describe;
    if (!describe) return Promise.resolve(new Set());
    let fields = unreadable.get(objectName);
    if (!fields) {
      fields = describe(objectName).then(
        (answer) =>
          new Set(
            (answer.fields ?? [])
              .filter((field) => field.type === 'base64' || field.queryable === false)
              .map((field) => field.name),
          ),
        () => new Set<string>(),
      );
      unreadable.set(objectName, fields);
    }
    return fields;
  };

  return {
    before: async (objectName, operation, rows, externalIdField) => {
      calls.delete(objectName);
      if ((operation !== 'update' && operation !== 'upsert') || rows.length === 0) return undefined;
      const keyField = operation === 'update' ? 'Id' : (externalIdField ?? 'Id');
      const byId = keyField === 'Id';
      try {
        assertSoqlIdentifier(objectName);
        assertSoqlIdentifier(keyField);
        const skipped = await contentFieldsOf(objectName);
        const masked = await maskedFieldsOf(objectName);
        /** The fields the call writes, of every row. */
        const fields = new Set<string>();
        /** The encrypted fields it writes that the run's user reads masked: not kept. */
        const maskedWritten = new Set<string>();
        /** One value of each key the rows carry, as the statement names it. */
        const values = new Map<string, unknown>();
        for (const row of rows) {
          const key = keyOf(row[keyField], byId);
          if (key !== undefined && !values.has(key)) values.set(key, row[keyField]);
          for (const [field, value] of Object.entries(row)) {
            if (field === 'Id' || field === keyField || field === 'attributes') continue;
            if (skipped.has(field)) continue;
            if (typeof value === 'object' && value !== null) continue;
            if (masked.has(field)) {
              maskedWritten.add(field);
              continue;
            }
            fields.add(assertSoqlIdentifier(field));
          }
        }
        if (values.size === 0 || (fields.size === 0 && maskedWritten.size === 0)) return undefined;

        // What the target holds under each key, of the fields the call writes.
        const columns = ['Id', ...(byId ? [] : [keyField]), ...fields];
        const perQuery = columns.length > WIDE_COLUMNS ? KEYS_PER_QUERY / 4 : KEYS_PER_QUERY;
        const held = new Map<string, Array<Record<string, unknown>>>();
        for (const list of inLists([...values.values()], perQuery)) {
          const rowsHeld = await deps.query(
            `SELECT ${columns.join(', ')} FROM ${objectName} WHERE ${keyField} IN (${list.join(', ')})`,
          );
          for (const record of rowsHeld) {
            const key = keyOf(byId ? record.Id : record[keyField], byId);
            if (key === undefined || typeof record.Id !== 'string') continue;
            held.set(key, [...(held.get(key) ?? []), record]);
          }
        }

        // Of each row, the record it reaches — one the target holds alone
        // under its key — and what of it is not kept yet.
        const ofObject = kept.get(objectName) ?? new Map<string, Set<string>>();
        const reaches: Array<string | undefined> = [];
        const keeping = new Map<string, Record<string, unknown>>();
        const fieldsOf = new Map<string, Set<string>>();
        for (const row of rows) {
          const key = keyOf(row[keyField], byId);
          const found = key === undefined ? undefined : held.get(key);
          const record = found?.length === 1 ? found[0] : undefined;
          const id = record?.Id as string | undefined;
          reaches.push(id);
          if (!record || id === undefined || created.has(recordKey(id))) continue;
          const already = ofObject.get(recordKey(id));
          const values: Record<string, unknown> = keeping.get(recordKey(id)) ?? { Id: id };
          const adding = fieldsOf.get(recordKey(id)) ?? new Set<string>();
          for (const field of Object.keys(row)) {
            if (!fields.has(field) || already?.has(field) || field in values) continue;
            values[field] = record[field] ?? null;
            adding.add(field);
          }
          if (adding.size === 0) continue;
          keeping.set(recordKey(id), values);
          fieldsOf.set(recordKey(id), adding);
        }
        // Of a record the target holds, an encrypted field read masked is
        // not kept, and the run's file says so: its removal leaves it as the
        // run wrote it, and says why.
        if (
          maskedWritten.size > 0 &&
          reaches.some((id) => id !== undefined && !created.has(recordKey(id)))
        ) {
          const named = unkeptNamed.get(objectName) ?? new Set<string>();
          const fresh = [...maskedWritten].filter((field) => !named.has(field));
          if (fresh.length > 0) {
            for (const field of fresh) named.add(field);
            unkeptNamed.set(objectName, named);
            deps.recorder.unkept?.(objectName, fresh);
          }
        }
        if (keeping.size === 0) {
          calls.set(objectName, { reaches, named: [], added: new Map() });
          return undefined;
        }

        // On disk before the call goes: the values in the backup — but
        // those it holds already — and the records it names in the run's file.
        const records = [...keeping.values()];
        const stored = inBackup.get(objectName) ?? new Map<string, Set<string>>();
        const toKeep = records.flatMap((record) => {
          const known = stored.get(recordKey(record.Id as string));
          const fresh = Object.entries(record).filter(
            ([field]) => field === 'Id' || !known?.has(field),
          );
          return fresh.length > 1 ? [Object.fromEntries(fresh)] : [];
        });
        if (toKeep.length > 0) await deps.backup.keep(objectName, toKeep);
        for (const record of toKeep) {
          const known = stored.get(recordKey(record.Id as string)) ?? new Set<string>();
          for (const field of Object.keys(record)) if (field !== 'Id') known.add(field);
          stored.set(recordKey(record.Id as string), known);
        }
        inBackup.set(objectName, stored);
        const named = records.map((record) => record.Id as string);
        deps.recorder.overwriting?.(objectName, deps.backup.id, named);
        const unkept = await deps.recorder.flush();
        if (unkept !== undefined) throw new Error(`the run's file could not be written: ${unkept}`);
        for (const [key, adding] of fieldsOf) {
          const known = ofObject.get(key) ?? new Set<string>();
          for (const field of adding) known.add(field);
          ofObject.set(key, known);
        }
        kept.set(objectName, ofObject);
        calls.set(objectName, { reaches, named, added: fieldsOf });
        return undefined;
      } catch (err: unknown) {
        return refusalOf(objectName, rows.length, err);
      }
    },
    answered: (objectName, operation, outcomes) => {
      if (operation === 'insert' || operation === 'upsert') {
        for (const outcome of outcomes) {
          if (
            outcome.success &&
            typeof outcome.id === 'string' &&
            outcome.id !== '' &&
            (operation === 'insert' || outcome.created === true)
          ) {
            created.add(recordKey(outcome.id));
          }
        }
      }
      const call = calls.get(objectName);
      calls.delete(objectName);
      if (!call || call.named.length === 0) return;
      // Written over: a row the target took, onto the record it reaches. A
      // row it created — the record was gone by then — wrote over nothing.
      const written = new Set<string>();
      outcomes.forEach((outcome, at) => {
        const id = call.reaches[at];
        if (id !== undefined && outcome.success && outcome.created !== true) {
          written.add(recordKey(id));
        }
      });
      const notWritten = call.named.filter((id) => !written.has(recordKey(id)));
      // What a call the target refused kept is kept again by the call that
      // sends its rows again — without the owner the target did not have, a
      // field a rule refused: kept as written already, the call that wrote
      // the record named none of it, and its removal had nothing to give back.
      const ofObject = kept.get(objectName);
      for (const id of notWritten) {
        const known = ofObject?.get(recordKey(id));
        for (const field of call.added.get(recordKey(id)) ?? []) known?.delete(field);
      }
      deps.recorder.overwrote?.(objectName, notWritten);
    },
  };
}
