/**
 * Types for the Smart Action recommender feature.
 *
 * The Smart Action system analyzes connected org state (record counts on
 * standard objects) and recommends the best next action: Quick Seed, Clone,
 * Sync, or none.
 */

/** Available smart action types. */
export type SmartActionType = 'quick-seed' | 'clone' | 'sync' | 'none';

/** Record counts per object API name. */
export type OrgRecordCounts = Record<string, number>;

/**
 * The standard objects a recommendation counts, in the order the panel names
 * them.
 */
export const SMART_ACTION_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'] as const;

/** One of the objects a recommendation counts. */
export type SmartActionObject = (typeof SMART_ACTION_OBJECTS)[number];

/**
 * Below this many records of every one of the counted objects, an org is one
 * to fill.
 *
 * Quick Seed was recommended only to an org holding none at all, and no new
 * org is such an org: a Developer Edition, a Trailhead playground and a
 * scratch org made with sample data each come with a dozen accounts and a
 * few dozen contacts, opportunities, cases and leads. The org SandForge is
 * for, the one Salesforce gives away, never got the recommendation; an org
 * holding a working set of any one of the five still does not. The panel
 * names the ceiling in the recommendation's explanation.
 */
export const SAMPLE_DATA_CEILING = 50;

/** Details about the analyzed orgs and recommended action context. */
export interface SmartActionDetails {
  /** The target org that was analyzed. */
  targetOrgId: string;
  /** Optional source org if a two-org analysis was performed. */
  sourceOrgId?: string;
  /** Record counts per object in the target org. */
  recordCounts: OrgRecordCounts;
  /** Record counts per object in the source org, when one was analysed. */
  sourceRecordCounts?: OrgRecordCounts;
  /** Suggested seed template name (for quick-seed action). */
  suggestedTemplate?: string;
}

/**
 * A recommendation produced by the SmartActionAnalyzer: the action, the key of
 * its reason, and the counts it was read from.
 *
 * It carried a confidence score and an English reason too. The score was a
 * fixed number per rule (90 for an empty org, 70 for a sync), shown as a
 * measured "90% confidence"; the reason repeated the translated line in
 * English, in every language. The panel says why from the counts instead.
 */
export interface SmartActionRecommendation {
  /** The recommended action type. */
  action: SmartActionType;
  /** i18n key for the recommendation reason. */
  reasonKey: string;
  /** Detailed analysis data. */
  details: SmartActionDetails;
}
