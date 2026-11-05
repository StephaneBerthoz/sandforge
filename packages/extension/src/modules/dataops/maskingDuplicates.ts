/**
 * What the duplicate rules of an org write as a masking writes over its
 * records: named before the question, read again once the run's last write is
 * in, and said with its result.
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
 * said as unread.
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
  try {
    const from = soqlDateTimeOf(new Date(Date.parse(input.since) - LEAD_MS).toISOString());
    const masked = new Set([...input.masked].map(idKey));
    const items = await org.query(
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
      const answer = await org.query(
        `SELECT Id FROM DuplicateRecordSet WHERE CreatedDate >= ${from} AND Id IN (${list})`,
      );
      sets += answer.records.length;
    }
    return { rules, sets, items: itemsWritten, ...(atLeast ? { atLeast: true as const } : {}) };
  } catch (err: unknown) {
    return { rules, sets: 0, items: 0, unread: extractErrorMessage(err) };
  }
}

/** `"A"`, `"A", "B"`. */
function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/**
 * What a masking's result says of its duplicate rules: what they wrote during
 * it for the records it masked, kept; that they wrote nothing; or why it
 * could not be read. Empty when the objects it masked have none.
 */
export function maskingDuplicatesSentence(
  duplicates: MaskingDuplicatesWritten | undefined,
  target: string,
): string {
  if (!duplicates || duplicates.rules.length === 0) return '';
  const named = duplicates.rules
    .map((on) => `${on.objectApiName} (${quoted(on.rules)})`)
    .join(', ');
  if (duplicates.unread !== undefined) {
    return (
      `What the duplicate rules of ${target} on ${named} wrote during the masking could not be ` +
      `read (${duplicates.unread}): a duplicate record set they wrote stays.`
    );
  }
  if (duplicates.sets === 0 && duplicates.items === 0) {
    return `The duplicate rules of ${target} on ${named} wrote nothing for the records it masked.`;
  }
  const atLeast = duplicates.atLeast === true ? 'at least ' : '';
  return (
    `The duplicate rules of ${target} on ${named} wrote ${atLeast}${duplicates.sets} duplicate ` +
    `record set(s) and ${atLeast}${duplicates.items} item(s) during the masking, for records it ` +
    'masked: kept, as they name records that stay.'
  );
}
