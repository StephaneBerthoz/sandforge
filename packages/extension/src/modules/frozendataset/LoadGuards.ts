/**
 * Entry guards of the frozen-dataset load (spec §6). A load is REFUSED —
 * with an actionable remediation, never an opaque error — when:
 *
 *   1. the target org is not a sandbox (production/staging tier);
 *   2. the target org belongs to the CONFIGURED protected-environment list
 *      or is the manifest source org (the source is never a target);
 *   3. callouts of the target org are not mocked (injectable detection —
 *      default: custom metadata flag, see {@link CustomMetadataCalloutMockDetector});
 *   4. the dataset is empty.
 *
 * Remediation is ALWAYS "deploy configuration to the target org" — never
 * a DML on the source org.
 */

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import type { FrozenManifest } from './manifest.js';
import type { FrozenDataset } from './types.js';
import type { CalloutMockDetector, TargetOrgAccess } from './loadTypes.js';

/** Guard refusal codes, stable for programmatic handling. */
export type LoadGuardCode =
  | 'non-sandbox'
  | 'protected-environment'
  | 'source-is-target'
  | 'unmocked-callouts'
  | 'empty-dataset'
  | 'guard-refused';

/** Error thrown when an entry guard refuses the load. */
export class LoadGuardError extends Error {
  constructor(
    readonly code: LoadGuardCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoadGuardError';
  }
}

/** Inputs of the entry-guard evaluation. */
export interface LoadGuardInput {
  orgId: string;
  /** Existing safety tier of the org (ProductionGuard classification). */
  orgTier: SafetyTier;
  dataset: FrozenDataset;
  /** Frozen manifest — its source org is cross-checked against the target. */
  manifest?: FrozenManifest;
  /** Injectable unmocked-callout detection (spec §6). */
  mockDetector: CalloutMockDetector;
  /** Configured protected environments (shared orgs the load must refuse). */
  protectedOrgIds?: string[];
}

/** Total record count of a frozen dataset. */
export function datasetRecordCount(dataset: FrozenDataset): number {
  return dataset.objects.reduce((sum, o) => sum + o.records.length, 0);
}

/**
 * Evaluate every entry guard. Throws {@link LoadGuardError} on the first
 * refusal; resolves when the load may proceed.
 */
export async function assertLoadGuards(input: LoadGuardInput): Promise<void> {
  // 1. Sandbox-only: the frozen dataset is never loaded elsewhere.
  if (input.orgTier !== 'development' && input.orgTier !== 'scratch') {
    throw new LoadGuardError(
      'non-sandbox',
      `Refusing frozen-dataset load on ${input.orgTier} org ${input.orgId}: loads are ` +
        'sandbox-only. Remediation: target a Developer/Scratch sandbox — deploy the ' +
        'required configuration THERE; never run DML against a shared or source org.',
    );
  }

  // 2a. Configured protected environments (shared orgs — the source is never a target).
  if (input.protectedOrgIds?.includes(input.orgId)) {
    throw new LoadGuardError(
      'protected-environment',
      `Refusing frozen-dataset load on protected environment ${input.orgId}: it is listed ` +
        'in the protectedOrgIds configuration. Remediation: pick an unprotected sandbox, ' +
        'or review the protected-environment configuration if this org was retired.',
    );
  }

  // 2b. The manifest source org is never a target.
  if (input.manifest && input.manifest.source.orgId === input.orgId) {
    throw new LoadGuardError(
      'source-is-target',
      `Refusing frozen-dataset load on ${input.orgId}: this org is the dataset SOURCE ` +
        '(manifest source.orgId). Loading would mix pseudonymized records with their ' +
        'origin. Remediation: target a fresh dev sandbox instead.',
    );
  }

  // 3. Callouts must be mocked before any DML storm hits the target.
  if (!(await input.mockDetector.areCalloutsMocked(input.orgId))) {
    throw new LoadGuardError(
      'unmocked-callouts',
      `Refusing frozen-dataset load on ${input.orgId}: unmocked callouts detected. ` +
        'Records under load would trigger real external calls. Remediation: deploy the ' +
        'mock configuration to the TARGET org (e.g. the custom metadata flag read by ' +
        'CustomMetadataCalloutMockDetector), then retry — never edit data on the source org.',
    );
  }

  // 4. Empty dataset — nothing to replay.
  if (datasetRecordCount(input.dataset) === 0) {
    throw new LoadGuardError(
      'empty-dataset',
      'Refusing frozen-dataset load: the dataset contains zero records. Remediation: ' +
        're-run the selection/extraction with a coverage matrix that matches the source ' +
        'data, then freeze a new dataset version.',
    );
  }
}

/** Configuration of the default callout-mock detection. */
export interface CustomMetadataMockDetectionConfig {
  /** Custom metadata type API name carrying the mock flag (e.g. `Callout_Mock__mdt`). */
  metadataTypeApiName: string;
  /** Boolean field: true means callouts are mocked (e.g. `IsMocked__c`). */
  isMockedFieldApiName: string;
}

/**
 * Default {@link CalloutMockDetector} (documented in spec §6): the target
 * org is considered mocked when at least one record of the configured
 * custom metadata type carries the configured `IsMocked` flag. When the
 * metadata type is not deployed (query fails), the org is treated as NOT
 * mocked — the guard refuses with the "deploy configuration" remediation.
 */
export class CustomMetadataCalloutMockDetector implements CalloutMockDetector {
  constructor(
    private readonly orgAccess: Pick<TargetOrgAccess, 'query'>,
    private readonly config: CustomMetadataMockDetectionConfig,
  ) {}

  async areCalloutsMocked(orgId: string): Promise<boolean> {
    const soql =
      `SELECT Id FROM ${assertSoqlIdentifier(this.config.metadataTypeApiName)} ` +
      `WHERE ${assertSoqlIdentifier(this.config.isMockedFieldApiName)} = true LIMIT 1`;
    try {
      const rows = await this.orgAccess.query(orgId, soql);
      return rows.length > 0;
    } catch {
      return false;
    }
  }
}
