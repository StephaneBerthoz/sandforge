/**
 * What a Real-Time session writes into its target, kept as a Sync run keeps
 * it (`SyncRunCreations`), so that the Sync page takes it back as it takes a
 * run back: the records the session creates, the values of the records it
 * writes over — kept first in the DataOps backup store, as a run's are
 * (`syncOverwrites`) — and the records it deletes as the source deleted
 * them, which its removal brings back from the recycle bin.
 *
 * A session kept none of it. The box that turns its writes on said so, and
 * sent the user to a DataOps backup of the target taken beforehand, or to
 * `sandforge-cleanup`, which deletes whatever the user created in a window
 * of time, the session's or not. The session's file is begun with its first
 * write and ended once it stops: a host that closes under it leaves what it
 * wrote so far removable, as a run's.
 */

import type { RealTimeSyncMetrics, SyncOperation } from '@sandforge/shared';
import { createdIds, syncWriterCalls, type WriterCalls } from '../sync/BulkDataWriter.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import { viewsEncryptedDataOnce } from '../sync/encryptedFields.js';
import type { SyncRunCreations } from '../sync/SyncRunCreations.js';
import {
  storeOverwriteBackup,
  syncOverwriteKeeper,
  type BackupMetaStore,
  type BackupRecordFiles,
} from '../sync/syncOverwrites.js';
import { targetWriteFieldsOf } from '../sync/targetWriteFields.js';
import type { OrgReader, TargetWrite } from './RealtimeApplier.js';

/** How a session ended, as its file and the audit trail say it. */
export type SessionStatus = 'success' | 'partial' | 'failure';

/**
 * How a session ended, by the changes it wrote and those it could not: a
 * success when none failed, partial when some were written as well.
 */
export function sessionStatusOf(
  metrics: Pick<RealTimeSyncMetrics, 'eventsApplied' | 'eventsFailed'>,
): SessionStatus {
  if (metrics.eventsFailed === 0) return 'success';
  return metrics.eventsApplied > 0 ? 'partial' : 'failure';
}

/** What a session's record needs. */
export interface SessionRunDeps {
  /** The session's id: its file is kept under it, and its removal named by it. */
  sessionId: string;
  sourceOrgId: string;
  targetOrgId: string;
  /** Where every Sync run keeps what it wrote. */
  store: Pick<SyncRunCreations, 'recorder'>;
  /**
   * The files of the DataOps backup store, which the values of what it writes
   * over go to first. Absent, nothing it writes over is kept, and its removal
   * gives nothing back.
   */
  backups?: BackupRecordFiles;
  /** Where the backup's metadata goes: the Restore tab lists it from there. */
  meta: BackupMetaStore;
  /** The target, as the session reads it: what a write is about to write over is read there. */
  target: OrgReader;
  log: (message: string) => void;
}

/** One session's record: see the module's comment. */
export interface SessionRun {
  /** The id its file is kept under: the session's. */
  readonly runId: string;
  /**
   * Told of each call the session's writer sends (`BulkDataWriterDeps.calls`):
   * what a call writes over is kept before it goes, and what it creates is
   * written down as it answers (`syncWriterCalls`).
   */
  readonly calls: WriterCalls;
  /**
   * The session's write to its target, through `inner`, one write at a time,
   * the records each delete took written down. A change decided on the
   * Conflicts tab is written while the session writes what it receives: two
   * calls of one object at once would each read the other's as their own.
   */
  write(inner: TargetWrite): TargetWrite;
  /** Whether its end is written, or on its way: nothing it writes after is the session's own. */
  readonly ended: boolean;
  /**
   * Write how the session ended, once: a second call waits on the first. Its
   * backup is said whole.
   *
   * @returns Why some of what it wrote could not be kept, once; nothing when
   *   all of it was.
   */
  end(ending: { status: SessionStatus; cancelled?: boolean }): Promise<string | undefined>;
}

/** A record by its first fifteen characters: the same, whichever length its id is in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * The record of one session, its file begun with its first write.
 *
 * @param deps - The session, the stores, and the target.
 */
export function openSessionRun(deps: SessionRunDeps): SessionRun {
  const recorder = deps.store.recorder({
    runId: deps.sessionId,
    // No configuration ran: an id no saved one has, so that its removal
    // marks none of them to be read whole, and forgets none of their pairs.
    configId: `realtime:${deps.sessionId}`,
    configName: '',
    sourceOrgId: deps.sourceOrgId,
    targetOrgId: deps.targetOrgId,
    realtime: true,
  });
  const backup = deps.backups
    ? storeOverwriteBackup({
        runId: deps.sessionId,
        orgId: deps.targetOrgId,
        files: deps.backups,
        meta: deps.meta,
      })
    : undefined;
  const targetRows = (soql: string): Promise<Array<Record<string, unknown>>> =>
    deps.target.query(soql);
  const keeper = backup
    ? syncOverwriteKeeper({
        query: targetRows,
        backup,
        recorder,
        describe: async (objectApiName) =>
          targetWriteFieldsOf(await deps.target.describe(objectApiName)),
        // An encrypted field the session's user reads masked is not kept.
        viewsEncrypted: viewsEncryptedDataOnce(targetRows),
      })
    : undefined;

  /**
   * The records the session created. A record it created and then deleted,
   * as the source did, is not one its removal brings back from the recycle
   * bin: its removal deletes what it created, and would delete it again.
   */
  const created = new Set<string>();
  const noteAnswer = (
    objectApiName: string,
    operation: SyncOperation,
    records: ReadonlyArray<Record<string, unknown>>,
    outcomes: readonly OperationOutcome[],
  ): void => {
    if (operation === 'insert' || operation === 'upsert') {
      for (const id of createdIds(operation, outcomes)) created.add(recordKey(id));
      return;
    }
    if (operation !== 'delete') return;
    const deleted = records.flatMap((record, at) => {
      const id = record.Id;
      return outcomes[at]?.success === true && typeof id === 'string' && !created.has(recordKey(id))
        ? [id]
        : [];
    });
    if (deleted.length > 0) recorder.deleted?.(objectApiName, deleted);
  };

  let ending: Promise<string | undefined> | undefined;
  return {
    runId: deps.sessionId,
    calls: syncWriterCalls(recorder, keeper),
    write: (inner) => {
      let queue: Promise<unknown> = Promise.resolve();
      return (config, records, contactPoints) => {
        const next = queue.then(async () => {
          const answer = await inner(config, records, contactPoints);
          noteAnswer(config.objectApiName, config.operation, records, answer.outcomes);
          return answer;
        });
        queue = next.catch(() => undefined);
        return next;
      };
    },
    get ended() {
      return ending !== undefined;
    },
    end: (how) => {
      ending ??= (async () => {
        await recorder.end({ status: how.status, ...(how.cancelled ? { cancelled: true } : {}) });
        try {
          backup?.close();
        } catch (err: unknown) {
          deps.log(
            `[WARN] realtime ${deps.sessionId}: the backup of what it wrote over could not be ` +
              `listed whole: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return recorder.flush();
      })();
      return ending;
    },
  };
}
