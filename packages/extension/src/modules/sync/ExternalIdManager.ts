import type { SyncObjectConfig } from '@sandforge/shared';

/** Field describe information from Salesforce */
export interface FieldDescribe {
  name: string;
  type: string;
  externalId: boolean;
  unique: boolean;
  idLookup: boolean;
}

/** Function to describe an object's fields in an org */
export type DescribeFn = (orgId: string, objectName: string) => Promise<FieldDescribe[]>;

/** Dependencies required by ExternalIdManager */
export interface ExternalIdManagerDeps {
  describe: DescribeFn;
}

/**
 * Manages external ID fields used for upsert operations.
 * Resolves the external ID field for a sync configuration and validates
 * that the field exists and is marked as an external ID in the target org.
 */
export class ExternalIdManager {
  private readonly deps: ExternalIdManagerDeps;

  constructor(deps: ExternalIdManagerDeps) {
    this.deps = deps;
  }

  /**
   * Resolve the external ID field name for a sync object configuration.
   * Returns the configured externalIdField, or defaults to 'Id'.
   */
  resolveExternalId(objectConfig: SyncObjectConfig): string {
    if (objectConfig.externalIdField && objectConfig.externalIdField.length > 0) {
      return objectConfig.externalIdField;
    }
    return 'Id';
  }

  /**
   * Verify that a field exists on the object and is marked as an external ID.
   * Returns true if the field is valid for upsert operations, false otherwise.
   */
  async ensureExternalId(orgId: string, objectName: string, fieldName: string): Promise<boolean> {
    if (fieldName === 'Id') {
      return true;
    }

    const fields = await this.deps.describe(orgId, objectName);
    const field = fields.find((f) => f.name === fieldName);

    if (!field) {
      return false;
    }

    return field.externalId || field.idLookup;
  }
}
