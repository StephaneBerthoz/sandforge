/**
 * The API requests a Frozen load takes of its target, for the gate that holds
 * it to what the target has left today, before anything is taken for it: the
 * gate Seed, Sync, the CSV import, the clone and Autopilot already had.
 *
 * A load read no limit of its target's requests, and the lease of the mute
 * it was asked to hold was counted nowhere: a load into an org whose
 * integrations had spent the day's requests, or a reload of a dataset larger
 * than what was left, stopped part way through, its records refused with
 * REQUEST_LIMIT_EXCEEDED, with the purge of the loads before it already sent.
 */

import { importRequestsEstimate, importRunReads } from '../seed/seedStorage.js';
import { DEFAULT_FROZEN_LOAD_BATCH_SIZE } from './BulkDmlWriterAdapter.js';

/**
 * The ids of a load's records one count of its verification reads
 * (`PostLoadVerifier`'s `ID_CHUNK`): a `SELECT COUNT()` per 200 of them.
 */
const VERIFY_IDS_PER_COUNT = 200;

/** What a load's requests are priced on, read before its gate. */
export interface LoadRequestsInput {
  /** The records it inserts, per object: the dataset's, at most, as Production Guard counts a load. */
  inserts: ReadonlyArray<{ objectApiName: string; rows: number }>;
  /**
   * On a reload, the records of the loads before it its purge takes, per
   * object: deleted, or set inactive (`deletes: false`) where the object is
   * one the platform does not delete.
   */
  purged?: ReadonlyArray<{ objectApiName: string; rows: number; deletes: boolean }>;
  /** Records past which the writer sends an object as one Bulk API job. */
  threshold: number;
  /** Whether a duplicate rule watches each object, as the read of the target's automation found the rules. */
  duplicateRules?: ReadonlyMap<string, boolean>;
  /** What the read of the target's automation, sent just before the gate, sent (`automationReadRequests`). */
  automationRead?: number;
}

/**
 * The API requests a load makes of its target, roughly, from its gate on: its
 * inserts and, on a reload, its purge, as the writer of the CSV import and of
 * the clone sends them (`importRequestsEstimate`) — the load writes through
 * the same writer, 200 records a REST call up to the Bulk API threshold, one
 * job past it —; each object's describe, its gate's read of the limits, who
 * it writes as, and the read of the target's automation it sent just before
 * (`importRunReads`); and the counts of its verification, chained after it,
 * one per 200 records it wrote of each object.
 *
 * What the load cannot know before it writes is left out: the second pass of
 * the lookups a cycle leaves empty, the rows a validation rule refused sent
 * again without its fields, the records a reload finds again by their keys,
 * the catalog and the record types it looks up, and what a sweep asked with
 * a reload deletes, whose removal no gate prices, as no removal's is.
 */
export function loadRequestsEstimate(input: LoadRequestsInput): number {
  const path = {
    threshold: input.threshold,
    perCall: DEFAULT_FROZEN_LOAD_BATCH_SIZE,
    ...(input.duplicateRules ? { duplicateRules: input.duplicateRules } : {}),
  };
  const inserted = input.inserts.filter(({ rows }) => rows > 0);
  const verified = inserted.reduce(
    (sum, { rows }) => sum + Math.ceil(rows / VERIFY_IDS_PER_COUNT),
    0,
  );
  return (
    importRequestsEstimate(inserted, path) +
    importRequestsEstimate(
      (input.purged ?? []).filter(({ rows }) => rows > 0),
      path,
    ) +
    importRunReads(inserted.length, input.automationRead ?? 0) +
    verified
  );
}
