import type {
  PreCheckConfig,
  PreCheckItem,
  ConfirmationItem,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Org security information */
export interface OrgSecurityInfo {
  orgType: 'production' | 'sandbox' | 'scratch' | 'developer';
  safetyTier: 'low' | 'medium' | 'high' | 'critical';
  sensitiveFields: SensitiveFieldInfo[];
  gdprFields: GdprFieldInfo[];
}

/** Sensitive field detection info */
export interface SensitiveFieldInfo {
  objectApiName: string;
  fieldApiName: string;
  sensitivityType: 'pii' | 'financial' | 'health' | 'credential';
}

/** GDPR-flagged field info */
export interface GdprFieldInfo {
  objectApiName: string;
  fieldApiName: string;
  gdprClassification: 'personal' | 'sensitive' | 'special_category';
}

/** Result of the security check, including confirmation items */
export interface SecurityCheckResult {
  items: PreCheckItem[];
  confirmations: ConfirmationItem[];
}

/** Dependency: fetches security information for the org */
export type FetchSecurityInfoFn = (
  orgId: string,
  operationConfig: Record<string, unknown>
) => Promise<OrgSecurityInfo>;

/**
 * Checks security aspects including safety tier, sensitive data detection,
 * GDPR field presence, and production guard rails.
 */
export class SecurityCheck {
  private readonly fetchSecurityInfo: FetchSecurityInfoFn;

  constructor(fetchSecurityInfo: FetchSecurityInfoFn) {
    this.fetchSecurityInfo = fetchSecurityInfo;
  }

  /** Run all security checks and return both items and confirmation requirements */
  async check(config: PreCheckConfig): Promise<SecurityCheckResult> {
    const info = await this.fetchSecurityInfo(
      config.targetOrgId,
      config.operationConfig
    );
    const items: PreCheckItem[] = [];
    const confirmations: ConfirmationItem[] = [];

    items.push(this.checkSafetyTier(info));
    items.push(...this.checkSensitiveFields(info.sensitiveFields));
    items.push(...this.checkGdprFields(info.gdprFields));

    const productionResult = this.checkProductionGuard(info);
    items.push(productionResult.item);
    if (productionResult.confirmation) {
      confirmations.push(productionResult.confirmation);
    }

    if (info.sensitiveFields.length > 0 && info.orgType === 'production') {
      confirmations.push({
        title: 'Sensitive Data in Production',
        description: `This operation will access ${info.sensitiveFields.length} sensitive field(s) in a production org. Verify data handling compliance.`,
        severity: 'warning',
        requiresTypedConfirmation: false,
      });
    }

    if (info.gdprFields.length > 0) {
      confirmations.push({
        title: 'GDPR Data Detected',
        description: `This operation involves ${info.gdprFields.length} GDPR-classified field(s). Ensure data processing agreements are in place.`,
        severity: 'warning',
        requiresTypedConfirmation: false,
      });
    }

    return { items, confirmations };
  }

  /** Check the org safety tier */
  private checkSafetyTier(info: OrgSecurityInfo): PreCheckItem {
    const isCritical = info.safetyTier === 'critical';
    const isHigh = info.safetyTier === 'high';

    let severity: 'info' | 'warning' | 'error';
    if (isCritical) {
      severity = 'error';
    } else if (isHigh) {
      severity = 'warning';
    } else {
      severity = 'info';
    }

    return {
      id: randomUUID(),
      category: 'security',
      name: 'Safety Tier',
      description: 'Evaluates the org safety tier classification',
      severity,
      passed: !isCritical,
      message: `Org safety tier: ${info.safetyTier} (type: ${info.orgType})`,
      details: { safetyTier: info.safetyTier, orgType: info.orgType },
      autoFixable: false,
    };
  }

  /** Check for sensitive fields in the operation scope */
  private checkSensitiveFields(fields: SensitiveFieldInfo[]): PreCheckItem[] {
    if (fields.length === 0) {
      return [{
        id: randomUUID(),
        category: 'security',
        name: 'Sensitive Data Detection',
        description: 'Scans for sensitive fields in the operation scope',
        severity: 'info',
        passed: true,
        message: 'No sensitive fields detected in operation scope',
        autoFixable: false,
      }];
    }

    return fields.map((field) => ({
      id: randomUUID(),
      category: 'security' as const,
      name: `Sensitive field: ${field.objectApiName}.${field.fieldApiName}`,
      description: `Detected ${field.sensitivityType} data in ${field.fieldApiName}`,
      severity: 'warning' as const,
      passed: true,
      message: `Sensitive field detected (${field.sensitivityType}): ${field.objectApiName}.${field.fieldApiName}`,
      details: { ...field } as unknown as Record<string, unknown>,
      autoFixable: false,
    }));
  }

  /** Check for GDPR-classified fields */
  private checkGdprFields(fields: GdprFieldInfo[]): PreCheckItem[] {
    if (fields.length === 0) {
      return [{
        id: randomUUID(),
        category: 'security',
        name: 'GDPR Fields',
        description: 'Checks for GDPR-classified fields in the operation scope',
        severity: 'info',
        passed: true,
        message: 'No GDPR-classified fields detected',
        autoFixable: false,
      }];
    }

    return fields.map((field) => ({
      id: randomUUID(),
      category: 'security' as const,
      name: `GDPR field: ${field.objectApiName}.${field.fieldApiName}`,
      description: `GDPR ${field.gdprClassification} data in ${field.fieldApiName}`,
      severity: 'warning' as const,
      passed: true,
      message: `GDPR ${field.gdprClassification} field: ${field.objectApiName}.${field.fieldApiName}`,
      details: { ...field } as unknown as Record<string, unknown>,
      autoFixable: false,
    }));
  }

  /** Production guard: requires typed confirmation for critical production operations */
  private checkProductionGuard(
    info: OrgSecurityInfo
  ): { item: PreCheckItem; confirmation?: ConfirmationItem } {
    const isProduction = info.orgType === 'production';
    const isCritical = info.safetyTier === 'critical';

    if (!isProduction) {
      return {
        item: {
          id: randomUUID(),
          category: 'security',
          name: 'Production Guard',
          description: 'Verifies operations on production orgs require confirmation',
          severity: 'info',
          passed: true,
          message: `Non-production org (${info.orgType}) — no production guard needed`,
          autoFixable: false,
        },
      };
    }

    return {
      item: {
        id: randomUUID(),
        category: 'security',
        name: 'Production Guard',
        description: 'Verifies operations on production orgs require confirmation',
        severity: isCritical ? 'error' : 'warning',
        passed: false,
        message: isCritical
          ? 'Production org with critical safety tier — typed confirmation required'
          : 'Production org — confirmation required before proceeding',
        details: { orgType: info.orgType, safetyTier: info.safetyTier },
        autoFixable: false,
      },
      confirmation: {
        title: 'Production Org Operation',
        description: isCritical
          ? 'You are about to perform an operation on a CRITICAL production org. This action may affect live data.'
          : 'You are about to perform an operation on a production org.',
        severity: isCritical ? 'error' : 'warning',
        requiresTypedConfirmation: isCritical,
        confirmationText: isCritical ? 'I understand the risks' : undefined,
      },
    };
  }
}
