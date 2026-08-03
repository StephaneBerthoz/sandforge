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
import type { FrozenDmlWriter } from './loadTypes.js';

/** Default REST batch size delegated to the writer. */
export const DEFAULT_FROZEN_LOAD_BATCH_SIZE = 200;

/** Adapt a {@link BulkDataWriter} to the frozen-load DML interface. */
export function createBulkDmlWriter(
  writer: BulkDataWriter,
  batchSize: number = DEFAULT_FROZEN_LOAD_BATCH_SIZE,
): FrozenDmlWriter {
  return {
    insert: (_orgId, objectApiName, records) => writer.insert(objectApiName, records, batchSize),
    update: (_orgId, objectApiName, records) => writer.update(objectApiName, records, batchSize),
    delete: (_orgId, objectApiName, recordIds) =>
      writer.delete(objectApiName, recordIds, batchSize),
  };
}
