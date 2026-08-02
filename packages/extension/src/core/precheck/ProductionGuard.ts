/** Safety tier classification for Salesforce orgs */
export type SafetyTier = 'production' | 'staging' | 'development' | 'scratch';

/** Describes an operation that needs safety verification */
export interface OperationRequest {
  orgId: string;
  orgTier: SafetyTier;
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';
  objectName: string;
  recordCount: number;
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

/** Audit log entry recording a safety check decision */
export interface AuditEntry {
  request: OperationRequest;
  result: SafetyCheckResult;
  timestamp: string;
}

const DESTRUCTIVE_OPERATIONS = new Set<string>(['delete', 'hardDelete']);

/** Volume thresholds that trigger safety gates per tier */
const PRODUCTION_APPROVAL_THRESHOLD = 1_000;
const STAGING_CONFIRMATION_THRESHOLD = 10_000;
const DEV_WARNING_THRESHOLD = 50_000;

/** Maximum audit log entries retained (FIFO rotation — unbounded growth otherwise). */
const MAX_AUDIT_ENTRIES = 1_000;

/** Optional runtime configuration for {@link ProductionGuard}. */
export interface ProductionGuardOptions {
  /**
   * Mirrors the `sandforge.safety.requireProdConfirmation` setting
   * (manifest default true). When off, production-tier writes no longer
   * request an explicit confirmation. Read at call time.
   */
  isProdConfirmationRequired?: () => boolean;
  /**
   * Mirrors the `sandforge.safety.auditLogging` setting (manifest default
   * true). When off, {@link logOperation} becomes a no-op. Read at call time.
   */
  isAuditLoggingEnabled?: () => boolean;
  /**
   * UI callback invoked by {@link confirmIfNeeded} when a check result
   * requires explicit user confirmation. Resolves to the user's consent.
   * Wired in extension.ts to a modal `showWarningMessage`; absent in tests
   * (operations proceed, preserving pre-existing behavior).
   */
  requestConfirmation?: (impactSummary: string) => Promise<boolean>;
}

/**
 * Guards against dangerous operations on production and staging orgs.
 * Enforces tier-based rules for writes, deletes, and large-volume operations.
 */
export class ProductionGuard {
  private readonly overrides: Map<string, boolean> = new Map();
  private readonly auditLog: AuditEntry[] = [];
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

  /** Return a copy of all recorded audit log entries */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Record a safety check decision in the audit log.
   * No-op when audit logging is disabled via `safety.auditLogging`.
   * The log is capped at {@link MAX_AUDIT_ENTRIES} with FIFO eviction.
   */
  logOperation(request: OperationRequest, result: SafetyCheckResult): void {
    if (this.options.isAuditLoggingEnabled && !this.options.isAuditLoggingEnabled()) {
      return;
    }
    this.auditLog.push({
      request,
      result,
      timestamp: new Date().toISOString(),
    });
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog.splice(0, this.auditLog.length - MAX_AUDIT_ENTRIES);
    }
  }

  /**
   * Ask the user to confirm an operation whose check result requires
   * confirmation. Returns true when the operation may proceed.
   *
   * When no confirmation UI is wired (unit tests, headless hosts), proceeds
   * and returns true — the pre-existing behavior for every caller.
   */
  async confirmIfNeeded(result: SafetyCheckResult): Promise<boolean> {
    if (!result.allowed || !result.requiresConfirmation) {
      return result.allowed;
    }
    if (!this.options.requestConfirmation) {
      return true;
    }
    return this.options.requestConfirmation(result.impactSummary);
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
      `Production operation: ${request.operation} on ${request.objectName} (${request.recordCount} records)`,
    );

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

    const requiresApproval = request.recordCount > PRODUCTION_APPROVAL_THRESHOLD;

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
    const requiresConfirmation =
      isDestructive || request.recordCount > STAGING_CONFIRMATION_THRESHOLD;

    if (isDestructive) {
      warnings.push(
        `Destructive operation (${request.operation}) on staging org — confirmation required`,
      );
    }

    if (request.recordCount > STAGING_CONFIRMATION_THRESHOLD) {
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

    if (request.recordCount > DEV_WARNING_THRESHOLD) {
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

/** Build a human-readable impact summary for an operation */
function buildImpactSummary(request: OperationRequest): string {
  return (
    `${request.operation.toUpperCase()} ${request.recordCount} ` +
    `${request.objectName} record(s) on ${request.orgTier} org ${request.orgId} ` +
    `[module: ${request.module}]`
  );
}
