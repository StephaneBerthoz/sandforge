import type {
  CompareItem,
  DeploymentComponent,
  DeploymentRisk,
  DeploymentSuggestion,
  MetadataComponentType,
} from '@sandforge/shared';

/** Estimated deployment time per component type in seconds */
const DURATION_PER_TYPE: Partial<Record<MetadataComponentType, number>> = {
  ApexClass: 10,
  ApexTrigger: 10,
  Flow: 8,
  CustomObject: 15,
  CustomField: 5,
  ValidationRule: 3,
  Layout: 5,
  Profile: 12,
  PermissionSet: 8,
  LightningComponentBundle: 12,
};

/** Default deployment time for types not explicitly listed */
const DEFAULT_DURATION = 3;

/** Deployment order priority (lower = deployed first) */
const DEPLOY_ORDER: Partial<Record<MetadataComponentType, number>> = {
  CustomObject: 1,
  CustomField: 2,
  RecordType: 3,
  ValidationRule: 4,
  ApexClass: 5,
  ApexTrigger: 6,
  Flow: 7,
  Layout: 8,
  Profile: 9,
  PermissionSet: 10,
  LightningComponentBundle: 11,
};

/** Default order priority for unlisted types */
const DEFAULT_ORDER = 20;

/**
 * Builds a deployment plan from comparison results.
 * Determines which components to deploy, delete, or skip,
 * calculates estimated duration, and assesses deployment risks.
 */
export class DeploymentBuilder {
  private readonly components: Map<string, DeploymentComponent> = new Map();

  /**
   * Build a full DeploymentSuggestion from a list of CompareItem diffs.
   * Only non-unchanged items are considered.
   */
  build(diffs: CompareItem[]): DeploymentSuggestion {
    this.components.clear();

    for (const diff of diffs) {
      if (diff.status === 'unchanged') {
        continue;
      }

      const component = toDeploymentComponent(diff);
      this.components.set(diff.fullName, component);
    }

    const componentList = [...this.components.values()];
    const order = computeOrder(componentList);
    const estimatedDuration = computeDuration(componentList);
    const risks = assessRisks(componentList);

    return {
      components: componentList,
      estimatedDuration,
      risks,
      order,
    };
  }

  /** Manually add a deployment component */
  addComponent(component: DeploymentComponent): void {
    this.components.set(component.fullName, component);
  }

  /** Remove a component from the deployment plan by fullName */
  removeComponent(fullName: string): void {
    this.components.delete(fullName);
  }

  /** Reorder the deployment plan according to the given order of fullNames */
  reorder(order: string[]): void {
    const orderMap = new Map(order.map((name, index) => [name, index]));
    const entries = [...this.components.entries()];

    entries.sort((a, b) => {
      const orderA = orderMap.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const orderB = orderMap.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });

    this.components.clear();
    for (const [key, value] of entries) {
      this.components.set(key, value);
    }
  }

  /** Get the current list of components in the plan */
  getComponents(): DeploymentComponent[] {
    return [...this.components.values()];
  }
}

/** Convert a CompareItem to a DeploymentComponent */
function toDeploymentComponent(item: CompareItem): DeploymentComponent {
  let action: DeploymentComponent['action'];
  let reason: string;

  switch (item.status) {
    case 'removed':
      action = 'delete';
      reason = `Component exists in source but not in target`;
      break;
    case 'added':
      action = 'deploy';
      reason = `New component found in target`;
      break;
    case 'modified':
      action = 'deploy';
      reason = `Component has been modified`;
      break;
    default:
      action = 'skip';
      reason = `No changes detected`;
  }

  if (!item.deployable) {
    action = 'skip';
    reason = `Component is not deployable`;
  }

  return {
    componentType: item.componentType,
    fullName: item.fullName,
    action,
    reason,
  };
}

/** Compute the deployment order based on component type priorities */
function computeOrder(components: DeploymentComponent[]): string[] {
  const sorted = [...components]
    .filter((c) => c.action !== 'skip')
    .sort((a, b) => {
      const orderA = DEPLOY_ORDER[a.componentType] ?? DEFAULT_ORDER;
      const orderB = DEPLOY_ORDER[b.componentType] ?? DEFAULT_ORDER;
      return orderA - orderB;
    });

  return sorted.map((c) => c.fullName);
}

/** Calculate total estimated deployment duration in seconds */
function computeDuration(components: DeploymentComponent[]): number {
  let total = 0;

  for (const component of components) {
    if (component.action === 'skip') {
      continue;
    }
    total += DURATION_PER_TYPE[component.componentType] ?? DEFAULT_DURATION;
  }

  return total;
}

/** Assess deployment risks for the component set */
function assessRisks(components: DeploymentComponent[]): DeploymentRisk[] {
  const risks: DeploymentRisk[] = [];

  for (const component of components) {
    if (component.action === 'skip') {
      continue;
    }

    if (component.action === 'delete') {
      risks.push({
        component: component.fullName,
        risk: 'high',
        description: `Deleting ${component.componentType} may break dependent components`,
      });
      continue;
    }

    const riskLevel = getComponentRiskLevel(component.componentType);
    if (riskLevel !== 'low') {
      risks.push({
        component: component.fullName,
        risk: riskLevel,
        description: `Deploying ${component.componentType} changes may affect org behavior`,
      });
    }
  }

  return risks;
}

/** Determine the inherent risk level of a component type */
function getComponentRiskLevel(
  componentType: MetadataComponentType
): DeploymentRisk['risk'] {
  switch (componentType) {
    case 'ApexClass':
    case 'ApexTrigger':
    case 'Flow':
    case 'CustomObject':
      return 'high';
    case 'ValidationRule':
    case 'Profile':
    case 'PermissionSet':
      return 'medium';
    default:
      return 'low';
  }
}
