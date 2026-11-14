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
  createOnly: 3,
  notQueryable: 4,
  unreadable: 5,
  notDescribed: 6,
  empty: 7,
  customSetting: 8,
  setup: 9,
  platformCreated: 10,
  metadata: 11,
  unsupportedKind: 12,
  chatter: 13,
  history: 14,
  sharing: 15,
  changeEvent: 16,
  files: 17,
};

/** The more of why that the page says in words of its own, by the word `detail` holds. */
const DETAIL_KEYS: Readonly<Record<string, string>> = {
  noLayout: 'forge.leftOut.noLayout',
  withTheirRecords: 'forge.leftOut.withTheirRecords',
  feature: 'forge.leftOut.feature',
  parent: 'forge.leftOut.parent',
  noEdit: 'forge.leftOut.noEdit',
  noDelete: 'forge.leftOut.noDelete',
};

/**
 * What lifts a reason, said under its group, where something does: deploy
 * what the target lacks, grant what the user may not do, discover again
 * what the source did not answer for. Each reason had only its heading, and
 * the custom settings one said "not copied unless asked" of a clone that has
 * no way to ask. A reason Salesforce keeps for itself has none.
 */
const WAY_KEYS: Partial<Record<ForgeLeftOutReason, string>> = {
  missingInTarget: 'forge.leftOutWay.missingInTarget',
  notWritable: 'forge.leftOutWay.notWritable',
  createOnly: 'forge.leftOutWay.createOnly',
  notQueryable: 'forge.leftOutWay.notQueryable',
  unreadable: 'forge.leftOutWay.unreadable',
  notDescribed: 'forge.leftOutWay.notDescribed',
  customSetting: 'forge.leftOutWay.customSetting',
};

/** Knowledge article versions, which an API creates as drafts, unlike the rest of their kind. */
function isKnowledgeVersion(objectApiName: string): boolean {
  return /__kav$/i.test(objectApiName);
}

/**
 * What lifts the reason a group is left out for, in the page's words, or
 * nothing when nothing does. Of the kinds no API creates, the Knowledge
 * versions listed among them are said apart: an API creates them as drafts,
 * which a clone from a query on them writes.
 */
export function leftOutWayOut(t: TFunction, group: LeftOutGroup): string | undefined {
  if (group.reason === 'unsupportedKind') {
    const knowledge = group.objects.find((object) => isKnowledgeVersion(object.objectApiName));
    return knowledge
      ? t('forge.leftOutWay.knowledge', { object: knowledge.objectApiName })
      : undefined;
  }
  const key = WAY_KEYS[group.reason];
  return key ? t(key) : undefined;
}

/**
 * The changes an admin would make in Setup for a clone of the whole org to
 * take what it leaves out for the user's rights, as they are copied: a
 * heading, then the target's changes — Create, Edit and Delete on an object,
 * Edit or Delete on one the user may only create, a feature to turn on —
 * and the source's, Read on an object the user may not query. Empty when no
 * object is left out for a right.
 */
export function leftOutAdminText(t: TFunction, groups: readonly LeftOutGroup[]): string {
  const target: string[] = [];
  const source: string[] = [];
  for (const group of groups) {
    for (const { objectApiName: object, detail } of group.objects) {
      if (group.reason === 'notWritable') {
        // Opened by the records it hangs from: no grant on it opens it.
        if (detail === 'parent') continue;
        target.push(
          detail === 'feature'
            ? t('forgeRun.gaps.admin.step.enableFeature', { object })
            : t('forge.leftOutWay.admin.grantWrite', { object }),
        );
      } else if (group.reason === 'createOnly') {
        target.push(
          t(
            detail === 'noEdit'
              ? 'forge.leftOutWay.admin.grantEdit'
              : detail === 'noDelete'
                ? 'forge.leftOutWay.admin.grantDelete'
                : 'forge.leftOutWay.admin.grantEditDelete',
            { object },
          ),
        );
      } else if (group.reason === 'notQueryable') {
        source.push(t('forge.leftOutWay.admin.grantRead', { object }));
      }
    }
  }
  if (target.length === 0 && source.length === 0) return '';
  const lines = [t('forge.leftOutWay.admin.heading')];
  if (target.length > 0) {
    lines.push('', t('forge.leftOutWay.admin.inTarget'), ...target.map((step) => `- ${step}`));
  }
  if (source.length > 0) {
    lines.push('', t('forge.leftOutWay.admin.inSource'), ...source.map((step) => `- ${step}`));
  }
  return lines.join('\n');
}

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
