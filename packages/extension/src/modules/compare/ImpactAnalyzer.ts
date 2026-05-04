import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

/** An affected component identified during impact analysis */
export interface AffectedComponent {
  fullName: string;
  componentType: MetadataComponentType;
  impactType: 'direct' | 'indirect';
}

/** A dependency link between two components */
export interface DependencyLink {
  source: string;
  target: string;
  type: 'references' | 'extends' | 'triggers' | 'layout';
}

/** Full impact analysis result */
export interface ImpactAnalysis {
  impactScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: AffectedComponent[];
  dependencies: DependencyLink[];
  recommendations: string[];
}

/** Weight multipliers for different component types when computing impact */
const TYPE_WEIGHTS: Partial<Record<MetadataComponentType, number>> = {
  ApexClass: 3,
  ApexTrigger: 4,
  Flow: 3,
  ValidationRule: 2,
  CustomObject: 5,
  CustomField: 2,
  Profile: 3,
  PermissionSet: 2,
};

/** Default weight for component types not explicitly listed */
const DEFAULT_WEIGHT = 1;

/** Dependency map: component types that are implicitly affected by changes to others */
const DEPENDENCY_MAP: Partial<
  Record<
    MetadataComponentType,
    { targets: MetadataComponentType[]; linkType: DependencyLink['type'] }[]
  >
> = {
  CustomObject: [
    { targets: ['CustomField', 'ValidationRule', 'RecordType'], linkType: 'references' },
    { targets: ['Layout'], linkType: 'layout' },
    { targets: ['ApexTrigger'], linkType: 'triggers' },
  ],
  ApexClass: [
    { targets: ['ApexTrigger'], linkType: 'extends' },
    { targets: ['Flow'], linkType: 'references' },
  ],
  CustomField: [
    { targets: ['ValidationRule'], linkType: 'references' },
    { targets: ['Layout'], linkType: 'layout' },
  ],
};

/**
 * Analyzes the potential impact of deploying a set of differences.
 * Computes an impact score, determines risk level, identifies affected
 * components (direct and indirect), and provides recommendations.
 */
export class ImpactAnalyzer {
  /**
   * Analyze the impact of a set of CompareItem diffs.
   * Only changed items (non-unchanged) are considered.
   */
  analyze(diffs: CompareItem[]): ImpactAnalysis {
    const changedItems = diffs.filter((d) => d.status !== 'unchanged');

    const affectedComponents = buildAffectedComponents(changedItems);
    const dependencies = buildDependencies(changedItems);
    const impactScore = computeImpactScore(changedItems);
    const riskLevel = scoreToRiskLevel(impactScore);
    const recommendations = buildRecommendations(changedItems, riskLevel);

    return {
      impactScore,
      riskLevel,
      affectedComponents,
      dependencies,
      recommendations,
    };
  }
}

/** Build direct and indirect affected components from changed items */
function buildAffectedComponents(items: CompareItem[]): AffectedComponent[] {
  const affected: AffectedComponent[] = [];
  const directNames = new Set<string>();

  for (const item of items) {
    directNames.add(item.fullName);
    affected.push({
      fullName: item.fullName,
      componentType: item.componentType,
      impactType: 'direct',
    });
  }

  for (const item of items) {
    const depRules = DEPENDENCY_MAP[item.componentType];
    if (!depRules) {
      continue;
    }

    for (const rule of depRules) {
      for (const targetType of rule.targets) {
        const indirectName = `${item.fullName}:${targetType}`;
        if (!directNames.has(indirectName)) {
          affected.push({
            fullName: indirectName,
            componentType: targetType,
            impactType: 'indirect',
          });
        }
      }
    }
  }

  return affected;
}

/** Build dependency links from changed items using the dependency map */
function buildDependencies(items: CompareItem[]): DependencyLink[] {
  const links: DependencyLink[] = [];

  for (const item of items) {
    const depRules = DEPENDENCY_MAP[item.componentType];
    if (!depRules) {
      continue;
    }

    for (const rule of depRules) {
      for (const targetType of rule.targets) {
        links.push({
          source: item.fullName,
          target: `${item.fullName}:${targetType}`,
          type: rule.linkType,
        });
      }
    }
  }

  return links;
}

/** Compute an impact score (0-100) from changed items */
function computeImpactScore(items: CompareItem[]): number {
  if (items.length === 0) {
    return 0;
  }

  let totalWeight = 0;

  for (const item of items) {
    const weight = TYPE_WEIGHTS[item.componentType] ?? DEFAULT_WEIGHT;
    let statusMultiplier = 1;

    if (item.status === 'removed') {
      statusMultiplier = 2;
    } else if (item.status === 'modified') {
      statusMultiplier = 1.5;
    }

    totalWeight += weight * statusMultiplier;
  }

  return Math.min(100, Math.round(totalWeight));
}

/** Map an impact score to a risk level */
function scoreToRiskLevel(score: number): ImpactAnalysis['riskLevel'] {
  if (score >= 75) {
    return 'critical';
  }
  if (score >= 50) {
    return 'high';
  }
  if (score >= 25) {
    return 'medium';
  }
  return 'low';
}

/** Generate recommendations based on the changed items and risk level */
function buildRecommendations(
  items: CompareItem[],
  riskLevel: ImpactAnalysis['riskLevel'],
): string[] {
  const recommendations: string[] = [];

  const hasBreaking = items.some((i) => i.severity === 'breaking');
  const hasApex = items.some(
    (i) => i.componentType === 'ApexClass' || i.componentType === 'ApexTrigger',
  );
  const hasRemovals = items.some((i) => i.status === 'removed');
  const hasPermissions = items.some(
    (i) => i.componentType === 'Profile' || i.componentType === 'PermissionSet',
  );

  if (hasBreaking) {
    recommendations.push('Review breaking changes carefully before deployment.');
  }

  if (hasApex) {
    recommendations.push('Run all Apex tests in the target org before deploying.');
  }

  if (hasRemovals) {
    recommendations.push('Verify that removed components are not referenced elsewhere.');
  }

  if (hasPermissions) {
    recommendations.push('Validate permission changes with the security team.');
  }

  if (riskLevel === 'critical' || riskLevel === 'high') {
    recommendations.push('Consider deploying to a staging sandbox first.');
  }

  if (items.length > 50) {
    recommendations.push('Consider splitting into smaller deployments.');
  }

  return recommendations;
}
