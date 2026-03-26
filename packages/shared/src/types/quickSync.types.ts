/**
 * Quick Sync types — auto-generated configuration from the 3-screen flow.
 *
 * Quick Sync is the streamlined sync experience: pick orgs, pick objects,
 * confirm preview, execute with smart defaults.
 */

/** Quick Sync configuration — auto-generated from the 3-screen flow. */
export interface QuickSyncConfig {
  /** Source Salesforce org identifier. */
  sourceOrgId: string;
  /** Target Salesforce org identifier. */
  targetOrgId: string;
  /** API names of objects explicitly selected by the user. */
  selectedObjects: string[];
  /** Auto-detected parent objects added by relationship detection. */
  parentObjects: string[];
}

/** Preview data for a single object in the Quick Sync preview screen. */
export interface QuickSyncObjectPreview {
  /** Salesforce object API name. */
  objectApiName: string;
  /** Number of records to sync. */
  recordCount: number;
  /** Estimated number of API calls for this object. */
  estimatedApiCalls: number;
  /** Whether this object was auto-added as a parent dependency. */
  isParentDependency: boolean;
}

/** Preview data shown before Quick Sync execution. */
export interface QuickSyncPreview {
  /** Per-object preview details. */
  objects: QuickSyncObjectPreview[];
  /** Total number of records across all objects. */
  totalRecords: number;
  /** Total estimated API calls across all objects. */
  totalApiCalls: number;
  /** Estimated duration in seconds (rough estimate). */
  estimatedDurationSec: number;
}

/** Smart object suggestion returned by SmartObjectSuggester. */
export interface SmartObjectSuggestion {
  /** Salesforce object API name. */
  objectApiName: string;
  /** Human-readable label. */
  label: string;
  /** Whether the object exists in the connected org. */
  isAvailable: boolean;
  /** Whether the user has already selected this object. */
  isAlreadySelected: boolean;
}

/** Relationship suggestion when adding an object with parent dependencies. */
export interface RelationshipSuggestion {
  /** The child object that references the parent. */
  childObject: string;
  /** The parent object that should be added. */
  parentObject: string;
  /** The lookup field on the child object (e.g. AccountId). */
  lookupField: string;
  /** Whether this is a lookup or master-detail relationship. */
  relationshipType: 'lookup' | 'masterDetail';
  /** Suggested insert order (lower = inserted first). */
  suggestedInsertOrder: number;
}
