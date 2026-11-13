/**
 * The deletes of an emptying, pass after pass in the order its preview
 * gave, through the delete core every removal goes through (`deletePass`),
 * each pass's ids read from the org at its turn and written to disk, and
 * every answer of the org written to the run's journal as it comes.
 *
 * **Each pass reads its ids at its turn**, once the passes before it have
 * deleted: what an account's delete took along — its contacts, its
 * opportunities — is no longer there to read, and is not sent again to be
 * answered gone. Read before the first delete, a whole-org emptying sent the
 * ids of every child its parents had taken, a call or a job for nothing, and
 * the preview's estimate, which counts what each pass sends, said less than
 * the run sent. The ids are read through `queryAll` for archived tasks and
 * events, the standard price book left out (`deletedRowsOf`).
 *
 * **Never more than confirmed.** Each read leaves out what was made after
 * the preview read the org, by its `CreatedDate`, to the second before: the
 * rewind's rule — a run never does more than its user confirmed, and a busy
 * org never keeps one going. What was made since is left, and counted once
 * the passes are through (`madeSince`). An object whose records have no
 * `CreatedDate` is read whole, and said so. A pass that still reads more
 * records than the preview counted of its object — records brought back from
 * the recycle bin since — stops the run there: the org changed beyond what
 * was confirmed (`ORG_CHANGED`).
 *
 * **Drafts first.** An activated order refuses its own delete, and its
 * account's: the delete core sets the passes' own back to Draft before its
 * first delete (P8). Those going along with an emptied object — the orders of
 * the accounts emptied — are set back here, read by the path the preview
 * read them by, and given their status back once the passes are through if
 * they stayed.
 *
 * **Resume.** A run stopped part way is taken up on its journal: a pass whose
 * ids were read reads them from its spool, less those the journal names
 * deleted or gone; a pass not reached reads its ids at its turn, as the run
 * would have. What the org answers is gone since — `ENTITY_IS_DELETED` — is
 * gone, as the delete core counts it; nothing is concluded from `queryAll`,
 * which lists a record deleted for good as deleted, as it does one in the
 * recycle bin (probed live).
 *
 * **A resume that meets only refusals ends the run.** Once every record left
 * has been sent and the org refused each again — a record it will never
 * delete so — the run is `partial` when it deleted anything, this attempt or
 * an earlier one: what it could do, it did, and the run is closed, its
 * refusals named with the org's words. Read `failure` because this attempt
 * deleted nothing, a run whose job had deleted 10,202 contacts stayed open
 * on the five the org refused, every resume sending them again, and no other
 * emptying of the org could start until its Undo.
 *
 * **The journal comes first.** A delete's answer is written down before the
 * next one goes; one the disk refuses stops the run, as an Undo that missed
 * deletes would leave records in the bin it believes it brought back.
 */

import type {
  DataOpsEmptyPassResult,
  DataOpsEmptyRefusal,
  DataOpsEmptyStatus,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import type { LimitSplitting } from '../../../core/common/governorLimit.js';
import { deletePass, type PassObject, type PassRecords } from '../../../core/removal/deletePass.js';
import type { DeleteOutcome, DeletionOrg } from '../../../core/removal/deleteRecords.js';
import {
  backToDraft,
  putBackStatuses,
  type Drafted,
} from '../../../core/removal/recordsToDraft.js';
import {
  EMPTYING,
  spoolTableIds,
  type TableIdSource,
  type TableToRead,
} from '../../../core/removal/tableIds.js';
import { IdSpool, RecordKeySet } from '../../checkpoint/spooledRunRecords.js';
import { deletedRowsOf } from './emptyRelations.js';
import type { EmptyJournal } from './emptyJournal.js';

/** What the deletes of an emptying need of the org: its deletes, and its ids read a page at a time. */
export interface EmptyRunOrg {
  deletion: Pick<DeletionOrg, 'query' | 'destroy' | 'update' | 'bulkDestroy' | 'bulkHardDestroy'>;
  ids: TableIdSource;
}

/** How far the deletes are. */
export interface EmptyRunProgress {
  percentage: number;
  step: string;
}

/** What the deletes are given. */
export interface EmptyRunDeps {
  org: EmptyRunOrg;
  journal: EmptyJournal;
  /** Whether it takes up a run stopped part way. */
  resumed: boolean;
  /** Stops the deletes before their next call or job; a job the org has is awaited. */
  signal?: AbortSignal;
  /** The smaller calls a limit of the org's automation may cost: see `deletePass`. */
  splitting?: LimitSplitting;
  /** Waits before a record the org could not lock goes again; a timer unless told. */
  wait?: (ms: number) => Promise<void>;
  /** This machine's clock, as the journal dates its lines. */
  now?: () => Date;
  onProgress?: (progress: EmptyRunProgress) => void;
}

/** What the deletes did, this attempt. */
export interface EmptyRunOutcome {
  status: DataOpsEmptyStatus;
  hard: boolean;
  passes: DataOpsEmptyPassResult[];
  /** Why the org refused to delete for good, before the job it refused held a record. */
  hardRefused?: string;
  /** Set when a pass read more than the preview counted: the run stopped there. */
  changed?: DataOpsEmptyRefusal;
  /** Whether this attempt deleted a record. */
  deletedAny: boolean;
  notes: string[];
}

/** One pass's ids, once read. */
interface ReadPass {
  spool: IdSpool;
  count: number;
  sinceRead: boolean;
}

/** The second before `at`, as a SOQL date-time: what was made in the preview's second is left too. */
export function madeBeforeCondition(at: string): string {
  const ms = Math.floor(Date.parse(at) / 1000) * 1000;
  if (!Number.isFinite(ms)) throw new RangeError(`Not a date-time: ${at}`);
  return `CreatedDate < ${new Date(ms).toISOString().replace('.000Z', 'Z')}`;
}

/** Whether the org refused a read for a `CreatedDate` the object does not have. */
function noCreatedDate(err: unknown): boolean {
  return /CreatedDate/.test(extractErrorMessage(err));
}

/** `conditions` joined, each in parentheses; nothing for none. */
function joined(conditions: ReadonlyArray<string | undefined>): string | undefined {
  const given = conditions.filter((condition): condition is string => condition !== undefined);
  if (given.length === 0) return undefined;
  return given.length === 1 ? given[0] : given.map((condition) => `(${condition})`).join(' AND ');
}

/** How a pass's result reads its own deletes beside what the core counted: its planned records are those it read. */
function passResultOf(
  object: PassObject,
  read: ReadPass | undefined,
  confirmed: number | undefined,
  cancelled: boolean,
): DataOpsEmptyPassResult {
  const planned = read?.count ?? confirmed ?? object.planned;
  const settled = object.deleted + object.gone + object.refused;
  const notReached = cancelled && planned > settled ? planned - settled : 0;
  return {
    objectApiName: object.objectApiName,
    planned,
    deleted: object.deleted,
    gone: object.gone,
    refused: object.refused,
    ...(notReached > 0 ? { notReached } : {}),
    reasons: object.reasons,
  };
}

/**
 * The status of an attempt from what its passes did.
 *
 * @param deletedBefore - Whether an earlier attempt of the run deleted a
 *   record: a resume that deletes nothing more ends the run as it stands,
 *   `partial`, once the org refused all it had left.
 */
export function emptyStatusOf(
  passes: readonly DataOpsEmptyPassResult[],
  cancelled: boolean,
  hardRefused: string | undefined,
  deletedBefore = false,
): DataOpsEmptyStatus {
  if (cancelled && hardRefused === undefined) return 'cancelled';
  const deleted = passes.reduce((sum, pass) => sum + pass.deleted, 0);
  const left = passes.reduce((sum, pass) => sum + pass.refused + (pass.notReached ?? 0), 0);
  // Refused the right to delete for good, the run stays open to be taken up
  // once the user holds it.
  if (hardRefused !== undefined) return deleted > 0 ? 'partial' : 'failure';
  if (left === 0) return 'success';
  return deleted > 0 || deletedBefore || passes.some((pass) => pass.gone > 0)
    ? 'partial'
    : 'failure';
}

/**
 * Run the deletes of the run `deps.journal` names: see the module's comment.
 * Writes its attempt and every answer of the org to the journal; the end of
 * the attempt is the caller's to write, with what else it did.
 */
export async function emptyPasses(deps: EmptyRunDeps): Promise<EmptyRunOutcome> {
  const { journal, org } = deps;
  const head = journal.head;
  const now = deps.now ?? (() => new Date());
  const state = await journal.state();
  await journal.attempt(deps.resumed, now());
  const notes: string[] = [];

  // What earlier attempts settled, by key: a resume does not send it again.
  const settled = new RecordKeySet();
  if (deps.resumed) {
    for await (const line of journal.lines()) {
      if (line.kind !== 'settled') continue;
      for (const id of [...line.deleted, ...line.gone]) settled.add(id);
    }
  }

  const internal = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, internal.signal]) : internal.signal;
  const stopped = (): boolean => signal.aborted;
  let changed: DataOpsEmptyRefusal | undefined;
  let deletedAny = false;
  const since = madeBeforeCondition(head.readAt);
  const confirmed = new Map(head.passes.map((pass) => [pass.objectApiName, pass]));
  /**
   * The condition a pass reads its records by, as its preview settled it —
   * a person account's contact left out — or, of a journal written before
   * the preview said it, the standard price book alone.
   */
  const rowsOf = (objectApiName: string): string | undefined =>
    confirmed.get(objectApiName)?.rows ?? deletedRowsOf(objectApiName);
  const reads = new Map<string, Promise<ReadPass | undefined>>();

  /** Read the ids of `table` into `dir`, without `since` when the object has no `CreatedDate`. */
  const spool = async (
    dir: string,
    table: TableToRead & { own?: string },
  ): Promise<{ spool: IdSpool; sinceRead: boolean } | undefined> => {
    const read = async (filter: string | undefined): Promise<IdSpool | undefined> => {
      const done = await spoolTableIds(
        org.ids,
        dir,
        [{ objectApiName: table.objectApiName, ...(filter !== undefined ? { filter } : {}) }],
        { signal },
      );
      return done.stopped ? undefined : done.spool;
    };
    try {
      const read1 = await read(joined([table.filter, table.own, since]));
      return read1 ? { spool: read1, sinceRead: true } : undefined;
    } catch (err: unknown) {
      if (!noCreatedDate(err)) throw err;
      notes.push(
        `${table.objectApiName} has no CreatedDate: its records were read whole, those made ` +
          'after the preview among them.',
      );
      const read2 = await read(joined([table.filter, table.own]));
      return read2 ? { spool: read2, sinceRead: false } : undefined;
    }
  };

  /** A pass's ids, read once: from its spool when an earlier attempt read them, else from the org now. */
  const readPass = (objectApiName: string): Promise<ReadPass | undefined> => {
    const known = reads.get(objectApiName);
    if (known) return known;
    const reading = (async (): Promise<ReadPass | undefined> => {
      const place = head.passes.findIndex((pass) => pass.objectApiName === objectApiName);
      const dir = journal.idsDirOf(place, objectApiName);
      const before = state.spooled.get(objectApiName);
      if (deps.resumed && before) {
        return {
          spool: await IdSpool.open(dir, EMPTYING),
          count: before.count,
          sinceRead: before.sinceRead,
        };
      }
      if (stopped()) return undefined;
      const own = rowsOf(objectApiName);
      const read = await spool(dir, { objectApiName, ...(own !== undefined ? { own } : {}) });
      if (!read) return undefined;
      const count = read.spool.count;
      const counted = confirmed.get(objectApiName)?.records;
      if (counted !== undefined && count > counted) {
        changed = {
          code: 'ORG_CHANGED',
          message:
            `${objectApiName} now holds ${count.toLocaleString('en-US')} records to delete, where ` +
            `the preview counted ${counted.toLocaleString('en-US')}: the org changed beyond what ` +
            'was confirmed, and the emptying stopped before deleting any of them. Preview it ' +
            'again, then resume or undo it.',
        };
        internal.abort();
        return undefined;
      }
      await journal.spooled({ objectApiName, place, count, sinceRead: read.sinceRead });
      return { spool: read.spool, count, sinceRead: read.sinceRead };
    })();
    reads.set(objectApiName, reading);
    return reading;
  };

  const records: PassRecords = {
    // What the preview said each pass sends: what its deletes go by — a job
    // or calls — as the estimate priced them.
    objects: head.passes.map((pass) => ({
      objectApiName: pass.objectApiName,
      count: pass.sent ?? pass.records ?? 0,
    })),
    pages: (objectApiName) => ({
      async *[Symbol.asyncIterator]() {
        const read = await readPass(objectApiName);
        if (!read) return;
        for await (const page of read.spool.pages(objectApiName)) {
          const left = settled.size > 0 ? page.filter((id) => !settled.has(id)) : page;
          if (left.length > 0) yield left;
        }
      },
    }),
  };

  // The journal's lines, in the order the org answered; the first refusal of
  // the disk stops the run.
  let writes: Promise<void> = Promise.resolve();
  let journalFailed: string | undefined;
  const journalOf = (
    objectApiName: string,
    sent: readonly string[],
    outcomes: readonly DeleteOutcome[],
  ): void => {
    const deleted: string[] = [];
    const gone: string[] = [];
    sent.forEach((id, at) => {
      const kind = outcomes[at]?.kind;
      if (kind === 'deleted') deleted.push(id);
      else if (kind === 'gone') gone.push(id);
    });
    if (deleted.length > 0) deletedAny = true;
    if (deleted.length + gone.length === 0) return;
    writes = writes.then(async () => {
      if (journalFailed !== undefined) return;
      try {
        await journal.settled(objectApiName, deleted, gone);
      } catch (err: unknown) {
        journalFailed = extractErrorMessage(err);
        internal.abort();
      }
    });
  };

  // The records going along that are past Draft, set back first.
  const draftedAlong: Drafted[] = [];
  for (const [at, along] of head.toDraftAlong.entries()) {
    if (along.condition === undefined || stopped()) continue;
    // Its folder's place follows the passes': no pass's folder is ever its.
    const dir = journal.idsDirOf(head.passes.length + at, along.objectApiName);
    const read = await spool(dir, { objectApiName: along.objectApiName, filter: along.condition });
    if (!read) break;
    const { drafted } = await backToDraft(
      org.deletion,
      [{ objectApiName: along.objectApiName }],
      read.spool,
      () => true,
      stopped,
      async () => new Set<string>(),
    );
    draftedAlong.push(...drafted);
  }

  const outcome = await deletePass(org.deletion, records, {
    mode: head.deleteMode,
    signal,
    ...(deps.splitting ? { splitting: deps.splitting } : {}),
    ...(deps.wait ? { wait: deps.wait } : {}),
    onSettled: journalOf,
    onProgress: (done, of, objectApiName) => {
      deps.onProgress?.({
        percentage: of > 0 ? Math.min(99, Math.round((done / of) * 100)) : 99,
        step: `${objectApiName}: ${done.toLocaleString('en-US')} of about ${of.toLocaleString('en-US')} settled`,
      });
    },
  }).finally(async () => {
    await writes;
    await putBackStatuses(org.deletion, draftedAlong, {
      note: (_objectApiName, reason) => notes.push(reason),
    });
  });

  if (journalFailed !== undefined) {
    notes.push(
      `The journal of this emptying could not be written (${journalFailed}): it stopped there, so ` +
        'that its Undo misses nothing it deleted.',
    );
  }

  const readOf = new Map<string, ReadPass | undefined>();
  for (const [name, reading] of reads) readOf.set(name, await reading.catch(() => undefined));
  const passes = outcome.objects.map((object) =>
    passResultOf(
      object,
      readOf.get(object.objectApiName),
      confirmed.get(object.objectApiName)?.records,
      outcome.cancelled,
    ),
  );

  // What was made after the preview, which the reads left: counted once the
  // passes are through, so that a table left holding them is said so.
  if (!outcome.cancelled) {
    for (const pass of passes) {
      const read = readOf.get(pass.objectApiName);
      if (!read?.sinceRead) continue;
      const own = rowsOf(pass.objectApiName);
      const after = since.replace('CreatedDate <', 'CreatedDate >=');
      try {
        const answer = await org.deletion.query(
          `SELECT COUNT() FROM ${assertSoqlIdentifier(pass.objectApiName)} WHERE ${joined([own, after])}`,
        );
        if (answer.totalSize > 0) pass.madeSince = answer.totalSize;
      } catch (err: unknown) {
        notes.push(
          `Whether ${pass.objectApiName} records were made after the preview could not be read: ` +
            extractErrorMessage(err),
        );
      }
    }
  }

  const cancelled = outcome.cancelled && changed === undefined && journalFailed === undefined;
  const status =
    changed !== undefined || journalFailed !== undefined
      ? deletedAny
        ? 'partial'
        : 'failure'
      : emptyStatusOf(passes, cancelled, outcome.hardRefused, deps.resumed && state.deletedAny);
  const refused = passes.reduce((sum, pass) => sum + pass.refused, 0);
  if (deps.resumed && status === 'partial' && !deletedAny && refused > 0) {
    notes.push(
      `The org refused again the ${refused.toLocaleString('en-US')} record(s) this emptying had ` +
        'left, each said with its words above: they stay, and the emptying is closed. Undo ' +
        'brings back what it deleted.',
    );
  }
  return {
    status,
    hard: outcome.hard,
    passes,
    ...(outcome.hardRefused !== undefined ? { hardRefused: outcome.hardRefused } : {}),
    ...(changed !== undefined ? { changed } : {}),
    deletedAny,
    notes,
  };
}
