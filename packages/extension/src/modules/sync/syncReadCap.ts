/**
 * The most records of one object a sync reads, and what a run says when that
 * bound cut a read short.
 *
 * The panel read a source of the production tier — a production org, and a
 * Developer Edition with it — under `LIMIT 500` with no order: 500 records of
 * no particular kind of each object. Its notice then proposed a filter or a
 * split run, neither of which lifted the cap, and the gate counted 500 as well.
 * A sandbox source stopped at 50 000 with no setting, and the command line at
 * 50 000 without a word. The bound is now one for every org: the setting
 * `sandforge.sync.maxRecordsPerObject` in the panel, `--max-records-per-object`
 * on the command line, 50 000 at most, as a run holds every record it reads of
 * an object. What a run spends of the target's daily requests is its gate's.
 */

/** The bound a run reads to when nothing asks for another: the most a run holds. */
export const SYNC_READ_CAP_DEFAULT = 50_000;

/** The most records of one object a run holds at once, which no setting raises. */
export const SYNC_READ_CAP_MAX = 50_000;

/** The least a setting can ask for. */
export const SYNC_READ_CAP_MIN = 1;

/**
 * The bound a run reads to, from what the setting or the flag asked: held
 * within its bounds, which the Settings editor enforces and a hand-edited
 * settings file does not; the default for anything that is no number.
 *
 * @param asked - The value read from the setting or the flag.
 */
export function syncReadCapOf(asked: unknown): number {
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return SYNC_READ_CAP_DEFAULT;
  return Math.min(SYNC_READ_CAP_MAX, Math.max(SYNC_READ_CAP_MIN, Math.floor(asked)));
}

/**
 * The codes Salesforce answers a read too heavy for it with: a query that ran
 * past its time, typically a filter on a field no index holds over a large
 * object; and one that touched more rows than the sharing of a user without
 * View All Data lets it weigh.
 */
const HEAVY_READ = /\b(QUERY_TIMEOUT|OPERATION_TOO_LARGE)\b/;

/**
 * What gets a read Salesforce gave up on through, said after its error, or
 * nothing for any other error: run again as it was, it is refused again.
 *
 * @param error - The error the read failed with, in its words.
 */
export function heavyReadAdvice(error: string): string {
  if (!HEAVY_READ.test(error)) return '';
  return (
    ' Salesforce gave up on the count: filter the object on an indexed field (CreatedDate, ' +
    'SystemModstamp, Id, Name or an External ID) or on a narrower range of CreatedDate, then ' +
    'run it again. A user with View All Data reads the source without its sharing, which is ' +
    'what slows such a count most.'
  );
}

/** How a surface names the way to raise the bound and the way to a sample that fits. */
export interface ReadCutWords {
  /** The setting or the flag that raises the bound. */
  raise: string;
  /** Where a sample of the source that fits the target is copied from, as a sentence ends. */
  sample: string;
}

/** The panel's: the setting, and Forge's page. */
export const PANEL_READ_CUT_WORDS: ReadCutWords = {
  raise: 'the sandforge.sync.maxRecordsPerObject setting',
  sample: 'Forge, with Depth ALL and Records per object set to A sample that fits the target',
};

/**
 * What to do about a read the bound cut short, said after what it cut: on
 * the source, the rest read in slices of a filter, or a sample of the org
 * that fits the target; on the target of a bidirectional run, the records
 * compared narrowed by the filter. Raising the bound is offered only below
 * the most a run holds.
 *
 * @param side - The org the read was of.
 * @param cap - The bound the read stopped at.
 * @param words - How the surface the sentence is read on names its ways.
 */
export function readCutRemedy(side: 'source' | 'target', cap: number, words: ReadCutWords): string {
  const raise =
    cap < SYNC_READ_CAP_MAX ? `raise ${words.raise} (${SYNC_READ_CAP_MAX} at most), or ` : '';
  if (side === 'target') {
    return `To compare every record, ${raise}narrow the object's filter.`;
  }
  return (
    `To copy the rest, ${raise}read it in slices: a filter on CreatedDate, one range per run. ` +
    `To copy a sample of the source that fits the target instead, use ${words.sample}.`
  );
}
