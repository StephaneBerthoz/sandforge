/**
 * The objects a clone of the whole org takes, and those it leaves out with
 * why, from the two orgs' global describes.
 *
 * One rule decides what "everything people work in" is: the checkpoint's
 * (`scopeCandidates`, mode `everything`). It already asks of the target what
 * a clone needs of it — that the user may query, create, edit and delete an
 * object's records: create for the insert, edit for the second pass that fills
 * in the lookups an insert could not, delete for a rewind — and it already
 * leaves out setup, the org's bookkeeping (history, sharing, feeds, change
 * events), the kinds of objects no insert writes as a record and what the
 * Tooling API serves. A second rule beside it would drift from it, and a
 * rewind of the clone would then meet objects the take before it never held.
 *
 * Three things differ from a checkpoint:
 *
 * - custom settings are taken, as any other object the target lets the user
 *   write. A checkpoint holds them only when its take names them, because a
 *   rewind sets them back whoever changed them since; a clone writes them
 *   once into an org that may already hold a row of the same name or owner,
 *   which the target refuses and the run's summary names as it names any
 *   refused row;
 * - files are not objects of their own: a file, its versions, its links to
 *   records and an attachment of the old model are copied with the records
 *   they hang on by the run's pass over files, never as nodes of the graph;
 * - the source has its say too: an object the target has and the source does
 *   not let the user query is left out, and so is one only the source has.
 *   An object only the target has is no object of the source's, and is not
 *   listed at all.
 */

import type { ForgeLeftOutObject, ForgeLeftOutReason } from '@sandforge/shared';
import {
  ALL_CUSTOM_SETTINGS,
  ATTACHMENT_OBJECT,
  FILE_OBJECT,
  scopeCandidates,
  type GlobalObject,
  type ScopeLeftOutReason,
} from '../checkpoint/checkpointScope.js';
import { isNeverCopiedWhenPicked } from './excludedObjects.js';

/**
 * The objects of files a checkpoint holds as records and a clone copies with
 * the records they hang on, in lower case: their versions and links already
 * come out of the checkpoint's rule as held with their file.
 */
const COPIED_WITH_THEIR_RECORDS: ReadonlySet<string> = new Set(
  [FILE_OBJECT, ATTACHMENT_OBJECT].map((name) => name.toLowerCase()),
);

/**
 * What `detail` says of a file left out as an object because the run copies
 * it with the records it hangs on: a word the page translates, as
 * `noLayout`, rather than a sentence in one language.
 */
const WITH_THEIR_RECORDS = 'withTheirRecords';

/** What `detail` says of setup left out because the org gives it no page layout. */
const NO_LAYOUT = 'noLayout';

/**
 * The reason a clone gives for what the checkpoint's rule left out. The
 * reasons the rule can give in mode `everything` keep their name, but a
 * file's version or link, which a clone copies with the records too. The
 * others belong to a picked take or a checkpoint's own checks and never come
 * out of this call; were one to, the object is said to be one the user may not
 * write rather than taken. The rule's own word for why is not put in `detail`,
 * which holds a word the page translates or the org's own words, never a name
 * of this code's.
 */
function reasonOf(reason: ScopeLeftOutReason): { reason: ForgeLeftOutReason; detail?: string } {
  switch (reason) {
    case 'chatter':
    case 'history':
    case 'sharing':
    case 'changeEvent':
    case 'unsupportedKind':
    case 'files':
    case 'setup':
    case 'metadata':
    case 'notWritable':
    case 'notDescribed':
    case 'unreadable':
      return { reason };
    case 'heldWithFiles':
      return { reason: 'files', detail: WITH_THEIR_RECORDS };
    default:
      return { reason: 'notWritable' };
  }
}

/** Names in code-unit order, so that the same orgs give the same list on any machine. */
function byName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/**
 * The objects of the source a clone of the whole org counts, and those it
 * leaves out, each with why, sorted by name.
 *
 * A candidate is named as the source names it: its records are read there.
 * It still has to hold records to become a node, which counting says.
 *
 * @param source - The source org's global describe.
 * @param target - The target org's global describe.
 * @param targetTooling - The names the target's Tooling API serves; none when it could not say.
 */
export function wholeOrgCandidates(
  source: readonly GlobalObject[],
  target: readonly GlobalObject[],
  targetTooling: readonly string[],
): { candidates: string[]; leftOut: ForgeLeftOutObject[] } {
  const scope = scopeCandidates(
    target,
    // Every custom setting the target lets the user write is taken: see the
    // module's comment.
    { mode: 'everything', customSettings: ALL_CUSTOM_SETTINGS },
    targetTooling,
  );
  const sourceByName = new Map(source.map((object) => [object.name.toLowerCase(), object]));
  const targetByName = new Map(target.map((object) => [object.name.toLowerCase(), object]));
  const candidates: string[] = [];
  const leftOut: ForgeLeftOutObject[] = [];

  for (const object of source) {
    if (!targetByName.has(object.name.toLowerCase())) {
      leftOut.push({ objectApiName: object.name, reason: 'missingInTarget' });
    }
  }
  for (const out of scope.leftOut) {
    const key = out.objectApiName.toLowerCase();
    const inSource = sourceByName.get(key);
    if (!inSource) continue;
    const said = reasonOf(out.reason);
    // The rule reads a feed or a setup object by its name before it reads
    // the layout, so setup said of an object no name rule leaves out is the
    // org giving it no page layout.
    const noLayout =
      out.reason === 'setup' &&
      targetByName.get(key)?.layoutable === false &&
      !isNeverCopiedWhenPicked(out.objectApiName);
    const detail = noLayout ? NO_LAYOUT : (said.detail ?? out.detail);
    leftOut.push({
      objectApiName: inSource.name,
      reason: said.reason,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  for (const name of scope.candidates) {
    const key = name.toLowerCase();
    const inSource = sourceByName.get(key);
    if (!inSource) continue;
    if (inSource.queryable !== true) {
      leftOut.push({ objectApiName: inSource.name, reason: 'notQueryable' });
    } else if (COPIED_WITH_THEIR_RECORDS.has(key)) {
      leftOut.push({ objectApiName: inSource.name, reason: 'files', detail: WITH_THEIR_RECORDS });
    } else {
      candidates.push(inSource.name);
    }
  }
  candidates.sort();
  leftOut.sort(byName);
  return { candidates, leftOut };
}
