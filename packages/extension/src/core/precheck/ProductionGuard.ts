/** Safety tier classification for Salesforce orgs */
export type SafetyTier = 'production' | 'staging' | 'development' | 'scratch';

/** Describes an operation that needs safety verification */
export interface OperationRequest {
  orgId: string;
  orgTier: SafetyTier;
  /**
   * What the operation writes. `deploy` is a Metadata API deployment: it
   * writes components, not records, so `objectName` names their types and
   * `recordCount` counts the components.
   */
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete' | 'deploy';
  objectName: string;
  /**
   * Records the operation plans to write. Callers that cannot know it
   * before the run (a clone queries its source afterwards, a masking run
   * queries each object) send `'unknown'`, which is shown as such and
   * counts as below every volume threshold. A measured 0 stays 0.
   */
  recordCount: number | 'unknown';
  module: string;
}

/** Result of a safety check on an operation request */
export interface SafetyCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresApproval: boolean;
  blockedReason?: string;
  warnings: string[];
  impactSummary: string;
}

const DESTRUCTIVE_OPERATIONS = new Set<string>(['delete', 'hardDelete']);

/** Volume thresholds that trigger safety gates per tier */
const PRODUCTION_APPROVAL_THRESHOLD = 1_000;
const STAGING_CONFIRMATION_THRESHOLD = 10_000;
const DEV_WARNING_THRESHOLD = 50_000;

/** Optional runtime configuration for {@link ProductionGuard}. */
export interface ProductionGuardOptions {
  /**
   * Mirrors the `sandforge.safety.requireProdConfirmation` setting
   * (manifest default true). When off, production-tier writes no longer
   * request an explicit confirmation. Read at call time.
   */
  isProdConfirmationRequired?: () => boolean;
  /**
   * UI callback invoked by {@link confirmIfNeeded} when a check result
   * requires explicit user confirmation. Resolves to the user's consent.
   * Wired in extension.ts to a modal `showWarningMessage`; absent in tests
   * (operations proceed, preserving pre-existing behavior).
   *
   * Handed the tier that asked: staging asks too, and the modal told every
   * question that it wrote to a production org.
   */
  requestConfirmation?: (impactSummary: string, orgTier: SafetyTier) => Promise<boolean>;
}

/**
 * Guards against dangerous operations on production and staging orgs.
 * Enforces tier-based rules for writes, deletes, and large-volume operations.
 */
export class ProductionGuard {
  private readonly overrides: Map<string, boolean> = new Map();
  private readonly options: ProductionGuardOptions;

  constructor(options?: ProductionGuardOptions) {
    this.options = options ?? {};
  }

  /**
   * Evaluate an operation request against the safety rules for its org tier.
   * Returns whether the operation is allowed, requires confirmation, or is blocked.
   */
  check(request: OperationRequest): SafetyCheckResult {
    switch (request.orgTier) {
      case 'production':
        return this.checkProduction(request);
      case 'staging':
        return this.checkStaging(request);
      case 'development':
      case 'scratch':
        return this.checkDevelopment(request);
    }
  }

  /** Allow or disallow a specific org to override production blocks */
  setProductionOverride(orgId: string, allowed: boolean): void {
    this.overrides.set(orgId, allowed);
  }

  /** Check whether a specific org has an active production override */
  isProductionOverridden(orgId: string): boolean {
    return this.overrides.get(orgId) === true;
  }

  /**
   * Whether a confirmation can be put to someone. With no confirmation UI — a
   * unit test, a command-line runner — {@link confirmIfNeeded} lets through a
   * run it would otherwise have asked about, and a record of that run must not
   * say that anyone confirmed it.
   */
  get canAskForConfirmation(): boolean {
    return this.options.requestConfirmation !== undefined;
  }

  /**
   * Ask the user to confirm an operation whose check result requires
   * confirmation. Returns true when the operation may proceed.
   *
   * When no confirmation UI is wired (unit tests, headless hosts), proceeds
   * and returns true — the pre-existing behavior for every caller.
   *
   * @param result - The check of the operation.
   * @param orgTier - The tier of the org it writes to, which the question names.
   */
  async confirmIfNeeded(result: SafetyCheckResult, orgTier: SafetyTier): Promise<boolean> {
    if (!result.allowed || !result.requiresConfirmation) {
      return result.allowed;
    }
    if (!this.options.requestConfirmation) {
      return true;
    }
    return this.options.requestConfirmation(result.impactSummary, orgTier);
  }

  /** Whether production operations require an explicit confirmation (setting-backed). */
  private requireProdConfirmation(): boolean {
    return this.options.isProdConfirmationRequired?.() ?? true;
  }

  /** Apply production-tier safety rules */
  private checkProduction(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];
    const isDestructive = DESTRUCTIVE_OPERATIONS.has(request.operation);
    const isOverridden = this.isProductionOverridden(request.orgId);

    warnings.push(
      `Production operation: ${request.operation} on ${request.objectName} ` +
        `(${describeCount(request.recordCount)} ${unitOf(request)})`,
    );

    if (request.operation === 'deploy') {
      // No override lifts this one. A metadata deployment changes what every
      // user of the org runs, and SandForge offers it to move changes between
      // sandboxes; an org of unknown type is here too (orgTypeToGuardTier).
      return {
        allowed: false,
        requiresConfirmation: false,
        requiresApproval: false,
        blockedReason:
          `deploy is not allowed on production org ${request.orgId}: ` +
          'SandForge deploys metadata to sandboxes only',
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    if (isDestructive && !isOverridden) {
      return {
        allowed: false,
        requiresConfirmation: false,
        requiresApproval: false,
        blockedReason: `${request.operation} is not allowed on production org ${request.orgId}`,
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    const requiresApproval = countForThreshold(request.recordCount) > PRODUCTION_APPROVAL_THRESHOLD;

    if (isDestructive && isOverridden) {
      warnings.push('Production override is active — destructive operation permitted');
    }

    return {
      allowed: true,
      requiresConfirmation: this.requireProdConfirmation(),
      requiresApproval,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }

  /** Apply staging-tier safety rules */
  private checkStaging(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];
    const isDestructive = DESTRUCTIVE_OPERATIONS.has(request.operation);
    const isDeploy = request.operation === 'deploy';
    const requiresConfirmation =
      isDestructive ||
      isDeploy ||
      countForThreshold(request.recordCount) > STAGING_CONFIRMATION_THRESHOLD;

    if (isDestructive) {
      warnings.push(
        `Destructive operation (${request.operation}) on staging org — confirmation required`,
      );
    }
    if (isDeploy) {
      warnings.push('Metadata deployment on staging org — confirmation required');
    }

    if (countForThreshold(request.recordCount) > STAGING_CONFIRMATION_THRESHOLD) {
      warnings.push(`Large volume operation: ${request.recordCount} records on staging`);
    }

    return {
      allowed: true,
      requiresConfirmation,
      requiresApproval: false,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }

  /** Apply development/scratch-tier safety rules (permissive) */
  private checkDevelopment(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];

    if (countForThreshold(request.recordCount) > DEV_WARNING_THRESHOLD) {
      warnings.push(
        `Large volume operation: ${request.recordCount} records on ${request.orgTier} org`,
      );
    }

    return {
      allowed: true,
      requiresConfirmation: false,
      requiresApproval: false,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }
}

/** Spell out a record count, or say the caller could not count it yet. */
function describeCount(recordCount: number | 'unknown'): string {
  return recordCount === 'unknown' ? 'an unknown number of' : String(recordCount);
}

/**
 * The count to compare against a volume threshold. An uncounted request has
 * nothing to measure, so it stays below every threshold rather than tripping
 * a gate on a volume nobody established.
 */
function countForThreshold(recordCount: number | 'unknown'): number {
  return recordCount === 'unknown' ? 0 : recordCount;
}

/** What the operation's count counts: components for a deployment, records otherwise. */
function unitOf(request: OperationRequest): string {
  return request.operation === 'deploy' ? 'components' : 'records';
}

/** Build a human-readable impact summary for an operation */
function buildImpactSummary(request: OperationRequest): string {
  if (request.operation === 'deploy') {
    return (
      `DEPLOY ${describeCount(request.recordCount)} component(s) (${request.objectName}) ` +
      `to ${request.orgTier} org ${request.orgId} [module: ${request.module}]`
    );
  }
  return (
    `${request.operation.toUpperCase()} ${describeCount(request.recordCount)} ` +
    `${request.objectName} record(s) on ${request.orgTier} org ${request.orgId} ` +
    `[module: ${request.module}]`
  );
}
