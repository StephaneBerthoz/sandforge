import type { CompareItem, CompareSeverity, DiffStatus } from '@sandforge/shared';

/** CRUD permission flags for a Salesforce object */
export interface CrudPermissions {
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
}

/** A single permission entry representing a Profile or PermissionSet */
export interface PermissionEntry {
  name: string;
  type: 'Profile' | 'PermissionSet';
  objectPermissions: Record<string, CrudPermissions>;
  fieldPermissions: Record<string, boolean>;
}

/** A row in the permission matrix comparing source and target CRUD */
export interface PermissionMatrixRow {
  objectName: string;
  source: CrudPermissions;
  target: CrudPermissions;
  hasDifference: boolean;
}

/** Function signature for fetching permissions from a Salesforce org */
export type FetchPermissionsFn = (orgId: string) => Promise<PermissionEntry[]>;

/** Default CRUD permissions (all false) */
const DEFAULT_CRUD: CrudPermissions = {
  create: false,
  read: false,
  update: false,
  delete: false,
};

/**
 * Compares profiles and permission sets between two Salesforce orgs.
 * Detects differences in object-level CRUD permissions and field-level
 * security settings.
 */
export class PermissionCompare {
  private readonly fetchPermissions: FetchPermissionsFn;

  constructor(fetchPermissions: FetchPermissionsFn) {
    this.fetchPermissions = fetchPermissions;
  }

  /**
   * Compare permissions between source and target orgs.
   * Produces CompareItems for each permission entry that differs.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string
  ): Promise<CompareItem[]> {
    const [sourcePerms, targetPerms] = await Promise.all([
      this.fetchPermissions(sourceOrgId),
      this.fetchPermissions(targetOrgId),
    ]);

    const sourceMap = new Map(sourcePerms.map((p) => [p.name, p]));
    const targetMap = new Map(targetPerms.map((p) => [p.name, p]));
    const allNames = new Set([...sourceMap.keys(), ...targetMap.keys()]);

    const items: CompareItem[] = [];

    for (const name of allNames) {
      const source = sourceMap.get(name);
      const target = targetMap.get(name);

      if (source && !target) {
        items.push(createPermissionItem(name, source.type, 'removed', source, undefined));
      } else if (!source && target) {
        items.push(createPermissionItem(name, target.type, 'added', undefined, target));
      } else if (source && target) {
        const hasDiff = hasPermissionDifference(source, target);
        const status: DiffStatus = hasDiff ? 'modified' : 'unchanged';
        items.push(createPermissionItem(name, source.type, status, source, target));
      }
    }

    return items;
  }

  /**
   * Build a permission matrix comparing object-level CRUD permissions
   * between source and target permission entries.
   */
  buildPermissionMatrix(
    sourcePerms: PermissionEntry[],
    targetPerms: PermissionEntry[]
  ): PermissionMatrixRow[] {
    const sourceObjects = aggregateObjectPermissions(sourcePerms);
    const targetObjects = aggregateObjectPermissions(targetPerms);
    const allObjects = new Set([...sourceObjects.keys(), ...targetObjects.keys()]);

    const rows: PermissionMatrixRow[] = [];

    for (const objectName of allObjects) {
      const source = sourceObjects.get(objectName) ?? { ...DEFAULT_CRUD };
      const target = targetObjects.get(objectName) ?? { ...DEFAULT_CRUD };
      const hasDifference =
        source.create !== target.create ||
        source.read !== target.read ||
        source.update !== target.update ||
        source.delete !== target.delete;

      rows.push({ objectName, source, target, hasDifference });
    }

    return rows;
  }
}

/** Aggregate object permissions across multiple permission entries using OR logic */
function aggregateObjectPermissions(
  entries: PermissionEntry[]
): Map<string, CrudPermissions> {
  const result = new Map<string, CrudPermissions>();

  for (const entry of entries) {
    for (const [objectName, crud] of Object.entries(entry.objectPermissions)) {
      const existing = result.get(objectName) ?? {
        create: false,
        read: false,
        update: false,
        delete: false,
      };

      existing.create = existing.create || crud.create;
      existing.read = existing.read || crud.read;
      existing.update = existing.update || crud.update;
      existing.delete = existing.delete || crud.delete;

      result.set(objectName, existing);
    }
  }

  return result;
}

/** Check if two permission entries have any differences */
function hasPermissionDifference(
  source: PermissionEntry,
  target: PermissionEntry
): boolean {
  const sourceObjKeys = Object.keys(source.objectPermissions);
  const targetObjKeys = Object.keys(target.objectPermissions);
  const allObjKeys = new Set([...sourceObjKeys, ...targetObjKeys]);

  for (const key of allObjKeys) {
    const s = source.objectPermissions[key] ?? DEFAULT_CRUD;
    const t = target.objectPermissions[key] ?? DEFAULT_CRUD;
    if (s.create !== t.create || s.read !== t.read || s.update !== t.update || s.delete !== t.delete) {
      return true;
    }
  }

  const sourceFieldKeys = Object.keys(source.fieldPermissions);
  const targetFieldKeys = Object.keys(target.fieldPermissions);
  const allFieldKeys = new Set([...sourceFieldKeys, ...targetFieldKeys]);

  for (const key of allFieldKeys) {
    const s = source.fieldPermissions[key] ?? false;
    const t = target.fieldPermissions[key] ?? false;
    if (s !== t) {
      return true;
    }
  }

  return false;
}

/** Determine severity for permission changes */
function determineSeverity(status: DiffStatus, permType: 'Profile' | 'PermissionSet'): CompareSeverity {
  if (status === 'added' || status === 'unchanged') {
    return 'info';
  }
  if (permType === 'Profile') {
    return 'breaking';
  }
  return 'warning';
}

/** Create a CompareItem for a permission entry diff */
function createPermissionItem(
  name: string,
  permType: 'Profile' | 'PermissionSet',
  status: DiffStatus,
  source: PermissionEntry | undefined,
  target: PermissionEntry | undefined
): CompareItem {
  const componentType = permType === 'Profile' ? 'Profile' : 'PermissionSet';
  return {
    componentType,
    fullName: name,
    status,
    sourceValue: source ? JSON.stringify(source.objectPermissions) : undefined,
    targetValue: target ? JSON.stringify(target.objectPermissions) : undefined,
    severity: determineSeverity(status, permType),
    deployable: status !== 'unchanged',
  };
}
