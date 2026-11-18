import type { ListedAnonymizationTemplate } from '@sandforge/shared';
import type { NavigationIntent } from '../../stores/useAppStore';

/**
 * The tabs of DataOps, in the order of the work: mask what a copy brought
 * from production, keep or restore the values, answer a person's request,
 * clean up, and empty. The page opened on Backup, a list of what Masking
 * wrote over, and the how-to began with "open the Anonymize tab".
 */
export const DATAOPS_TAB_IDS = ['anonymize', 'backup', 'gdpr', 'cleanup', 'emptying'] as const;

/** A tab of DataOps, by the id its `page-tab-*` names it with. */
export type DataOpsTab = (typeof DATAOPS_TAB_IDS)[number];

/** Objects an intent asks the page to act on, in the org it names. */
export interface ObjectsAsked {
  orgId: string;
  objects: string[];
}

/** Where the page opens, and what it opens with. */
export interface DataOpsLanding {
  tab: DataOpsTab;
  /** Emptying's objects picked as it opens. */
  empty?: ObjectsAsked;
  /** The objects Masking is asked to mask, its template picked for them. */
  mask?: ObjectsAsked;
}

/**
 * The tabs Restore and Quality were, by the tab that took each in: Backups
 * lists and restores every backup, and Cleanup's scan counts what Quality
 * counted.
 */
const TAKEN_IN: Readonly<Record<string, DataOpsTab>> = {
  restore: 'backup',
  quality: 'cleanup',
};

/** Whether `id` names a tab of the page. */
export function isDataOpsTab(id: string): id is DataOpsTab {
  return (DATAOPS_TAB_IDS as readonly string[]).includes(id);
}

/** The tab an intent names, as the page now has it. */
function tabOf(asked: NavigationIntent['dataopsTab']): DataOpsTab | undefined {
  if (asked === undefined) return undefined;
  const taken = TAKEN_IN[asked];
  if (taken) return taken;
  return isDataOpsTab(asked) ? asked : undefined;
}

/**
 * Where DataOps opens for the intent the navigation left, read once.
 *
 * Objects to empty are picked only on the org the intent names, and only when
 * it is the org on screen: Forge's Review and Quick Sync name their target. So
 * are objects to mask, or on the org on screen when the intent names none: a
 * run that writes over records never starts from objects asked for another org.
 */
export function landingOf(
  intent: NavigationIntent | null,
  selectedOrgId: string | undefined,
): DataOpsLanding {
  if (intent?.route !== 'dataops') return { tab: 'anonymize' };
  if (
    intent.emptyObjects !== undefined &&
    intent.targetOrgId !== undefined &&
    intent.targetOrgId === selectedOrgId
  ) {
    return { tab: 'emptying', empty: { orgId: selectedOrgId, objects: intent.emptyObjects } };
  }
  const tab = tabOf(intent.dataopsTab) ?? 'anonymize';
  const maskOrg = intent.targetOrgId ?? selectedOrgId;
  if (
    intent.maskObjects !== undefined &&
    tab === 'anonymize' &&
    selectedOrgId !== undefined &&
    maskOrg === selectedOrgId
  ) {
    return { tab, mask: { orgId: selectedOrgId, objects: intent.maskObjects } };
  }
  return { tab };
}

/**
 * The objects templates mask, in the order their rules first name them: those
 * a masking run of each addresses.
 */
export function maskedObjects(templates: readonly ListedAnonymizationTemplate[]): string[] {
  return templates
    .flatMap((tpl) => tpl.rules.map((rule) => rule.fieldPattern.split('.')[0]))
    .filter((name, i, all) => name !== '' && name !== '*' && all.indexOf(name) === i);
}

/**
 * The template Masking opens on for the objects asked: one that masks every
 * one of them, with the fewest other objects; else the one that masks the most
 * of them; the first listed of equals. None when no template masks any.
 */
export function templateFor(
  templates: readonly ListedAnonymizationTemplate[],
  objects: readonly string[],
): string | undefined {
  let best: { id: string; covered: number; extra: number } | undefined;
  for (const tpl of templates) {
    const masked = maskedObjects([tpl]);
    const covered = objects.filter((name) => masked.includes(name)).length;
    if (covered === 0) continue;
    const extra = masked.length - covered;
    if (!best || covered > best.covered || (covered === best.covered && extra < best.extra)) {
      best = { id: tpl.id, covered, extra };
    }
  }
  return best?.id;
}
