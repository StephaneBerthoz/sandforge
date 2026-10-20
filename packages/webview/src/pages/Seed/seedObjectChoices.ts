import type { SeedObjectInfo } from './Step2_SelectObjects';

/**
 * The objects an empty org is seeded with first, pinned at the top of the
 * wizard's list in this order. The list held every object the org lets the
 * user create — about 670 on a Developer Edition — in the order the API gives
 * them, in a frame of a few rows: Opportunity was a long scroll away.
 */
export const COMMON_SEED_OBJECTS: readonly string[] = [
  'Account',
  'Contact',
  'Opportunity',
  'Lead',
  'Case',
  'Campaign',
  'Task',
  'Event',
  'Product2',
];

/**
 * The parents a standard object's records hang from, by the lookups the
 * platform gives every org. A seed of contacts without accounts writes
 * contacts that belong to nothing — the run leaves an optional lookup to an
 * object it does not seed to the org — so the wizard offers the parent as soon
 * as the child is ticked, before any describe: the objects are described once
 * the selection is left.
 */
const STANDARD_PARENTS: Readonly<Record<string, readonly string[]>> = {
  Contact: ['Account'],
  Opportunity: ['Account'],
  Case: ['Account', 'Contact'],
  Asset: ['Account'],
  Contract: ['Account'],
  Order: ['Account'],
  Entitlement: ['Account'],
  AccountContactRelation: ['Account', 'Contact'],
  OpportunityContactRole: ['Opportunity', 'Contact'],
  OpportunityLineItem: ['Opportunity', 'PricebookEntry'],
  OrderItem: ['Order', 'PricebookEntry'],
  PricebookEntry: ['Product2'],
  Quote: ['Opportunity'],
  QuoteLineItem: ['Quote', 'PricebookEntry'],
  CaseComment: ['Case'],
  CampaignMember: ['Campaign'],
};

/** A parent the run does not seed, of an object it does. */
export interface ParentSuggestion {
  /** The object ticked, whose records point at the parent. */
  child: string;
  /** The object its records hang from. */
  parent: string;
}

/**
 * The parents of the objects ticked that the run does not seed and the org
 * lets the user create, each once: under the first object ticked that names it.
 */
export function parentSuggestions(
  selected: readonly string[],
  available: ReadonlySet<string>,
): ParentSuggestion[] {
  const chosen = new Set(selected);
  const offered = new Set<string>();
  const suggestions: ParentSuggestion[] = [];
  for (const child of selected) {
    for (const parent of STANDARD_PARENTS[child] ?? []) {
      if (chosen.has(parent) || offered.has(parent) || !available.has(parent)) continue;
      offered.add(parent);
      suggestions.push({ child, parent });
    }
  }
  return suggestions;
}

/**
 * The objects the list shows for a search, the common ones first in their
 * own order, then the others in the order the org gave them. The search reads
 * the API name and the label, whatever their case.
 */
export function objectsToList(
  objects: readonly SeedObjectInfo[],
  search: string,
): { common: SeedObjectInfo[]; others: SeedObjectInfo[] } {
  const term = search.trim().toLowerCase();
  const matching = term
    ? objects.filter(
        (o) => o.apiName.toLowerCase().includes(term) || o.label.toLowerCase().includes(term),
      )
    : objects;
  const byName = new Map(matching.map((o) => [o.apiName, o]));
  const common = COMMON_SEED_OBJECTS.flatMap((name) => {
    const object = byName.get(name);
    return object ? [object] : [];
  });
  const pinned = new Set(common.map((o) => o.apiName));
  return { common, others: matching.filter((o) => !pinned.has(o.apiName)) };
}
