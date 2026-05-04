/** Information about a Salesforce metadata deployment */
export interface DeploymentInfo {
  id: string;
  status: 'Pending' | 'InProgress' | 'Succeeded' | 'Failed' | 'Canceled';
  startDate: string;
  completedDate?: string;
  createdBy: string;
  componentCount: number;
  errorCount: number;
}

/** Function signature for querying Salesforce deployments */
export type QueryDeploymentsFn = (orgId: string) => Promise<DeploymentInfo[]>;

const ACTIVE_DEPLOYMENT_STATUSES = new Set<DeploymentInfo['status']>(['Pending', 'InProgress']);

/**
 * Tracks recent Salesforce metadata deployments.
 * Maintains a cache of deployment records per org and provides
 * filtering for active and recent deployments.
 */
export class DeploymentTracker {
  private readonly queryDeployments: QueryDeploymentsFn;
  private readonly deploymentCache: Map<string, DeploymentInfo[]> = new Map();

  constructor(queryDeployments: QueryDeploymentsFn) {
    this.queryDeployments = queryDeployments;
  }

  /** Fetch deployment records from Salesforce and update the cache */
  async fetch(orgId: string): Promise<DeploymentInfo[]> {
    const deployments = await this.queryDeployments(orgId);
    this.deploymentCache.set(orgId, deployments);
    return deployments;
  }

  /** Return cached deployments that are still in progress */
  getActiveDeployments(orgId: string): DeploymentInfo[] {
    const deployments = this.deploymentCache.get(orgId) ?? [];
    return deployments.filter((d) => ACTIVE_DEPLOYMENT_STATUSES.has(d.status));
  }

  /** Return the most recent N deployments sorted by start date descending */
  getRecentDeployments(orgId: string, count: number): DeploymentInfo[] {
    const deployments = this.deploymentCache.get(orgId) ?? [];
    const sorted = [...deployments].sort(
      (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
    );
    return sorted.slice(0, count);
  }
}
