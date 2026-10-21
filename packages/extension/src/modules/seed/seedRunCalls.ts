/**
 * The calls a writer of the Seed page sends (`BulkDataWriter`), kept by the
 * run's recorder as they go: a CSV import and a clone from another org write
 * through it, and what they created is kept the way a seed's is
 * (`SeedRunCreations`), so that it can be taken back.
 *
 * Each insert or upsert call is kept before it goes, a Bulk API job again
 * with its id once the org has opened it, and what the call created once it
 * answers: every row an insert wrote, the rows of an upsert the org says it
 * created (`createdIds`). An update or a delete creates nothing of the run's,
 * and is not kept: the records an upsert or an update wrote over were the
 * target's before.
 */

import type { BulkOperation } from '../../core/engine/BulkApiExecutor.js';
import { createdIds, type WriterCalls } from '../sync/BulkDataWriter.js';
import type { SeedRunRecorder } from './SeedRunCreations.js';

/** Whether a call of `operation` can create a record of the run's. */
function creates(operation: BulkOperation): operation is 'insert' | 'upsert' {
  return operation === 'insert' || operation === 'upsert';
}

/**
 * The writer's calls, kept by `recorder`.
 *
 * @param onCreated - Told how many records each call created: what the run
 *   created in all, which says whether it left anything to take back.
 */
export function seedWriterCalls(
  recorder: Pick<SeedRunRecorder, 'sending' | 'answered'>,
  onCreated?: (count: number) => void,
): WriterCalls {
  return {
    sending: (objectName, operation, rows) => {
      if (!creates(operation)) return;
      recorder.sending(objectName, rows, operation === 'upsert' ? { upsert: true } : undefined);
    },
    opened: (objectName, operation, rows, jobId) => {
      if (!creates(operation)) return;
      recorder.sending(objectName, rows, {
        job: jobId,
        ...(operation === 'upsert' ? { upsert: true } : {}),
      });
    },
    answered: (objectName, operation, outcomes) => {
      if (!creates(operation)) return;
      const created = createdIds(operation, outcomes);
      recorder.answered(objectName, created);
      onCreated?.(created.length);
    },
  };
}
