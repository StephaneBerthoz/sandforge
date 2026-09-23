import type { BaseMessage } from './base.messages.js';
import type {
  CompareResult,
  DeploymentComponentRef,
  DeploymentReport,
  DeployTestLevel,
  MetadataComponentType,
} from '../compare.types.js';

/** Compare messages (validated by compareExecutePayloadSchema). */
export interface CompareExecuteRequest extends BaseMessage {
  type: 'compare:execute';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    types: MetadataComponentType[];
    /** Leave the components a managed package installed out when false; compared when absent. */
    includeManaged?: boolean;
  };
}

/**
 * Result of a `compare:execute` run.
 * This is the single response channel posted by CompareHandler for both
 * request types — the webview listens on `compare:execute:response`.
 */
export interface CompareExecuteResponse extends BaseMessage {
  type: 'compare:execute:response';
  payload: CompareResult;
}

/** Request to compare permission sets and profiles between two orgs. */
export interface ComparePermissionsRequest extends BaseMessage {
  type: 'compare:permissions';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Request to capture and compare object snapshots between two orgs. */
export interface CompareSnapshotsRequest extends BaseMessage {
  type: 'compare:snapshots';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Request to detect configuration drift between two orgs. */
export interface CompareDriftRequest extends BaseMessage {
  type: 'compare:drift';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Diff bucket used by compare:permissions (source-only / target-only / shared entries). */
export interface ComparePermissionsBucket<T> {
  sourceOnly: T[];
  targetOnly: T[];
  shared: T[];
}

/** Response containing the permission set / profile diff between two orgs. */
export interface ComparePermissionsResponse extends BaseMessage {
  type: 'compare:permissions:response';
  payload: {
    permissions: {
      permissionSets: ComparePermissionsBucket<{ name: string; label: string }>;
      profiles: ComparePermissionsBucket<{ name: string }>;
    };
  };
}

/** Per-org object census inside a compare:snapshots result. */
export interface CompareSnapshotSide {
  orgId: string;
  totalObjects: number;
  customObjects: number;
  standardObjects: number;
  queryableObjects: number;
}

/** Response containing the object snapshot comparison between two orgs. */
export interface CompareSnapshotsResponse extends BaseMessage {
  type: 'compare:snapshots:response';
  payload: {
    snapshot: {
      source: CompareSnapshotSide;
      target: CompareSnapshotSide;
      diff: { sourceOnly: string[]; targetOnly: string[]; sharedCount: number };
      capturedAt: string;
    };
  };
}

/** Single drift item comparing one org setting between source and target. */
export interface CompareDriftItem {
  setting: string;
  sourceValue: string;
  targetValue: string;
  status: 'match' | 'drift' | 'missing_source' | 'missing_target';
}

/** Response containing the configuration drift report between two orgs. */
export interface CompareDriftResponse extends BaseMessage {
  type: 'compare:drift:response';
  payload: {
    drift: {
      items: CompareDriftItem[];
      totalChecked: number;
      driftCount: number;
      matchCount: number;
      missingCount: number;
      detectedAt: string;
    };
  };
}

/**
 * Validate a deployment of components of the source to the target: retrieve
 * them from the source and deploy them to the target check-only, so the
 * target compiles them and runs the tests and keeps nothing.
 */
export interface CompareValidateDeploymentRequest extends BaseMessage {
  type: 'compare:validate-deployment';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    components: DeploymentComponentRef[];
    testLevel: DeployTestLevel;
    /** The test classes `RunSpecifiedTests` runs; left out for the other levels. */
    runTests?: string[];
  };
}

/** What the validation did in the target; `report.deployId` names it for the deployment. */
export interface CompareValidateDeploymentResponse extends BaseMessage {
  type: 'compare:validate-deployment:response';
  payload: { report: DeploymentReport };
}

/**
 * Deploy what a successful validation of this window validated, to the org
 * it validated it in. The extension deploys the package it kept from that
 * validation, never one the page describes.
 */
export interface CompareDeployRequest extends BaseMessage {
  type: 'compare:deploy';
  payload: { validationId: string; targetOrgId: string };
}

/** What the deployment did in the target. */
export interface CompareDeployResponse extends BaseMessage {
  type: 'compare:deploy:response';
  payload: { report: DeploymentReport };
}

/** Error response for compare operations (emitted via sendHandlerError). */
export interface CompareErrorResponse extends BaseMessage {
  type: 'compare:error';
  payload: { message: string; code: string; retryable: boolean };
}
