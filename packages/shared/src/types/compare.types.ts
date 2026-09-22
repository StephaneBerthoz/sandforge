import type { UUID, ISODateString } from './common.types.js';

/**
 * Comparison mode. Metadata is the only one: the page never offered another,
 * and the data, config and permission comparators behind the others were
 * never run (`compare:execute` always asked for metadata) and could not have
 * worked if they had. The Permissions and Drift tabs have requests of their own.
 */
export type CompareMode = 'metadata';

/**
 * What a comparison says about one component.
 *
 * `modified` and `unchanged` are verdicts on content: the component was read
 * from both orgs and the two copies compared. `not_compared` is a component
 * both orgs hold whose content was not compared (see `NotComparedReason`): it
 * is neither a change nor a match.
 */
export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged' | 'not_compared';

/** Why a component both orgs hold was not compared by content. */
export type NotComparedReason =
  /** Its content cannot be read: a managed package hides its Apex source. */
  | 'unreadable'
  /** Reading it failed in one org or both, or an org did not return it. */
  | 'read_failed'
  /** One run reads a bounded number of components; this one was past the bound. */
  | 'over_budget';

/** Metadata component type */
export type MetadataComponentType =
  | 'CustomObject'
  | 'CustomField'
  | 'ApexClass'
  | 'ApexTrigger'
  | 'LightningComponentBundle'
  | 'Flow'
  | 'Layout'
  | 'Profile'
  | 'PermissionSet'
  | 'ValidationRule'
  | 'WorkflowRule'
  | 'RecordType'
  | 'CustomLabel'
  | 'CustomMetadata'
  | 'CustomSetting'
  | 'StaticResource'
  | 'EmailTemplate'
  | 'Report'
  | 'Dashboard'
  | 'Other';

/** Compare configuration */
export interface CompareConfig {
  id: UUID;
  name: string;
  sourceOrgId: UUID;
  targetOrgId: UUID;
  thirdOrgId?: UUID;
  mode: CompareMode;
  componentTypes: MetadataComponentType[];
  includeManaged: boolean;
  includeUnmanaged: boolean;
  createdAt: ISODateString;
}

/** Compare result — full comparison output */
export interface CompareResult {
  configId: UUID;
  sourceOrgId: UUID;
  targetOrgId: UUID;
  mode: CompareMode;
  summary: CompareSummary;
  /** How far the content comparison went; see `CompareContentCoverage`. */
  content: CompareContentCoverage;
  diffs: CompareItem[];
  timestamp: ISODateString;
  duration: number;
}

/** Summary statistics for a comparison */
export interface CompareSummary {
  totalItems: number;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  /** In both orgs, content not compared: counted apart, never as a change. */
  notCompared: number;
  byType: Record<string, { added: number; removed: number; modified: number }>;
}

/**
 * What one comparison read, so that its result never reads as more than it
 * checked. Every component both orgs hold is in exactly one of `compared` or
 * `notCompared`.
 */
export interface CompareContentCoverage {
  /** Read from both orgs and compared: the `modified` and `unchanged` components. */
  compared: number;
  /** Not compared, by reason; together they are `summary.notCompared`. */
  notCompared: Record<NotComparedReason, number>;
  /**
   * The bound one run reads within: at most `components` from each org, and
   * no read started after `seconds`.
   */
  budget: { components: number; seconds: number };
}

/** A single compared item with its diff */
export interface CompareItem {
  componentType: MetadataComponentType;
  fullName: string;
  status: DiffStatus;
  /** Why a `not_compared` component was not compared; absent for every other status. */
  notComparedReason?: NotComparedReason;
  /**
   * What the component is in the source org. For `modified`, the part of its
   * content where the two orgs first differ; for `removed`, its listing.
   * Absent for `unchanged` and `not_compared`.
   */
  sourceValue?: string;
  targetValue?: string;
  fieldDiffs?: FieldDiff[];
  severity: CompareSeverity;
  deployable: boolean;
}

/** Field-level diff within a component */
export interface FieldDiff {
  fieldPath: string;
  sourceValue: string;
  targetValue: string;
  status: DiffStatus;
}

/** Severity of a difference */
export type CompareSeverity = 'info' | 'warning' | 'breaking';

/** Snapshot of org state at a point in time */
export interface OrgSnapshot {
  id: UUID;
  orgId: UUID;
  name: string;
  componentTypes: MetadataComponentType[];
  componentCount: number;
  createdAt: ISODateString;
  expiresAt?: ISODateString;
}

/** Deployment suggestion based on compare results */
export interface DeploymentSuggestion {
  components: DeploymentComponent[];
  estimatedDuration: number;
  risks: DeploymentRisk[];
  order: string[];
}

/** Component to deploy */
export interface DeploymentComponent {
  componentType: MetadataComponentType;
  fullName: string;
  action: 'deploy' | 'delete' | 'skip';
  reason: string;
}

/** Deployment risk assessment */
export interface DeploymentRisk {
  component: string;
  risk: 'low' | 'medium' | 'high';
  description: string;
}

/** Risk level for enriched diff */
export type DiffRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Enriched diff with intelligence */
export interface EnrichedDiff {
  category: string;
  changeType: 'added' | 'removed' | 'modified';
  name: string;
  sourceValue?: string;
  targetValue?: string;
  riskLevel: DiffRiskLevel;
  riskReasons: string[];
  group: string;
  dependencies: string[];
}

/**
 * One piece of deployment advice, as a code the page words in the reader's
 * language. It used to be an English sentence built where the diffs are
 * enriched, and it read in English in every locale.
 */
export type DeploymentAdvice =
  | { kind: 'critical'; count: number }
  | { kind: 'high'; count: number }
  | { kind: 'apexTests' }
  | { kind: 'lowRisk' }
  | { kind: 'review' };

/** Compare report with risk scoring */
export interface CompareReport {
  diffs: EnrichedDiff[];
  summary: {
    total: number;
    added: number;
    removed: number;
    modified: number;
    byRisk: Record<string, number>;
  };
  riskScore: number;
  deploymentAdvice: DeploymentAdvice[];
}
