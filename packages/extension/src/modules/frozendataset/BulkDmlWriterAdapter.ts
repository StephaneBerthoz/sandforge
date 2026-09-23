/**
 * Adapter from the existing `BulkDataWriter` (modules/sync — streaming,
 * Bulk API 2.0 and REST batch paths with retry) to the narrow
 * {@link FrozenDmlWriter} interface consumed by the frozen-dataset loader.
 *
 * The writer is already bound to a connection (hence an org), so the
 * `orgId` parameter of the interface is accepted for signature uniformity
 * and ignored.
 */

import type { BulkDataWriter } from '../sync/BulkDataWriter.js';
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
    insert: (_orgId, objectApiName, records) =>
      writtenBeforeTheCancel(writer.insert(objectApiName, records, batchSize)),
    update: (_orgId, objectApiName, records) =>
      writtenBeforeTheCancel(writer.update(objectApiName, records, batchSize)),
    delete: (_orgId, objectApiName, recordIds) =>
      writtenBeforeTheCancel(writer.delete(objectApiName, recordIds, batchSize)),
  };
}

/**
 * What a write answered, or what it wrote before the load's cancel stopped it:
 * nothing for an upload aborted while its job was open, the outcomes of the
 * batches sent for a REST write stopped between two of them. The loader reads
 * them record by record and stops at its next check of the cancel, with its
 * mapping kept; raised through it, the cancel would end the load as a failure
 * before that mapping was kept.
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
