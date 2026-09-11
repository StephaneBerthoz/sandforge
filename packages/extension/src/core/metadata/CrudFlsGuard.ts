import type { ObjectDescribe, FieldDescribe } from './MetadataReader.js';

/** DML operation type that requires CRUD permission verification. */
export type CrudOperation = 'insert' | 'update' | 'upsert' | 'delete';

/** Result of a CRUD/FLS permission check. */
export interface CrudFlsCheckResult {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** Reason the operation is denied (empty if allowed). */
  reason: string;
  /** Fields that fail FLS for the requested operation (empty for delete). */
  deniedFields: string[];
}

/** Function that fetches an ObjectDescribe for a given object API name. */
export type DescribeFetchFn = (objectApiName: string) => Promise<ObjectDescribe | undefined>;

/**
 * Verifies CRUD and FLS permissions before DML operations using the
 * Salesforce Object Describe metadata.
 *
 * This guard should be called immediately before executing DML to ensure
 * the running user has the required object-level and field-level permissions.
 */
export class CrudFlsGuard {
  private readonly fetchDescribe: DescribeFetchFn;

  constructor(fetchDescribe: DescribeFetchFn) {
    this.fetchDescribe = fetchDescribe;
  }

  /**
   * Check CRUD permission for an object-level operation.
   * @param objectApiName - Salesforce object API name (e.g. 'Account').
   * @param operation - The DML operation to verify.
   * @returns Check result indicating whether the operation is allowed.
   */
  async checkCrudPermission(
    objectApiName: string,
    operation: CrudOperation,
  ): Promise<CrudFlsCheckResult> {
    const describe = await this.fetchDescribe(objectApiName);
    if (!describe) {
      return {
        allowed: false,
        reason: `Object describe not available for '${objectApiName}'. Cannot verify CRUD permissions.`,
        deniedFields: [],
      };
    }

    const allowed = this.isOperationAllowed(describe, operation);
    if (!allowed) {
      return {
        allowed: false,
        reason: `User lacks '${operation}' permission on '${objectApiName}'.`,
        deniedFields: [],
      };
    }

    return { allowed: true, reason: '', deniedFields: [] };
  }

  /**
   * Check CRUD permission at the object level AND FLS for specific fields.
   * @param objectApiName - Salesforce object API name.
   * @param operation - The DML operation to verify.
   * @param fieldNames - Field API names included in the DML payload.
   * @returns Check result including any fields that fail FLS.
   */
  async checkCrudAndFls(
    objectApiName: string,
    operation: CrudOperation,
    fieldNames: string[],
  ): Promise<CrudFlsCheckResult> {
    const crudResult = await this.checkCrudPermission(objectApiName, operation);
    if (!crudResult.allowed) {
      return crudResult;
    }

    // Delete operations do not require field-level checks
    if (operation === 'delete') {
      return crudResult;
    }

    const describe = await this.fetchDescribe(objectApiName);
    if (!describe) {
      return crudResult;
    }

    const fieldMap = new Map<string, FieldDescribe>();
    for (const field of describe.fields) {
      fieldMap.set(field.name.toLowerCase(), field);
    }

    const deniedFields: string[] = [];
    for (const fieldName of fieldNames) {
      const field = fieldMap.get(fieldName.toLowerCase());
      if (!field) {
        // Unknown field — let Salesforce reject it; not a security concern
        continue;
      }
      if (!this.isFieldAllowed(field, operation)) {
        deniedFields.push(fieldName);
      }
    }

    if (deniedFields.length > 0) {
      return {
        allowed: false,
        reason:
          `FLS violation on '${objectApiName}': fields [${deniedFields.join(', ')}] ` +
          `are not ${operation === 'insert' ? 'createable' : 'updateable'}.`,
        deniedFields,
      };
    }

    return { allowed: true, reason: '', deniedFields: [] };
  }

  /**
   * Split a payload's fields into the ones this org can write and the rest.
   *
   * `checkCrudAndFls` answers "may the user write ALL of these?", which is the
   * right question for a payload the user composed. It is the wrong question
   * for a restore: a backup is a verbatim `SELECT FIELDS(ALL)` snapshot, so it
   * always carries CreatedDate, SystemModstamp, formulas, roll-ups and compound
   * fields — none of them writable by anyone. Asking the all-or-nothing question
   * about that payload made every single restore fail, and the first
   * fix for it hard-coded ten field names, which misses every formula and
   * compound field the same way.
   *
   * The describe already knows. Callers strip `skipped` from the payload and
   * are expected to REPORT it: a restore that quietly drops fields is a
   * different lie from the one this replaces.
   *
   * @param objectApiName - Salesforce object API name.
   * @param operation - The DML operation to verify.
   * @param fieldNames - Field API names present in the payload.
   * @returns Writable field names, and the ones to strip. Unknown fields stay
   *   in `writable`: Salesforce rejects them itself, and that is not a
   *   permission decision to make locally.
   */
  async partitionWritableFields(
    objectApiName: string,
    operation: CrudOperation,
    fieldNames: string[],
  ): Promise<{ writable: string[]; skipped: string[]; denied: string[] }> {
    const describe = await this.fetchDescribe(objectApiName);
    if (!describe) {
      return { writable: [...fieldNames], skipped: [], denied: [] };
    }

    const fieldMap = new Map<string, FieldDescribe>();
    for (const field of describe.fields) {
      fieldMap.set(field.name.toLowerCase(), field);
    }

    const writable: string[] = [];
    const skipped: string[] = [];
    const denied: string[] = [];
    for (const fieldName of fieldNames) {
      const field = fieldMap.get(fieldName.toLowerCase());
      if (!field || this.isFieldAllowed(field, operation)) {
        writable.push(fieldName);
      } else if (this.isStructurallyReadOnly(field)) {
        skipped.push(fieldName);
      } else {
        denied.push(fieldName);
      }
    }
    return { writable, skipped, denied };
  }

  /**
   * Is this field read-only for everyone, rather than for this user?
   *
   * `createable`/`updateable` collapse both cases into one false, which is why
   * the first fix for the restore failure reached for a list of field names. The describe
   * does carry the distinction, in four independent shapes:
   *
   * - not `permissionable` — FLS cannot be set on it at all, which is what
   *   audit fields (CreatedDate, SystemModstamp, IsDeleted) look like;
   * - `calculated` — a formula or roll-up, computed on read;
   * - `autoNumber` — assigned by Salesforce;
   * - `address` / `location` — compound fields, written through their parts.
   *
   * Anything else that is unwritable is a business field this org may not
   * write, and callers are expected to refuse rather than drop it.
   */
  private isStructurallyReadOnly(field: FieldDescribe): boolean {
    return (
      field.permissionable === false ||
      field.calculated ||
      field.autoNumber ||
      field.type === 'address' ||
      field.type === 'location'
    );
  }

  /** Check object-level CRUD permission from the describe metadata. */
  private isOperationAllowed(describe: ObjectDescribe, operation: CrudOperation): boolean {
    switch (operation) {
      case 'insert':
        return describe.createable;
      case 'update':
        return describe.updateable;
      case 'upsert':
        return describe.createable && describe.updateable;
      case 'delete':
        return describe.deletable;
    }
  }

  /** Check field-level security for a single field and operation. */
  private isFieldAllowed(field: FieldDescribe, operation: CrudOperation): boolean {
    switch (operation) {
      case 'insert':
        return field.createable;
      case 'update':
        return field.updateable;
      case 'upsert':
        return field.createable || field.updateable;
      case 'delete':
        return true;
    }
  }
}
