import type { TFunction } from 'i18next';
import type { ForgeLeftOutObject, ForgeLeftOutReason } from '@sandforge/shared';

/**
 * The order the reasons a clone of the whole org leaves an object out are
 * listed in: what the user asked first, then what the target cannot take,
 * then what the source holds none of or would not give, then what Salesforce
 * keeps for itself, and the files, copied with their records, last. A record,
 * not a list, so that a reason added to `ForgeLeftOutReason` fails the build
 * until it is placed: a reason the page did not know was listed under no
 * heading at all.
 */
const REASON_RANK: Record<ForgeLeftOutReason, number> = {
  excludedByUser: 0,
  missingInTarget: 1,
  notWritable: 2,
  notQueryable: 3,
  unreadable: 4,
  notDescribed: 5,
  empty: 6,
  customSetting: 7,
  setup: 8,
  platformCreated: 9,
  metadata: 10,
  unsupportedKind: 11,
  chatter: 12,
  history: 13,
  sharing: 14,
  changeEvent: 15,
  files: 16,
};

/** The more of why that the page says in words of its own, by the word `detail` holds. */
const DETAIL_KEYS: Readonly<Record<string, string>> = {
  noLayout: 'forge.leftOut.noLayout',
  withTheirRecords: 'forge.leftOut.withTheirRecords',
  feature: 'forge.leftOut.feature',
  parent: 'forge.leftOut.parent',
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
 * The more an object's `detail` says, as the page says it: one of the words
 * it translates — setup the org gives no page layout, a file copied with the
 * records it hangs on, an object a feature keeps closed, one only its parent
 * may open — or the org's own words, shown as it said them. Undefined when
 * there is no more to say.
 */
export function leftOutDetail(t: TFunction, object: ForgeLeftOutObject): string | undefined {
  if (object.detail === undefined) return undefined;
  const key = Object.prototype.hasOwnProperty.call(DETAIL_KEYS, object.detail)
    ? DETAIL_KEYS[object.detail]
    : undefined;
  return key ? t(key) : object.detail;
}
