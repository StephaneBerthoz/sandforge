/**
 * How a Seed run writes the records of one object: the panel's write path,
 * which the command line takes too.
 *
 * Past {@link STREAMING_THRESHOLD} records, one Bulk API 2.0 job whose records
 * are gathered a chunk at a time, the cancel looked at between two, and
 * uploaded once (`ChunkedBulkExecutor`). Past the Bulk API threshold — 200 by
 * default, `RobustnessConfig.bulk.threshold` — one Bulk API job, unless an
 * active duplicate rule watches the object: a job carries no header that lets
 * the rule's matches be saved, so such an object goes through REST. Under the
 * threshold, REST calls of `batchSize` records, each tried again on what a
 * retry can cure. A cancel stops the write before its next call, or aborts a
 * job still open.
 *
 * The command line wrote by REST alone, 200 records a call, whatever the
 * object held: a seed of 10 500 records took 53 calls where the panel opened
 * one job, and the panel's bulk path, its job limits and its chunked upload
 * were never run outside the editor.
 */

import { recordWriteHeaders } from '@sandforge/shared';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkExecutionResult,
} from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import type { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import {
  bulkSaveErrorDetail,
  recordErrorText,
  saveErrorDetail,
} from '../../core/common/existingRecordMatch.js';
import type { InsertedRow, InsertResult } from './SeedOrchestrator.js';
import { objectsUnderDuplicateRules } from './seedDuplicateRules.js';

/** Records of one object past which the write goes as one job uploaded a chunk at a time. */
export const STREAMING_THRESHOLD = 10_000;

/**
 * What a Bulk API job answered for each record, in the order sent, its
 * refusals read with the code and fields of their `sf__Error`
 * (`bulkSaveErrorDetail`): what a row refused on a field a validation rule
 * named is sent again from. Nothing when the job's answer cannot be laid on
 * the records one for one — a row matched to none, a record written without
 * its id said — or when the cancel aborted it: a row is never sent again on a
 * guess.
 */
export function bulkRows(result: BulkExecutionResult, sent: number): InsertedRow[] | undefined {
  if (result.aborted || result.outcomes.length !== sent || (result.unmatchedIds?.length ?? 0) > 0) {
    return undefined;
  }
  if (result.failures.some((failure) => failure.recordIndex < 0)) return undefined;
  const rows: InsertedRow[] = new Array<InsertedRow>(sent);
  for (const outcome of result.outcomes) {
    if (outcome.recordIndex < 0 || outcome.recordIndex >= sent) return undefined;
    if (outcome.success) {
      if (!outcome.id) return undefined;
      rows[outcome.recordIndex] = { id: outcome.id };
    } else {
      const error = outcome.error ?? 'Unknown error';
      const detail = bulkSaveErrorDetail(error);
      rows[outcome.recordIndex] = { error, ...(detail ? { errorDetails: [detail] } : {}) };
    }
  }
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** What a seed writes through: the org's REST API, its Bulk API, and its duplicate rules. */
export interface SeedInsertConnection extends BulkApiConnection {
  sobject: (objectApiName: string) => {
    create: (
      records: Record<string, unknown>[],
      options: { headers: Record<string, string> },
    ) => Promise<unknown>;
  };
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}

/** What {@link seedInsert} writes with. */
export interface SeedInsertDeps {
  conn: SeedInsertConnection;
  /** Records of one insert past which it goes as a Bulk API job (`RobustnessConfig.bulk.threshold`). */
  bulkThreshold: number;
  /** The Bulk API job limiter of the run. */
  bulkManager: BulkApiManager;
  /** How a REST call the org failed on is tried again. */
  retry: RetryableOperation;
  /** The run's cancel. */
  signal: AbortSignal;
  /** Who the log lines are of: `seed:execute <operation>` in the panel. */
  label: string;
  /** A line for the run's log: an object sent through REST for a duplicate rule, a rule not read. */
  log: (line: string) => void;
  /** Told as a bulk insert goes: the records processed of the insert's, and what it is. */
  onProgress: (processed: number, total: number, step: string) => void;
}

/** The orchestrator's `insert`, the panel's and the command line's. */
export type SeedInsert = (
  orgId: string,
  objectApiName: string,
  records: Record<string, unknown>[],
  batchSize: number,
) => Promise<InsertResult>;

/** The write path of a seed: see the module's comment. */
export function seedInsert(deps: SeedInsertDeps): SeedInsert {
  const { conn, bulkManager, retry, signal, label } = deps;
  const bulkExecutor = new BulkApiExecutor(deps.bulkThreshold);
  // An object an active duplicate rule watches goes through REST, whose
  // header lets the rule's matches be saved, rather than as a Bulk API job,
  // which carries none (`objectsUnderDuplicateRules`). Read once for the run.
  let duplicateRules: Promise<ReadonlySet<string> | undefined> | undefined;
  const watchedByDuplicateRule = async (objectApiName: string): Promise<boolean> => {
    duplicateRules ??= objectsUnderDuplicateRules(conn).then((ruled) => {
      if (!ruled) {
        deps.log(
          `[WARN] ${label}: the org's duplicate rules could not be read: ` +
            'an object of more than the Bulk API threshold goes as a Bulk API job, which a ' +
            'duplicate rule may refuse',
        );
      }
      return ruled;
    });
    const watched = (await duplicateRules)?.has(objectApiName) === true;
    if (watched) {
      deps.log(
        `[INFO] ${label}: ${objectApiName} goes through REST: an active ` +
          'duplicate rule watches it, which a Bulk API job cannot waive',
      );
    }
    return watched;
  };

  return async (_orgId, objectApiName, records, batchSize) => {
    // Streaming path for large record sets
    if (records.length > STREAMING_THRESHOLD) {
      // A cancel that came before the insert opens no job: see the Bulk
      // API path.
      if (signal.aborted) return { successIds: [], errors: [], stopped: true };
      const chunkedExecutor = new ChunkedBulkExecutor({ signal });
      const bulkDeps: BulkApiExecutorDeps = {
        connection: conn,
        bulkManager,
        onProgress: (processed, total) => {
          deps.onProgress(processed, total, `Streaming insert ${objectApiName}`);
        },
      };
      const streamResult = await chunkedExecutor.executeChunked(
        bulkDeps,
        objectApiName,
        'insert',
        chunkedExecutor.createChunkGenerator(records),
        records.length,
      );
      return {
        successIds: streamResult.successIds,
        errors: streamResult.errors,
        // An upload the cancel stopped answers with nothing written: told
        // nothing more, the run went on to the next object.
        ...(streamResult.aborted ? { stopped: true } : {}),
      };
    }

    if (
      bulkExecutor.shouldUseBulkApi(records.length) &&
      !(await watchedByDuplicateRule(objectApiName))
    ) {
      // Bulk API 2.0 path. A cancel that came before the insert opens no
      // job: the executor opened one all the same, then aborted it before
      // its upload, which wrote nothing but asked the org for a job, and
      // for its abort, for an insert that never started.
      if (signal.aborted) return { successIds: [], errors: [], stopped: true };
      const bulkDeps: BulkApiExecutorDeps = {
        connection: conn,
        bulkManager,
        onProgress: (processed, total) => {
          deps.onProgress(processed, total, `Bulk insert ${objectApiName}`);
        },
        signal,
      };
      const bulkResult = await bulkExecutor.executeBulk(bulkDeps, objectApiName, 'insert', records);
      const rows = bulkRows(bulkResult, records.length);
      return {
        successIds: bulkResult.successIds,
        errors: bulkResult.failures.map((f) => f.error),
        ...(rows ? { rows } : {}),
        // The cancel aborted the job before it was closed, as it does a
        // streamed upload: none of its records was written.
        ...(bulkResult.aborted ? { stopped: true } : {}),
      };
    }

    // REST API path with retry and batching
    const successIds: string[] = [];
    const errors: string[] = [];
    // What the org answered per record, in order: a row refused on fields
    // a validation rule named is sent again without them from it.
    const rows: InsertedRow[] = [];

    for (let i = 0; i < records.length; i += batchSize) {
      // A cancel stops the insert before each batch, with what the
      // batches before it created: the rest of a large object used to be
      // inserted after the seed was cancelled. The first batch included,
      // as in the writer Sync writes through: the run looks at the cancel
      // just before it inserts, and nothing between the two waits today,
      // but a cancel that came between them would still send a batch.
      if (signal.aborted) {
        return { successIds, errors, rows, stopped: true };
      }
      const batch = records.slice(i, i + batchSize);
      const retryResult = await retry.execute(async () => {
        // Seeded rows are invented and land in an org that may already
        // hold rows like them — a duplicate rule stops exactly that. Forge
        // learnt it in 1.25.3 and Sync in 1.28.0; a hundred seeded
        // contacts were refused here for want of the same header. A
        // unique index still refuses, which is right.
        return conn
          .sobject(objectApiName)
          .create(batch, { headers: recordWriteHeaders() }) as Promise<
          Array<{ success: boolean; id?: string; errors?: Array<{ message: string }> }>
        >;
      });
      // The batch failed and the cancel came before it was tried again:
      // none of it was created, and nothing after it is sent.
      if (retryResult.cancelled) return { successIds, errors, rows, stopped: true };

      if (retryResult.success && retryResult.result) {
        for (const r of retryResult.result) {
          if (r.success && r.id) {
            successIds.push(r.id);
            rows.push({ id: r.id });
          } else {
            const error = recordErrorText(r.errors);
            errors.push(error);
            rows.push({ error, errorDetails: (r.errors ?? []).map(saveErrorDetail) });
          }
        }
      } else {
        // The whole batch is lost, not one record: `errors.length` is what
        // SeedOrchestrator reports as recordsFailed, so a single push made
        // a 180-record wipe-out read as "1 failed".
        const failMsg = retryResult.error?.message ?? 'Insert failed after retries';
        for (let k = 0; k < batch.length; k++) {
          errors.push(failMsg);
          rows.push({ error: failMsg });
        }
      }
    }

    return { successIds, errors, rows };
  };
}
