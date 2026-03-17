import type { UUID, ISODateString, ApiName } from './common.types.js';

/** Comparison mode */
export type CompareMode = 'metadata' | 'data' | 'config' | 'permissions' | 'full';

/** Diff status for a compared item */
export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

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
  objectFilter?: ApiName[];
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
  byType: Record<string, { added: number; removed: number; modified: number }>;
}

/** A single compared item with its diff */
export interface CompareItem {
  componentType: MetadataComponentType;
  fullName: string;
  status: DiffStatus;
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
  deploymentAdvice: string;
}
