import type { RewindResult } from '../types/checkpoint.types.js';

/**
 * Whether a rewind, or an undo of one, wrote nothing to the org: it deleted,
 * gave back, brought back and made again no record, and touched no link
 * between a file and a record. A record it found already back, or already
 * gone, is no write of its own.
 *
 * An undo stopped once under way but before its first write — at the
 * question about what it may not delete, say — ends `cancelled` as one
 * stopped part way does, and was said "Stopped part way" of an org it had
 * written nothing to: the command line and the page read this to tell them
 * apart.
 */
export function rewindWroteNothing(
  result: Pick<RewindResult, 'deleted' | 'restored' | 'undeleted' | 'recreated' | 'files'>,
): boolean {
  const files = result.files;
  return (
    result.deleted.every((object) => object.deleted === 0) &&
    result.restored.every((object) => object.restored + (object.restoredWithout ?? 0) === 0) &&
    result.undeleted.every((object) => object.undeleted === 0) &&
    (result.recreated ?? []).every((object) => object.created === 0) &&
    (files === undefined || files.unlinked + files.relinked + files.linksUpdated === 0)
  );
}
