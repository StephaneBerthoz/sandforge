/**
 * What a sync may send an object in the target org, read from one describe.
 *
 * The panel and the command line describe each target object once per run
 * and read everything a write needs from that answer: the fields the running
 * user may write, the lookups among them, and the record types that user may
 * use. Kept apart from `DataSync` so the handler can build it without loading
 * the sync engine before a run starts.
 */

import {
  parseRecordTypeInfos,
  type RecordTypeAvailability,
} from '../../core/metadata/recordTypeAvailability.js';

/** What the target's describe of an object says a write may send. */
export interface TargetWriteFields {
  /** Fields the target lets the running user write. */
  creatable: ReadonlySet<string>;
  /** The lookups among them. */
  references: ReadonlySet<string>;
  /**
   * The object's record types as the running user sees them. Optional: a
   * describe that does not carry them leaves record types to the platform.
   */
  recordTypes?: readonly RecordTypeAvailability[];
}

/**
 * {@link TargetWriteFields} from one describe of the target object.
 *
 * @param described - The object's describe, as jsforce returns it.
 */
export function targetWriteFieldsOf(described: {
  fields: ReadonlyArray<{ name: string; createable?: boolean; type?: string }>;
  recordTypeInfos?: unknown;
}): TargetWriteFields {
  const writable = described.fields.filter((f) => f.createable === true);
  return {
    creatable: new Set(writable.map((f) => f.name)),
    references: new Set(writable.filter((f) => f.type === 'reference').map((f) => f.name)),
    recordTypes: parseRecordTypeInfos(described.recordTypeInfos),
  };
}
