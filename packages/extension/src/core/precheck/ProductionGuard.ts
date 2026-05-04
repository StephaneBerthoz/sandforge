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

/**
 * Guards against dangerous operations on production and staging orgs.
 * Enforces tier-based rules for writes, deletes, and large-volume operations.
 */
export class ProductionGuard {
  private readonly overrides: Map<string, boolean> = new Map();
  private readonly auditLog: AuditEntry[] = [];

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

  /** Record a safety check decision in the audit log */
  logOperation(request: OperationRequest, result: SafetyCheckResult): void {
    this.auditLog.push({
      request,
      result,
      timestamp: new Date().toISOString(),
    });
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
      requiresConfirmation: true,
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
