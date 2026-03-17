import type { UUID } from './common.types.js';
import type { GrappeConfig } from './grappe.types.js';

/** Pre-check overall status */
export type PreCheckStatus = 'pass' | 'warning' | 'fail';

/** Pre-check category */
export type PreCheckCategory =
  | 'permissions'
  | 'api_limits'
  | 'storage'
  | 'schema'
  | 'data_integrity'
  | 'org_status'
  | 'compatibility'
  | 'security'
  | 'performance'
  | 'connectivity';

/** Pre-check item severity */
export type PreCheckSeverity = 'info' | 'warning' | 'error' | 'blocker';

/** Pre-check result — output of the pre-check engine */
export interface PreCheckResult {
  status: PreCheckStatus;
  score: number;
  checks: PreCheckItem[];
  estimations: PreCheckEstimations;
  canProceed: boolean;
  requiresConfirmation: ConfirmationItem[];
  autoFixable: PreCheckItem[];
}

/** Individual pre-check item */
export interface PreCheckItem {
  id: UUID;
  category: PreCheckCategory;
  name: string;
  description: string;
  severity: PreCheckSeverity;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  autoFixable: boolean;
  fixDescription?: string;
}

/** Estimations computed during pre-check */
export interface PreCheckEstimations {
  duration: number;
  apiCalls: number;
  dataStorageImpact: number;
  fileStorageImpact: number;
  bulkJobs: number;
  grappeRecommendation: boolean;
  optimalGrappeConfig?: GrappeConfig;
}

/** Confirmation item — requires user approval before proceeding */
export interface ConfirmationItem {
  title: string;
  description: string;
  severity: PreCheckSeverity;
  requiresTypedConfirmation: boolean;
  confirmationText?: string;
}

/** Pre-check configuration — what to check */
export interface PreCheckConfig {
  categories: PreCheckCategory[];
  skipWarnings: boolean;
  autoFix: boolean;
  targetOrgId: string;
  sourceOrgId?: string;
  module: string;
  operationConfig: Record<string, unknown>;
}

/** Permission check detail */
export interface PermissionCheckDetail {
  objectApiName: string;
  crudPermissions: {
    create: boolean;
    read: boolean;
    update: boolean;
    delete: boolean;
  };
  missingFieldPermissions: string[];
}

/** API limit check detail */
export interface ApiLimitCheckDetail {
  limitName: string;
  current: number;
  max: number;
  estimated: number;
  sufficient: boolean;
}

/** Storage check detail */
export interface StorageCheckDetail {
  type: 'data' | 'file';
  used: number;
  limit: number;
  estimatedImpact: number;
  sufficient: boolean;
}
