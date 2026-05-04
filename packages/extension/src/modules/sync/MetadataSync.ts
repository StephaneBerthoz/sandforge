import type { SyncObjectResult } from '@sandforge/shared';

/** Metadata component returned from a source org */
export interface MetadataComponent {
  fullName: string;
  type: string;
  content: string;
}

/** Deployment outcome for a single component */
export interface DeployOutcome {
  fullName: string;
  success: boolean;
  error?: string;
}

/** Function to fetch metadata components from an org */
export type FetchMetadataFn = (orgId: string, types: string[]) => Promise<MetadataComponent[]>;

/** Function to deploy metadata components to an org */
export type DeployMetadataFn = (
  orgId: string,
  components: MetadataComponent[],
) => Promise<DeployOutcome[]>;

/** Dependencies required by MetadataSync */
export interface MetadataSyncDeps {
  fetchMetadata: FetchMetadataFn;
  deployMetadata: DeployMetadataFn;
}

/**
 * Synchronizes metadata components (Apex classes, triggers, custom objects, etc.)
 * between Salesforce orgs. Fetches from source and deploys to target.
 */
export class MetadataSync {
  private readonly deps: MetadataSyncDeps;

  constructor(deps: MetadataSyncDeps) {
    this.deps = deps;
  }

  /**
   * Sync metadata of the specified types from source org to target org.
   * Returns a SyncObjectResult summarizing success/failure counts.
   */
  async sync(sourceOrgId: string, targetOrgId: string, types: string[]): Promise<SyncObjectResult> {
    if (types.length === 0) {
      return createEmptyResult();
    }

    const components = await this.deps.fetchMetadata(sourceOrgId, types);

    if (components.length === 0) {
      return createEmptyResult();
    }

    const outcomes = await this.deps.deployMetadata(targetOrgId, components);

    return buildResult(outcomes);
  }
}

/**
 * Create an empty result for when there is nothing to sync.
 */
function createEmptyResult(): SyncObjectResult {
  return {
    objectApiName: 'Metadata',
    operation: 'upsert',
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    conflictCount: 0,
    errors: [],
  };
}

/**
 * Build a SyncObjectResult from deployment outcomes.
 */
function buildResult(outcomes: DeployOutcome[]): SyncObjectResult {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.success) {
      success++;
    } else {
      failed++;
      if (outcome.error) {
        errors.push(`${outcome.fullName}: ${outcome.error}`);
      }
    }
  }

  return {
    objectApiName: 'Metadata',
    operation: 'upsert',
    processed: outcomes.length,
    success,
    failed,
    skipped: 0,
    conflictCount: 0,
    errors,
  };
}
