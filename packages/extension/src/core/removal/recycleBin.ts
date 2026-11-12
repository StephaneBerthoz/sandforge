/**
 * What the org's recycle bin says of records a read no longer finds.
 */

import { assertSoqlIdentifier } from '../common/soqlValidator.js';
import { extractErrorMessage } from '../common/extractErrorMessage.js';
import { idLists } from '../../modules/dataops/RecordRemoval.js';
import type { DeleteMode, DeletionOrg } from './deleteRecords.js';

/**
 * What a read of the recycle bin found of some records: those it reads
 * deleted, by key, and whether that says they are in the bin.
 *
 * `inBin` is never more than what a read can tell. A record emptied from the
 * bin reads deleted as one still in it (P11), and so does a record deleted
 * for good: asked live, an account deleted by a `hardDelete` job read
 * `IsDeleted = true` through `queryAll`, its contacts with it, and the
 * undelete of each answered "Entity is not in the recycle bin". Only an
 * undelete's answer tells. So of a pass that deleted for good, what reads
 * deleted is gone, never in the bin.
 */
export type BinReading =
  | {
      /** Keys of the records the bin read deleted. */
      deleted: Set<string>;
      /**
       * Whether those may be in the bin: false for a pass that deleted for
       * good, whatever the read says.
       */
      inBin: boolean;
    }
  | { error: string };

/**
 * Of the records of one object a read did not find, those the org's recycle
 * bin holds, by key: deleted. The rest are out of the session's sight — kept
 * from it by sharing, or owned by a user whose records it does not reach — or
 * deleted for good, as the org deletes some objects. Why the bin could not be
 * read, when it could not: then none of them is taken for gone.
 *
 * @param mode - How the pass that deleted them deleted: of one that deleted
 *   for good, what reads deleted is never said to be in the bin.
 */
export async function recycleBinOf(
  org: Pick<DeletionOrg, 'queryDeleted'>,
  objectApiName: string,
  ids: readonly string[],
  mode: DeleteMode = 'recycle',
): Promise<BinReading> {
  const object = assertSoqlIdentifier(objectApiName);
  const deleted = new Set<string>();
  try {
    for (const list of idLists(ids)) {
      const answer = await org.queryDeleted(
        `SELECT Id FROM ${object} WHERE Id IN (${list}) AND IsDeleted = true`,
      );
      for (const row of answer.records) {
        const id = (row as { Id?: unknown } | null)?.Id;
        if (typeof id === 'string') deleted.add(id.slice(0, 15));
      }
    }
  } catch (err: unknown) {
    return { error: extractErrorMessage(err) };
  }
  return { deleted, inBin: mode !== 'hard' };
}
