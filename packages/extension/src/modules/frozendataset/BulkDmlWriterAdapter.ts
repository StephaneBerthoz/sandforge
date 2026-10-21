/**
 * Adapter from the existing `BulkDataWriter` (modules/sync — streaming,
 * Bulk API 2.0 and REST batch paths with retry) to the narrow
 * {@link FrozenDmlWriter} interface consumed by the frozen-dataset loader.
 *
 * The writer is already bound to a connection (hence an org), so the
 * `orgId` parameter of the interface is accepted for signature uniformity
 * and ignored.
 */

import type { BulkDataWriter, WriterCalls } from '../sync/BulkDataWriter.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import { WriteCancelledError } from '../sync/WriteCancelledError.js';
import type { FrozenDmlWriter } from './loadTypes.js';

/** Default REST batch size delegated to the writer. */
export const DEFAULT_FROZEN_LOAD_BATCH_SIZE = 200;

/** Adapt a {@link BulkDataWriter} to the frozen-load DML interface. */
export function createBulkDmlWriter(
  writer: BulkDataWriter,
  batchSize: number = DEFAULT_FROZEN_LOAD_BATCH_SIZE,
): FrozenDmlWriter {
  return {
    insert: (_orgId, objectApiName, records, onAnswered) =>
      writtenBeforeTheCancel(
        writer.insert(
          objectApiName,
          records,
          batchSize,
          onAnswered ? answeredInOrder(onAnswered) : undefined,
        ),
      ),
    update: (_orgId, objectApiName, records) =>
      writtenBeforeTheCancel(writer.update(objectApiName, records, batchSize)),
    delete: (_orgId, objectApiName, recordIds) =>
      writtenBeforeTheCancel(writer.delete(objectApiName, recordIds, batchSize)),
  };
}

/**
 * The calls of one insert told to `onAnswered` as each answers, with the
 * place of its first record among the insert's: the calls go in the order of
 * the records, one after the other, each the records it said it sends —
 * answered with an outcome per record, or fewer when the answer was cut
 * short, and none for a job the cancel aborted, whose records go nowhere.
 */
function answeredInOrder(
  onAnswered: (offset: number, outcomes: readonly OperationOutcome[]) => void,
): WriterCalls {
  let offset = 0;
  let sent = 0;
  return {
    sending: (_objectName, _operation, rows) => {
      sent = rows;
    },
    answered: (_objectName, _operation, outcomes) => {
      onAnswered(offset, outcomes);
      offset += sent;
      sent = 0;
    },
  };
}

/**
 * What a write answered, or what it wrote before the load's cancel stopped it:
 * nothing for a write the cancel came before, or an upload aborted while its
 * job was open, the outcomes of the batches sent for a REST write stopped
 * before one of them. The loader reads them record by record and stops at its
 * next check of the cancel, with its mapping kept; raised through it, the
 * cancel would end the load as a failure before that mapping was kept.
 */
async function writtenBeforeTheCancel(
  write: Promise<OperationOutcome[]>,
): Promise<OperationOutcome[]> {
  try {
    return await write;
  } catch (err: unknown) {
    if (err instanceof WriteCancelledError) return err.written;
    throw err;
  }
}
