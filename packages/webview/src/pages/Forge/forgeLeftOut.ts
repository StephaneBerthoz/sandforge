import type { TFunction } from 'i18next';
import type { ForgeLeftOutObject, ForgeLeftOutReason } from '@sandforge/shared';

/**
 * The order the reasons a clone of the whole org leaves an object out are
 * listed in: what the target cannot take first, then what the source holds
 * none of or would not give, then what Salesforce keeps for itself, and the
 * files, copied with their records, last. A record, not a list, so that a
 * reason added to `ForgeLeftOutReason` fails the build until it is placed.
 */
const REASON_RANK: Record<ForgeLeftOutReason, number> = {
  missingInTarget: 0,
  notWritable: 1,
  notQueryable: 2,
  unreadable: 3,
  notDescribed: 4,
  empty: 5,
  setup: 6,
  metadata: 7,
  unsupportedKind: 8,
  chatter: 9,
  history: 10,
  sharing: 11,
  changeEvent: 12,
  files: 13,
};

/** The objects a clone of the whole org leaves out for one reason, by name. */
export interface LeftOutGroup {
  reason: ForgeLeftOutReason;
  objects: ForgeLeftOutObject[];
}

/**
 * `leftOut` grouped by reason, each group's objects by name: what Review and
 * the discovery of a clone of the whole org say it leaves behind. Empty when
 * the graph names none, as one walked from a root never does.
 */
export function leftOutByReason(
  leftOut: readonly ForgeLeftOutObject[] | undefined,
): LeftOutGroup[] {
  const groups = new Map<ForgeLeftOutReason, ForgeLeftOutObject[]>();
  for (const object of leftOut ?? []) {
    const group = groups.get(object.reason);
    if (group) group.push(object);
    else groups.set(object.reason, [object]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => REASON_RANK[a] - REASON_RANK[b])
    .map(([reason, objects]) => ({
      reason,
      objects: [...objects].sort((a, b) => a.objectApiName.localeCompare(b.objectApiName)),
    }));
}

/** What the page says of `reason`, as a group's heading. */
export function leftOutReasonLabel(t: TFunction, reason: ForgeLeftOutReason): string {
  return t(`forge.leftOut.${reason}`);
}

/**
 * The more an object's `detail` says, as the page says it: one of the two
 * words it translates — setup the org gives no page layout, a file copied
 * with the records it hangs on — or the org's own words, shown as it said
 * them. Undefined when there is no more to say.
 */
export function leftOutDetail(t: TFunction, object: ForgeLeftOutObject): string | undefined {
  if (object.detail === 'noLayout') return t('forge.leftOut.noLayout');
  if (object.detail === 'withTheirRecords') return t('forge.leftOut.withTheirRecords');
  return object.detail;
}
