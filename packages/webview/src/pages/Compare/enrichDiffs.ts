import type {
  CompareItem,
  CompareRiskReason,
  MetadataComponentType,
  DiffRiskLevel,
  EnrichedDiff,
  CompareReport,
  DeploymentAdvice,
} from '@sandforge/shared';

/**
 * The groups the risk card sorts changes into, in the order a deployment
 * reads them: the data model first, what runs on it next, what shows it last.
 */
export const GROUP_ORDER: readonly string[] = [
  'Data Model',
  'Apex Code',
  'Lightning',
  'Automation',
  'Security',
  'Configuration',
  'Content',
  'Other',
];

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

/**
 * Change type multipliers for risk scoring.
 *
 * `added` is a component only the target holds: taking it out to match the
 * source is the change that loses something. `removed` is one only the source
 * holds, which a deployment creates. The weights were the other way round.
 */
const CHANGE_MULT: Record<string, number> = {
  added: 2.0,
  modified: 1.5,
  removed: 0.5,
};

/** Types whose components hold the org's data. */
const DATA_MODEL_TYPES: ReadonlySet<MetadataComponentType> = new Set([
  'CustomObject',
  'CustomField',
]);

/** Types whose components are code that other code and automation call. */
const APEX_TYPES: ReadonlySet<MetadataComponentType> = new Set(['ApexClass', 'ApexTrigger']);

/** The risk card's group of a type. */
export function groupOf(componentType: MetadataComponentType): string {
  return GROUP_MAP[componentType] ?? 'Other';
}

/**
 * Whether changes of these types call for the Apex tests: the rule behind the
 * card's "Run all Apex tests", and behind the tests a deployment is advised.
 */
export function needsApexTests(types: Iterable<string>): boolean {
  for (const type of types) {
    if (type === 'ApexClass' || type === 'ApexTrigger') return true;
  }
  return false;
}

/** Compute item risk level. */
function computeRisk(item: CompareItem): DiffRiskLevel {
  const weight = RISK_WEIGHTS[item.componentType] ?? 1;
  const mult = CHANGE_MULT[item.status] ?? 1;
  const score = weight * mult;

  if (item.severity === 'breaking' && item.status === 'added') return 'critical';
  if (item.severity === 'breaking') return 'high';
  if (score >= 8) return 'critical';
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return 'none';
}

/**
 * The reasons behind an item's risk, as codes the page words in the reader's
 * language.
 *
 * They were English sentences, and they read `removed` and `added` the other
 * way round: "Removing data model components may cause data loss" over a
 * component only the source holds, which a deployment creates, and "New
 * component — low risk" over one only the target holds.
 */
function riskReasons(item: CompareItem): CompareRiskReason[] {
  const reasons: CompareRiskReason[] = [];
  const ct = item.componentType;
  const s = item.status;

  if (s === 'added' && DATA_MODEL_TYPES.has(ct)) reasons.push('targetOnlyDataModel');
  if (s === 'added' && APEX_TYPES.has(ct)) reasons.push('targetOnlyApex');
  if (s === 'modified' && ct === 'Flow') reasons.push('flowChanged');
  if (s === 'modified' && ct === 'Profile') reasons.push('profileChanged');
  if (item.severity === 'breaking') reasons.push('breaking');
  if (s === 'removed') reasons.push('sourceOnly');

  return reasons;
}

/** A difference between the orgs: what the report scores. */
function isChange(item: CompareItem): item is CompareItem & { status: EnrichedDiff['changeType'] } {
  return item.status === 'added' || item.status === 'removed' || item.status === 'modified';
}

/**
 * Convert raw CompareItem diffs to an enriched CompareReport.
 *
 * Only changes are scored. An unchanged component is none, and one whose
 * content was not compared is not known to be one: counting it would score
 * a risk nobody checked, and leaving it out of the advice means the report
 * cannot call a comparison safe while part of it was never read.
 */
export function enrichDiffs(items: CompareItem[]): CompareReport {
  const changed = items.filter(isChange);
  const notCompared = items.some((i) => i.status === 'not_compared');

  const diffs: EnrichedDiff[] = changed.map((item) => ({
    category: item.componentType,
    changeType: item.status,
    name: item.fullName,
    sourceValue: item.sourceValue,
    targetValue: item.targetValue,
    riskLevel: computeRisk(item),
    riskReasons: riskReasons(item),
    group: groupOf(item.componentType),
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

  const advice: DeploymentAdvice[] = [];
  const cc = diffs.filter((d) => d.riskLevel === 'critical').length;
  const hc = diffs.filter((d) => d.riskLevel === 'high').length;
  if (cc > 0) advice.push({ kind: 'critical', count: cc });
  if (hc > 0) advice.push({ kind: 'high', count: hc });
  if (needsApexTests(diffs.map((d) => d.category))) {
    advice.push({ kind: 'apexTests' });
  }
  if (riskScore < 25 && !notCompared) advice.push({ kind: 'lowRisk' });
  const deploymentAdvice: DeploymentAdvice[] = advice.length > 0 ? advice : [{ kind: 'review' }];

  return {
    diffs,
    summary: { total: diffs.length, added, removed, modified, byRisk },
    riskScore,
    deploymentAdvice,
  };
}
