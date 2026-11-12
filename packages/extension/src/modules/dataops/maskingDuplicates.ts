/**
 * What the duplicate rules of an org write as a masking writes over its
 * records — as a restore puts a backup's values back, as an erasure writes
 * over a person's —: named before the question, read again once the run's
 * last write is in, and said with its result.
 *
 * A masking writes the same `preserve_format` email over every record it
 * masks, and draws names that look alike. On the trap org, a CLI masking of
 * two contacts had the org's Automated Process write a `DuplicateRecordSet`
 * a few seconds later: the masking's report of what the org runs named no
 * duplicate rule, and nothing said or removed what the rule wrote.
 *
 * Nothing it writes is removed. The other modules remove only what is proven
 * theirs: a Seed removal takes a set its own deletes left empty, and a Forge
 * or Frozen sweep never takes unasked what the org's Automated Process made
 * (`late`). A masking deletes nothing, so no set it touched is ever left
 * empty, and every item a rule wrote names a record that stays: it is said,
 * and kept.
 */

import type { ForgeTargetAutomation, MaskingDuplicatesWritten } from '@sandforge/shared';

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { soqlDateTimeOf } from '../sync/SyncDelta.js';
import { idLists } from './RecordRemoval.js';

/**
 * How long after the run's last write the read waits: a duplicate rule's
 * report is written up to a few seconds after the record — on the trap org,
 * the items of a Frozen load three seconds after its last insert.
 */
export const DUPLICATES_SETTLE_MS = 5_000;

/** The most items created during the run that one read takes: past them, the counts are said as at least. */
export const DUPLICATE_ITEMS_READ = 2_000;

/** How far before the run's first write the read looks: the second the org dates a record to. */
const LEAD_MS = 1_000;

/** The run whose writes a duplicate rule reports on, as its sentence names it. */
export type DuplicatesRun = 'masking' | 'restore' | 'erasure';

/** How each run's sentence names it, and the records it wrote. */
const RUN_WORDS: Readonly<Record<DuplicatesRun, { during: string; records: string }>> = {
  masking: { during: 'during the masking', records: 'records it masked' },
  restore: { during: 'during the restore', records: 'records it put back' },
  erasure: { during: 'during the erasure', records: 'records it overwrote' },
};

/**
 * The objects a write updates that have active duplicate rules, with the
 * rules' names, as the read of what the org runs found them: those it writes
 * no record of are left out.
 */
export function duplicateRulesOn(
  automation: Pick<ForgeTargetAutomation, 'objects'> | undefined,
  objects: readonly string[],
): MaskingDuplicatesWritten['rules'] {
  const written = new Set(objects.map((name) => name.toLowerCase()));
  return (automation?.objects ?? [])
    .filter((object) => written.has(object.objectApiName.toLowerCase()))
    .filter((object) => (object.duplicateRules ?? []).length > 0)
    .map((object) => ({
      objectApiName: object.objectApiName,
      rules: (object.duplicateRules ?? []).map((rule) => rule.name),
    }));
}

/** What the read asks of the org: a query, one page of its answer. */
export interface DuplicatesOrg {
  query: (soql: string) => Promise<{ records: Array<Record<string, unknown>>; done?: boolean }>;
}

/** The first fifteen characters of an id: an item names a record by either length. */
function idKey(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 15) : '';
}

/**
 * Read what the duplicate rules wrote during the run for the records it
 * masked: the items created since its first write, read by date, that sit in
 * a set holding one naming a masked record — a rule's report names the
 * records alike, the one masked and those it matched —, and of their sets
 * those created since. Read only. Never throws: what could not be read is
 * said as unread. Each query it sends is counted (`requests`).
 *
 * @param since - The org's clock just before the run's first write.
 * @param masked - The records it masked, by id.
 */
export async function readMaskingDuplicates(
  org: DuplicatesOrg,
  input: {
    rules: MaskingDuplicatesWritten['rules'];
    since: string;
    masked: ReadonlySet<string>;
  },
): Promise<MaskingDuplicatesWritten> {
  const { rules } = input;
  let requests = 0;
  const query: DuplicatesOrg['query'] = (soql) => {
    requests++;
    return org.query(soql);
  };
  try {
    const from = soqlDateTimeOf(new Date(Date.parse(input.since) - LEAD_MS).toISOString());
    const masked = new Set([...input.masked].map(idKey));
    const items = await query(
      'SELECT Id, DuplicateRecordSetId, RecordId FROM DuplicateRecordItem ' +
        `WHERE CreatedDate >= ${from} LIMIT ${DUPLICATE_ITEMS_READ + 1}`,
    );
    const atLeast = items.done === false || items.records.length > DUPLICATE_ITEMS_READ;
    const read = items.records.slice(0, DUPLICATE_ITEMS_READ);
    const tied = new Set(
      read
        .filter((item) => masked.has(idKey(item.RecordId)))
        .map((item) => String(item.DuplicateRecordSetId ?? ''))
        .filter((set) => set !== ''),
    );
    const itemsWritten = read.filter((item) =>
      tied.has(String(item.DuplicateRecordSetId ?? '')),
    ).length;
    let sets = 0;
    for (const list of idLists([...tied])) {
      const answer = await query(
        `SELECT Id FROM DuplicateRecordSet WHERE CreatedDate >= ${from} AND Id IN (${list})`,
      );
      sets += answer.records.length;
    }
    return {
      rules,
      sets,
      items: itemsWritten,
      ...(atLeast ? { atLeast: true as const } : {}),
      requests,
    };
  } catch (err: unknown) {
    return { rules, sets: 0, items: 0, unread: extractErrorMessage(err), requests };
  }
}

/** What a watch asks of the org: its clock, once, and the read's queries. */
export interface DuplicatesWatchOrg extends DuplicatesOrg {
  /** The org's clock, as `getServerTimestamp` answers it. */
  serverTime: () => Promise<string>;
}

/**
 * What the duplicate rules write during a run, watched from its first write
 * of an object they cover to its end: see {@link watchDuplicates}.
 */
export interface DuplicatesWatch {
  /** Whether a write of the object can make a rule write: it has an active one. */
  covers(objectApiName: string): boolean;
  /** As a write of `objectApiName` goes out: when, on this machine's clock. Sends nothing. */
  beforeWrite(objectApiName: string): void;
  /**
   * Records of `objectApiName` the org saved, or may have saved — a call whose
   * answer never came —: a rule may have reported them, and is read for them
   * once its report had time to land after the last of them. The first of
   * them reads the org's clock, dated back to when their write went out.
   */
  wrote(objectApiName: string, ids: Iterable<unknown>): void;
  /**
   * What the rules wrote for those records, read once their reports had time
   * to land: undefined when the run saved no record of an object a rule
   * covers, which no rule can have reported, and nothing is then waited for
   * or sent. Never throws.
   */
  read(): Promise<MaskingDuplicatesWritten | undefined>;
}

/**
 * Watch what the duplicate rules write during a run. A masking waited five
 * seconds and sent two requests whenever an object it wrote had an active
 * rule: the org's clock before its first write, whether a record of that
 * object was then saved or not, and the read timed from its last write of
 * any object. It now reads the clock once the org saved a record of an
 * object a rule covers, dated back by the time that write took on this
 * machine's clock, waits from the last such record, reads nothing when it
 * saved none, and says what it waited and sent with what it read
 * (`waitedMs`, `requests`).
 *
 * @param rules - The active duplicate rules of the objects the run writes over (`duplicateRulesOn`).
 * @param options.settleMs - How long after the last write a rule's report takes to land.
 */
export function watchDuplicates(
  org: DuplicatesWatchOrg,
  rules: MaskingDuplicatesWritten['rules'],
  options: { settleMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): DuplicatesWatch {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const covered = new Set(rules.map((on) => on.objectApiName.toLowerCase()));
  const covers = (objectApiName: string): boolean => covered.has(objectApiName.toLowerCase());
  /**
   * The org's clock as the first covered write the org saved went out, or why
   * it could not be read: read once that write answered, less the time it
   * took — an earlier date than the save, never a later one.
   */
  let since: Promise<{ at: string } | { unread: string }> | undefined;
  /** When the latest covered write went out, on this machine's clock. */
  let writeWentOutAt = 0;
  /** The covered records the org saved, or may have saved. */
  const written = new Set<string>();
  /** When the org last saved, or may have saved, a covered record, on this machine's clock. */
  let lastWriteAt = 0;
  return {
    covers,
    beforeWrite: (objectApiName) => {
      if (covers(objectApiName) && since === undefined) writeWentOutAt = now();
    },
    wrote: (objectApiName, ids) => {
      if (!covers(objectApiName)) return;
      let any = false;
      for (const id of ids) {
        if (typeof id !== 'string' || id === '') continue;
        written.add(id);
        any = true;
      }
      if (!any) return;
      lastWriteAt = now();
      const wentOut = writeWentOutAt;
      since ??= org.serverTime().then(
        (at) => {
          const answered = Date.parse(at);
          return Number.isNaN(answered)
            ? { unread: `it answered "${at}"` }
            : { at: new Date(answered - Math.max(0, now() - wentOut)).toISOString() };
        },
        (err: unknown) => ({ unread: extractErrorMessage(err) }),
      );
    },
    read: async () => {
      if (written.size === 0) return undefined;
      const clock = since ? await since : undefined;
      if (!clock || 'unread' in clock) {
        return {
          rules,
          sets: 0,
          items: 0,
          unread: clock ? `the org's clock: ${clock.unread}` : "the org's clock was not read",
          requests: clock ? 1 : 0,
        };
      }
      const wait = Math.max(0, lastWriteAt + options.settleMs - now());
      if (wait > 0) await sleep(wait);
      const read = await readMaskingDuplicates(org, { rules, since: clock.at, masked: written });
      // The org's clock, read once, is one of its requests.
      return { ...read, requests: (read.requests ?? 0) + 1, waitedMs: wait };
    },
  };
}

/**
 * Whether what the rules did is worth a warning: a set or an item they wrote,
 * kept, or a read that could not say.
 */
export function duplicatesLeft(duplicates: MaskingDuplicatesWritten | undefined): boolean {
  return (
    duplicates !== undefined &&
    (duplicates.sets > 0 || duplicates.items > 0 || duplicates.unread !== undefined)
  );
}

/** `"A"`, `"A", "B"`. */
function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/** How long a read waited for the rules' reports, in the words of its sentence. */
function waitedWords(ms: number): string {
  if (ms <= 0) return 'without waiting';
  return ms < 1_000 ? 'after waiting less than 1 s' : `after waiting ${Math.round(ms / 1_000)} s`;
}

/**
 * What a run's result says of its duplicate rules: what they wrote during it
 * for the records it wrote, kept; that they wrote nothing; or why it could
 * not be read; and, once read, in how many requests and after how long a
 * wait for their reports. Empty when the objects it wrote have none.
 *
 * @param run - The run it is said of: a masking unless said.
 */
export function maskingDuplicatesSentence(
  duplicates: MaskingDuplicatesWritten | undefined,
  target: string,
  run: DuplicatesRun = 'masking',
): string {
  if (!duplicates || duplicates.rules.length === 0) return '';
  const words = RUN_WORDS[run];
  const named = duplicates.rules
    .map((on) => `${on.objectApiName} (${quoted(on.rules)})`)
    .join(', ');
  if (duplicates.unread !== undefined) {
    return (
      `What the duplicate rules of ${target} on ${named} wrote ${words.during} could not be ` +
      `read (${duplicates.unread}): a duplicate record set they wrote stays.`
    );
  }
  const measure =
    duplicates.requests !== undefined
      ? ` Read in ${duplicates.requests} request(s), ${waitedWords(duplicates.waitedMs ?? 0)}.`
      : '';
  if (duplicates.sets === 0 && duplicates.items === 0) {
    return (
      `The duplicate rules of ${target} on ${named} wrote nothing for the ${words.records}.` +
      measure
    );
  }
  const atLeast = duplicates.atLeast === true ? 'at least ' : '';
  return (
    `The duplicate rules of ${target} on ${named} wrote ${atLeast}${duplicates.sets} duplicate ` +
    `record set(s) and ${atLeast}${duplicates.items} item(s) ${words.during}, for ` +
    `${words.records}: kept, as they name records that stay.${measure}`
  );
}
