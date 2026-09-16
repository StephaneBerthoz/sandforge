/**
 * The subset of a Salesforce describe that the metadata guards read.
 *
 * Types only: this module compiles to nothing.
 */

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
