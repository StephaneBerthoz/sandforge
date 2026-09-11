import type { RelationshipSuggestion } from '@sandforge/shared';

/** Field metadata needed for relationship detection (subset of jsforce describe). */
export interface DescribeFieldInfo {
  /** Field API name (e.g. AccountId). */
  name: string;
  /** Field type (e.g. 'reference'). */
  type: string;
  /** Referenced object API names. */
  referenceTo: string[];
  /** Relationship name (e.g. 'Account'). */
  relationshipName: string | null;
}

/**
 * Well-known master-detail relationship fields in standard Salesforce objects.
 * These fields represent required relationships where the parent must exist.
 */
const KNOWN_MASTER_DETAIL_FIELDS = new Set(['OpportunityId', 'CaseId', 'ContractId', 'OrderId']);

/**
 * Detects parent object dependencies by analyzing reference/lookup fields
 * on a given Salesforce object.
 *
 * Used by Quick Sync to auto-suggest parent objects when a child is selected.
 */
export class RelationshipDetector {
  /**
   * Detect parent object dependencies from an object's field metadata.
   *
   * Scans for reference fields, skips self-references and already-selected objects,
   * and returns suggestions for parent objects that should be added for referential integrity.
   *
   * @param childObjectApiName - The API name of the child object being analyzed.
   * @param childFields - Field metadata from describe() on the child object.
   * @param alreadySelected - Objects already in the user's selection.
   * @param availableObjects - Objects available in the org.
   * @returns Parent object suggestions sorted by insert order.
   */
  detect(
    childObjectApiName: string,
    childFields: DescribeFieldInfo[],
    alreadySelected: string[],
    availableObjects: string[],
  ): RelationshipSuggestion[] {
    const selectedSet = new Set(alreadySelected);
    const availableSet = new Set(availableObjects);
    const suggestions: RelationshipSuggestion[] = [];

    for (const field of childFields) {
      if (field.type !== 'reference') continue;
      if (field.referenceTo.length === 0) continue;

      for (const parentObj of field.referenceTo) {
        // Skip self-references
        if (parentObj === childObjectApiName) continue;
        // Skip already-selected objects
        if (selectedSet.has(parentObj)) continue;
        // Skip unavailable objects
        if (!availableSet.has(parentObj)) continue;

        const relationshipType = this.inferRelationshipType(field.name);

        suggestions.push({
          childObject: childObjectApiName,
          parentObject: parentObj,
          lookupField: field.name,
          relationshipType,
          suggestedInsertOrder: 0,
        });
      }
    }

    return suggestions;
  }

  /**
   * Infer whether a field represents a master-detail or lookup relationship.
   *
   * Uses a heuristic: known master-detail fields are marked as such,
   * all others default to lookup.
   */
  private inferRelationshipType(fieldName: string): 'lookup' | 'masterDetail' {
    if (KNOWN_MASTER_DETAIL_FIELDS.has(fieldName)) {
      return 'masterDetail';
    }
    return 'lookup';
  }
}
