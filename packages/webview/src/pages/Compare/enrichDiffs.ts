import type {
  CompareItem,
  MetadataComponentType,
  DiffRiskLevel,
  EnrichedDiff,
  CompareReport,
} from '@sandforge/shared';

/** Group mapping for component types. */
const GROUP_MAP: Partial<Record<MetadataComponentType, string>> = {
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

/** Risk weights by component type. */
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

/** Dependency map: which types can be affected by changes to a given type. */
const DEPENDENCY_MAP: Partial<Record<MetadataComponentType, string[]>> = {
  CustomObject: ['CustomField', 'ValidationRule', 'RecordType', 'Layout', 'ApexTrigger'],
  ApexClass: ['ApexTrigger', 'Flow'],
  CustomField: ['ValidationRule', 'Layout'],
  ApexTrigger: ['ApexClass'],
  Profile: ['PermissionSet'],
};

/** Change type multipliers for risk scoring. */
const CHANGE_MULT: Record<string, number> = {
  removed: 2.0,
  modified: 1.5,
  added: 0.5,
};

/** Compute item risk level. */
function computeRisk(item: CompareItem): DiffRiskLevel {
  const weight = RISK_WEIGHTS[item.componentType] ?? 1;
  const mult = CHANGE_MULT[item.status] ?? 1;
  const score = weight * mult;

  if (item.severity === 'breaking' && item.status === 'removed') return 'critical';
  if (item.severity === 'breaking') return 'high';
  if (score >= 8) return 'critical';
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return 'none';
}

/** Generate risk reasons for an item. */
function riskReasons(item: CompareItem): string[] {
  const reasons: string[] = [];
  const ct = item.componentType;
  const s = item.status;

  if (s === 'removed' && (ct === 'CustomObject' || ct === 'CustomField')) {
    reasons.push('Removing data model components may cause data loss.');
  }
  if (s === 'removed' && (ct === 'ApexClass' || ct === 'ApexTrigger')) {
    reasons.push('Removing Apex code may break dependent functionality.');
  }
  if (s === 'modified' && ct === 'Flow') {
    reasons.push('Flow changes may affect active process automations.');
  }
  if (s === 'modified' && ct === 'Profile') {
    reasons.push('Profile changes may alter user permissions.');
  }
  if (item.severity === 'breaking') {
    reasons.push('This is a breaking change.');
  }
  if (s === 'added') {
    reasons.push('New component — low risk.');
  }

  return reasons;
}

/**
 * Convert raw CompareItem diffs to an enriched CompareReport.
 * Unchanged items are excluded from the report.
 */
export function enrichDiffs(items: CompareItem[]): CompareReport {
  const changed = items.filter((i) => i.status !== 'unchanged');

  const diffs: EnrichedDiff[] = changed.map((item) => ({
    category: item.componentType,
    changeType: item.status as EnrichedDiff['changeType'],
    name: item.fullName,
    sourceValue: item.sourceValue,
    targetValue: item.targetValue,
    riskLevel: computeRisk(item),
    riskReasons: riskReasons(item),
    group: GROUP_MAP[item.componentType] ?? 'Other',
    dependencies: (DEPENDENCY_MAP[item.componentType] ?? []) as string[],
  }));

  const byRisk: Record<string, number> = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const d of diffs) {
    byRisk[d.riskLevel] = (byRisk[d.riskLevel] ?? 0) + 1;
    if (d.changeType === 'added') added++;
    else if (d.changeType === 'removed') removed++;
    else modified++;
  }

  let totalWeight = 0;
  for (const d of diffs) {
    const w = RISK_WEIGHTS[d.category as MetadataComponentType] ?? 1;
    const m = CHANGE_MULT[d.changeType] ?? 1;
    totalWeight += w * m;
  }
  const riskScore = Math.min(100, Math.round(totalWeight));

  const parts: string[] = [];
  const cc = diffs.filter((d) => d.riskLevel === 'critical').length;
  const hc = diffs.filter((d) => d.riskLevel === 'high').length;
  if (cc > 0) parts.push(`${cc} critical-risk change(s). Manual review required.`);
  if (hc > 0) parts.push(`${hc} high-risk change(s). Deploy to a sandbox first.`);
  if (diffs.some((d) => d.category === 'ApexClass' || d.category === 'ApexTrigger')) {
    parts.push('Run all Apex tests.');
  }
  if (riskScore < 25) parts.push('Low risk. Safe to deploy.');
  const deploymentAdvice = parts.length > 0 ? parts.join(' ') : 'Review changes before deploying.';

  return {
    diffs,
    summary: { total: diffs.length, added, removed, modified, byRisk },
    riskScore,
    deploymentAdvice,
  };
}
