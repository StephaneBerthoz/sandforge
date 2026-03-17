import type {
  PreCheckConfig,
  PreCheckItem,
  PermissionCheckDetail,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Raw permission data returned by the fetch function */
export interface PermissionData {
  objectPermissions: PermissionCheckDetail[];
  hasModifyAllData: boolean;
  hasViewAllData: boolean;
  hasBulkApiPermission: boolean;
}

/** Dependency: fetches permission data for a given org and objects */
export type FetchPermissionsFn = (
  orgId: string,
  operationConfig: Record<string, unknown>
) => Promise<PermissionData>;

/**
 * Checks CRUD permissions, field-level security, Modify All Data,
 * View All Data, and Bulk API permission for the target org.
 */
export class PermissionCheck {
  private readonly fetchPermissions: FetchPermissionsFn;

  constructor(fetchPermissions: FetchPermissionsFn) {
    this.fetchPermissions = fetchPermissions;
  }

  /** Run all permission checks against the target org */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const data = await this.fetchPermissions(
      config.targetOrgId,
      config.operationConfig
    );
    const items: PreCheckItem[] = [];

    for (const objPerm of data.objectPermissions) {
      items.push(...this.checkObjectPermissions(objPerm));
    }

    items.push(this.checkModifyAllData(data.hasModifyAllData));
    items.push(this.checkViewAllData(data.hasViewAllData));
    items.push(this.checkBulkApiPermission(data.hasBulkApiPermission));

    return items;
  }

  /** Check CRUD and FLS for a single object */
  private checkObjectPermissions(detail: PermissionCheckDetail): PreCheckItem[] {
    const items: PreCheckItem[] = [];
    const { objectApiName, crudPermissions, missingFieldPermissions } = detail;

    const missingCrud: string[] = [];
    if (!crudPermissions.create) missingCrud.push('Create');
    if (!crudPermissions.read) missingCrud.push('Read');
    if (!crudPermissions.update) missingCrud.push('Update');
    if (!crudPermissions.delete) missingCrud.push('Delete');

    const crudPassed = missingCrud.length === 0;

    items.push({
      id: randomUUID(),
      category: 'permissions',
      name: `CRUD permissions for ${objectApiName}`,
      description: `Verifies Create, Read, Update, Delete access on ${objectApiName}`,
      severity: crudPassed ? 'info' : 'error',
      passed: crudPassed,
      message: crudPassed
        ? `All CRUD permissions granted on ${objectApiName}`
        : `Missing CRUD permissions on ${objectApiName}: ${missingCrud.join(', ')}`,
      details: { objectApiName, crudPermissions, missingCrud } as unknown as Record<string, unknown>,
      autoFixable: false,
    });

    if (missingFieldPermissions.length > 0) {
      items.push({
        id: randomUUID(),
        category: 'permissions',
        name: `Field-level security for ${objectApiName}`,
        description: `Verifies field-level access on ${objectApiName}`,
        severity: 'error',
        passed: false,
        message: `Missing FLS on ${objectApiName}: ${missingFieldPermissions.join(', ')}`,
        details: { objectApiName, missingFieldPermissions } as unknown as Record<string, unknown>,
        autoFixable: false,
      });
    }

    return items;
  }

  /** Check Modify All Data system permission */
  private checkModifyAllData(hasPermission: boolean): PreCheckItem {
    return {
      id: randomUUID(),
      category: 'permissions',
      name: 'Modify All Data',
      description: 'Checks if the user has the Modify All Data system permission',
      severity: hasPermission ? 'info' : 'warning',
      passed: hasPermission,
      message: hasPermission
        ? 'Modify All Data permission is granted'
        : 'Modify All Data permission is not granted — some operations may be restricted',
      autoFixable: false,
    };
  }

  /** Check View All Data system permission */
  private checkViewAllData(hasPermission: boolean): PreCheckItem {
    return {
      id: randomUUID(),
      category: 'permissions',
      name: 'View All Data',
      description: 'Checks if the user has the View All Data system permission',
      severity: hasPermission ? 'info' : 'warning',
      passed: hasPermission,
      message: hasPermission
        ? 'View All Data permission is granted'
        : 'View All Data permission is not granted — query results may be incomplete',
      autoFixable: false,
    };
  }

  /** Check Bulk API access permission */
  private checkBulkApiPermission(hasPermission: boolean): PreCheckItem {
    return {
      id: randomUUID(),
      category: 'permissions',
      name: 'Bulk API Permission',
      description: 'Checks if the user can use the Bulk API',
      severity: hasPermission ? 'info' : 'blocker',
      passed: hasPermission,
      message: hasPermission
        ? 'Bulk API access is granted'
        : 'Bulk API access is denied — bulk operations cannot proceed',
      autoFixable: false,
    };
  }
}
