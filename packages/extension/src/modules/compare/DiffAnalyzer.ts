import type {
  CompareItem,
  MetadataComponentType,
  DiffRiskLevel,
  EnrichedDiff,
  CompareReport,
} from '@sandforge/shared';

/** Group mapping for component types */
const GROUP_MAP: Record<MetadataComponentType, string> = {
  ApexClass: 'Apex Code',
  ApexTrigger: 'Apex Code',
  LightningComponentBundle: 'Lightning',
  Flow: 'Automation',
  WorkflowRule: 'Automation',
  ValidationRule: 'Automation',
  CustomObject: 'Data Model',
  CustomField: 'Data Model',
  RecordType: 'Data Model',
  Profile: 'Security',
  PermissionSet: 'Security',
  Layout: 'Configuration',
  CustomLabel: 'Configuration',
  CustomMetadata: 'Configuration',
  CustomSetting: 'Configuration',
  StaticResource: 'Content',
  EmailTemplate: 'Content',
  Report: 'Content',
  Dashboard: 'Content',
  Other: 'Other',
};

/** Risk weights by component type — higher means riskier when changed. */
const RISK_WEIGHTS: Partial<Record<MetadataComponentType, number>> = {
  CustomObject: 5,
  ApexTrigger: 4,
  ApexClass: 3,
  Flow: 3,
  Profile: 3,
  CustomField: 2,
  ValidationRule: 2,
  PermissionSet: 2,
};

/** Default risk weight for types not explicitly listed. */
const DEFAULT_RISK_WEIGHT = 1;

/** Multiplier applied to the risk weight based on change type. */
const CHANGE_MULTIPLIER: Record<EnrichedDiff['changeType'], number> = {
  removed: 2.0,
  modified: 1.5,
  added: 0.5,
};

/** Dependency map: which types can be implicitly affected by a change to a given type. */
const DEPENDENCY_MAP: Partial<Record<MetadataComponentType, MetadataComponentType[]>> = {
  CustomObject: ['CustomField', 'ValidationRule', 'RecordType', 'Layout', 'ApexTrigger'],
  ApexClass: ['ApexTrigger', 'Flow'],
  CustomField: ['ValidationRule', 'Layout'],
  ApexTrigger: ['ApexClass'],
  Profile: ['PermissionSet'],
};

/**
 * Enriches raw CompareItem diffs with risk scoring, grouping,
 * dependency analysis, and deployment advice.
 * Produces a CompareReport conforming to the shared interface.
 */
export class DiffAnalyzer {
  /**
   * Analyze a set of CompareItems and produce a CompareReport.
   * Unchanged items are excluded from the report.
   */
  analyze(items: CompareItem[]): CompareReport {
    const changed = items.filter((i) => i.status !== 'unchanged');

    const diffs = changed.map((item) => this.enrichItem(item));

    const summary = this.buildSummary(diffs);
    const riskScore = this.computeRiskScore(diffs);
    const deploymentAdvice = this.buildAdvice(diffs, riskScore);

    return { diffs, summary, riskScore, deploymentAdvice };
  }

  /** Convert a single CompareItem to an EnrichedDiff. */
  private enrichItem(item: CompareItem): EnrichedDiff {
    const changeType = item.status as EnrichedDiff['changeType'];
    const componentType = item.componentType;
    const riskReasons = this.computeRiskReasons(item);
    const riskLevel = this.computeItemRiskLevel(item);
    const group = GROUP_MAP[componentType] ?? 'Other';
    const dependencies = this.resolveDependencies(componentType);

    return {
      category: componentType,
      changeType,
      name: item.fullName,
      sourceValue: item.sourceValue,
      targetValue: item.targetValue,
      riskLevel,
      riskReasons,
      group,
      dependencies,
    };
  }

  /** Compute risk level for a single item based on type, change, and severity. */
  private computeItemRiskLevel(item: CompareItem): DiffRiskLevel {
    const weight = RISK_WEIGHTS[item.componentType] ?? DEFAULT_RISK_WEIGHT;
    const multiplier = CHANGE_MULTIPLIER[item.status as EnrichedDiff['changeType']] ?? 1;
    const score = weight * multiplier;

    if (item.severity === 'breaking' && item.status === 'removed') return 'critical';
    if (item.severity === 'breaking') return 'high';
    if (score >= 8) return 'critical';
    if (score >= 5) return 'high';
    if (score >= 3) return 'medium';
    if (score >= 1) return 'low';
    return 'none';
  }

  /** Generate human-readable risk reasons for an item. */
  private computeRiskReasons(item: CompareItem): string[] {
    const reasons: string[] = [];
    const ct = item.componentType;
    const status = item.status;

    if (status === 'removed' && (ct === 'CustomObject' || ct === 'CustomField')) {
      reasons.push('Removing data model components may cause data loss.');
    }
    if (status === 'removed' && (ct === 'ApexClass' || ct === 'ApexTrigger')) {
      reasons.push('Removing Apex code may break dependent functionality.');
    }
    if (status === 'modified' && ct === 'Flow') {
      reasons.push('Flow changes may affect active process automations.');
    }
    if (status === 'modified' && ct === 'Profile') {
      reasons.push('Profile changes may alter user permissions.');
    }
    if (status === 'removed' && ct === 'ValidationRule') {
      reasons.push('Removing validation rules may allow invalid data entry.');
    }
    if (item.severity === 'breaking') {
      reasons.push('This is a breaking change that requires careful review.');
    }
    if (status === 'added') {
      reasons.push('New component — low risk.');
    }

    return reasons;
  }

  /** Resolve dependency names for a component type. */
  private resolveDependencies(componentType: MetadataComponentType): string[] {
    return (DEPENDENCY_MAP[componentType] ?? []) as string[];
  }

  /** Build summary counts from enriched diffs. */
  private buildSummary(diffs: EnrichedDiff[]): CompareReport['summary'] {
    const byRisk: Record<string, number> = {
      none: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    let added = 0;
    let removed = 0;
    let modified = 0;

    for (const diff of diffs) {
      byRisk[diff.riskLevel] = (byRisk[diff.riskLevel] ?? 0) + 1;

      if (diff.changeType === 'added') added++;
      else if (diff.changeType === 'removed') removed++;
      else if (diff.changeType === 'modified') modified++;
    }

    return {
      total: diffs.length,
      added,
      removed,
      modified,
      byRisk,
    };
  }

  /** Compute an overall risk score (0-100). */
  private computeRiskScore(diffs: EnrichedDiff[]): number {
    if (diffs.length === 0) return 0;

    let totalWeight = 0;

    for (const diff of diffs) {
      const typeWeight = RISK_WEIGHTS[diff.category as MetadataComponentType] ?? DEFAULT_RISK_WEIGHT;
      const multiplier = CHANGE_MULTIPLIER[diff.changeType] ?? 1;
      totalWeight += typeWeight * multiplier;
    }

    return Math.min(100, Math.round(totalWeight));
  }

  /** Generate deployment advice text based on diffs and risk score. */
  private buildAdvice(diffs: EnrichedDiff[], riskScore: number): string {
    if (diffs.length === 0) return 'No changes to deploy.';

    const parts: string[] = [];

    const criticalCount = diffs.filter((d) => d.riskLevel === 'critical').length;
    const highCount = diffs.filter((d) => d.riskLevel === 'high').length;

    if (criticalCount > 0) {
      parts.push(`${criticalCount} critical-risk change(s) detected. Manual review required before deployment.`);
    }

    if (highCount > 0) {
      parts.push(`${highCount} high-risk change(s). Deploy to a sandbox first.`);
    }

    const hasApex = diffs.some(
      (d) => d.category === 'ApexClass' || d.category === 'ApexTrigger',
    );
    if (hasApex) {
      parts.push('Run all Apex tests in the target org.');
    }

    const hasRemovals = diffs.some((d) => d.changeType === 'removed');
    if (hasRemovals) {
      parts.push('Verify removed components are not referenced elsewhere.');
    }

    if (riskScore >= 75) {
      parts.push('Overall risk is critical. Consider splitting into smaller deployments.');
    } else if (riskScore >= 50) {
      parts.push('Overall risk is high. Proceed with caution.');
    } else if (riskScore < 25) {
      parts.push('Low overall risk. Safe to deploy.');
    }

    return parts.join(' ');
  }
}
