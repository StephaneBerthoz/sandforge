/** Simplified Salesforce field describe result */
export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  length: number;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  externalId: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  picklistValues: PicklistEntry[];
  defaultValue: unknown;
  calculated: boolean;
  autoNumber: boolean;
  unique: boolean;
  /**
   * Whether field-level security can be set on this field at all.
   *
   * The discriminator between "nobody may write this" and "this user may not":
   * audit fields (CreatedDate, SystemModstamp) are not permissionable, while a
   * business field hidden by a permission set is. Optional because fixtures
   * predate it; absent is read as permissionable, which fails loudly rather
   * than dropping a field silently.
   */
  permissionable?: boolean;
}

/** Picklist entry from a describe */
export interface PicklistEntry {
  value: string;
  label: string;
  active: boolean;
  defaultValue: boolean;
}

/** Simplified Salesforce object describe result */
export interface ObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  queryable: boolean;
  fields: FieldDescribe[];
  recordTypeInfos: RecordTypeInfo[];
  childRelationships: ChildRelationship[];
}

/** Record type info */
export interface RecordTypeInfo {
  recordTypeId: string;
  name: string;
  developerName: string;
  active: boolean;
  defaultRecordTypeMapping: boolean;
}

/** Child relationship info */
export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
}

/**
 * Reads Salesforce object and field metadata using the Describe API.
 * This is a local cache-aware reader that can work with cached data.
 */
export class MetadataReader {
  private describeCache: Map<string, ObjectDescribe> = new Map();

  /** Store a describe result in the local cache */
  cacheDescribe(objectName: string, describe: ObjectDescribe): void {
    this.describeCache.set(objectName.toLowerCase(), describe);
  }

  /** Get a cached describe result */
  getDescribe(objectName: string): ObjectDescribe | undefined {
    return this.describeCache.get(objectName.toLowerCase());
  }

  /** Check if a describe is cached */
  hasCachedDescribe(objectName: string): boolean {
    return this.describeCache.has(objectName.toLowerCase());
  }

  /** Get all cached object names */
  getCachedObjectNames(): string[] {
    return Array.from(this.describeCache.values()).map((d) => d.name);
  }

  /** Get creatable fields for an object */
  getCreatableFields(objectName: string): FieldDescribe[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.fields.filter((f) => f.createable);
  }

  /** Get updateable fields for an object */
  getUpdateableFields(objectName: string): FieldDescribe[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.fields.filter((f) => f.updateable);
  }

  /** Get lookup/reference fields for an object */
  getReferenceFields(objectName: string): FieldDescribe[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.fields.filter((f) => f.referenceTo.length > 0);
  }

  /** Get required fields (non-nillable, createable, not auto-number) */
  getRequiredFields(objectName: string): FieldDescribe[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.fields.filter(
      (f) =>
        f.createable && !f.nillable && !f.autoNumber && !f.calculated && f.defaultValue === null,
    );
  }

  /** Get external ID fields */
  getExternalIdFields(objectName: string): FieldDescribe[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.fields.filter((f) => f.externalId);
  }

  /** Get record types for an object */
  getRecordTypes(objectName: string): RecordTypeInfo[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.recordTypeInfos.filter((rt) => rt.active);
  }

  /** Get child relationships for an object */
  getChildRelationships(objectName: string): ChildRelationship[] {
    const describe = this.getDescribe(objectName);
    if (!describe) return [];
    return describe.childRelationships;
  }

  /** Clear cache for a specific object */
  clearCache(objectName: string): void {
    this.describeCache.delete(objectName.toLowerCase());
  }

  /** Clear all cached describes */
  clearAllCache(): void {
    this.describeCache.clear();
  }

  /** Get cache size */
  get cacheSize(): number {
    return this.describeCache.size;
  }
}
