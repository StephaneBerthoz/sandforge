import type { SmartObjectSuggestion } from '@sandforge/shared';

/** Common Salesforce object definition for smart suggestions. */
interface CommonObject {
  apiName: string;
  label: string;
}

/**
 * Suggests the top 5 most commonly synced Salesforce objects,
 * filtered against what is actually available in the connected org.
 *
 * Used by Quick Sync to pre-populate the object selection screen (SWIZ-05).
 */
export class SmartObjectSuggester {
  /** Top 5 most common Salesforce objects for sync scenarios. */
  private static readonly COMMON_OBJECTS: readonly CommonObject[] = [
    { apiName: 'Account', label: 'Account' },
    { apiName: 'Contact', label: 'Contact' },
    { apiName: 'Opportunity', label: 'Opportunity' },
    { apiName: 'Case', label: 'Case' },
    { apiName: 'Lead', label: 'Lead' },
  ] as const;

  /**
   * Return top 5 suggestions filtered against available objects in the org.
   *
   * @param availableObjects - API names of objects available in the org (from describeGlobal).
   * @param alreadySelected - API names of objects the user has already picked.
   * @returns Suggestions with availability and selection status flags.
   */
  suggest(availableObjects: string[], alreadySelected: string[]): SmartObjectSuggestion[] {
    const availableSet = new Set(availableObjects);
    const selectedSet = new Set(alreadySelected);

    return SmartObjectSuggester.COMMON_OBJECTS.map((obj) => ({
      objectApiName: obj.apiName,
      label: obj.label,
      isAvailable: availableSet.has(obj.apiName),
      isAlreadySelected: selectedSet.has(obj.apiName),
    }));
  }
}
