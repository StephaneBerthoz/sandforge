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

/** Details about the analyzed orgs and recommended action context. */
export interface SmartActionDetails {
  /** The target org that was analyzed. */
  targetOrgId: string;
  /** Optional source org if a two-org analysis was performed. */
  sourceOrgId?: string;
  /** Record counts per object in the target org. */
  recordCounts: OrgRecordCounts;
  /** Suggested seed template name (for quick-seed action). */
  suggestedTemplate?: string;
}

/**
 * A recommendation produced by the SmartActionAnalyzer.
 *
 * Contains the recommended action, confidence level, human-readable reason,
 * i18n key for the reason text, and detailed org analysis data.
 */
export interface SmartActionRecommendation {
  /** The recommended action type. */
  action: SmartActionType;
  /** Confidence score between 0 and 1. */
  confidence: number;
  /** Human-readable reason (English fallback). */
  reason: string;
  /** i18n key for the recommendation reason. */
  reasonKey: string;
  /** Detailed analysis data. */
  details: SmartActionDetails;
}
