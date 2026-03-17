import type {
  PreCheckConfig,
  PreCheckItem,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Org status data returned by the fetch function */
export interface OrgStatusData {
  isMaintenanceScheduled: boolean;
  maintenanceWindow?: { start: string; end: string };
  isSandboxRefreshInProgress: boolean;
  isReadOnly: boolean;
  isDeploymentInProgress: boolean;
  instanceName: string;
  orgType: 'production' | 'sandbox' | 'scratch' | 'developer';
}

/** Dependency: fetches current org status */
export type FetchOrgStatusFn = (orgId: string) => Promise<OrgStatusData>;

/**
 * Checks the target org operational status including scheduled maintenance,
 * sandbox refresh status, read-only mode, and active deployments.
 */
export class OrgStatusCheck {
  private readonly fetchOrgStatus: FetchOrgStatusFn;

  constructor(fetchOrgStatus: FetchOrgStatusFn) {
    this.fetchOrgStatus = fetchOrgStatus;
  }

  /** Run all org status checks */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const status = await this.fetchOrgStatus(config.targetOrgId);

    return [
      this.checkMaintenance(status),
      this.checkSandboxRefresh(status),
      this.checkReadOnly(status),
      this.checkDeployment(status),
    ];
  }

  /** Check for scheduled or active maintenance */
  private checkMaintenance(status: OrgStatusData): PreCheckItem {
    const passed = !status.isMaintenanceScheduled;

    return {
      id: randomUUID(),
      category: 'org_status',
      name: 'Scheduled Maintenance',
      description: `Checks for scheduled maintenance on ${status.instanceName}`,
      severity: passed ? 'info' : 'blocker',
      passed,
      message: passed
        ? `No scheduled maintenance on ${status.instanceName}`
        : `Maintenance scheduled on ${status.instanceName}: ${status.maintenanceWindow?.start ?? 'unknown'} to ${status.maintenanceWindow?.end ?? 'unknown'}`,
      details: {
        instanceName: status.instanceName,
        isMaintenanceScheduled: status.isMaintenanceScheduled,
        maintenanceWindow: status.maintenanceWindow,
      },
      autoFixable: false,
    };
  }

  /** Check if a sandbox refresh is in progress */
  private checkSandboxRefresh(status: OrgStatusData): PreCheckItem {
    const passed = !status.isSandboxRefreshInProgress;

    return {
      id: randomUUID(),
      category: 'org_status',
      name: 'Sandbox Refresh',
      description: 'Checks if a sandbox refresh is currently in progress',
      severity: passed ? 'info' : 'blocker',
      passed,
      message: passed
        ? 'No sandbox refresh in progress'
        : 'Sandbox refresh is in progress — operations will fail',
      details: {
        isSandboxRefreshInProgress: status.isSandboxRefreshInProgress,
        orgType: status.orgType,
      },
      autoFixable: false,
    };
  }

  /** Check if the org is in read-only mode */
  private checkReadOnly(status: OrgStatusData): PreCheckItem {
    const passed = !status.isReadOnly;

    return {
      id: randomUUID(),
      category: 'org_status',
      name: 'Read-Only Mode',
      description: 'Checks if the org is in read-only mode',
      severity: passed ? 'info' : 'blocker',
      passed,
      message: passed
        ? 'Org is not in read-only mode'
        : 'Org is in read-only mode — write operations will fail',
      details: {
        isReadOnly: status.isReadOnly,
        instanceName: status.instanceName,
      },
      autoFixable: false,
    };
  }

  /** Check if a deployment is currently in progress */
  private checkDeployment(status: OrgStatusData): PreCheckItem {
    const passed = !status.isDeploymentInProgress;

    return {
      id: randomUUID(),
      category: 'org_status',
      name: 'Deployment In Progress',
      description: 'Checks if a metadata deployment is active',
      severity: passed ? 'info' : 'warning',
      passed,
      message: passed
        ? 'No deployment in progress'
        : 'A deployment is in progress — data operations may be affected by schema changes',
      details: {
        isDeploymentInProgress: status.isDeploymentInProgress,
      },
      autoFixable: false,
    };
  }
}
