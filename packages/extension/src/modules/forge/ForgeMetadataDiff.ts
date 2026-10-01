/**
 * ForgeMetadataDiff compares source and target org schemas for field-level compatibility.
 * Identifies missing fields, type mismatches, and permission issues before execution.
 */

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Field descriptor returned by org metadata describe. */
export interface DescribedField {
  /** Field API name. */
  name: string;
  /** Salesforce field type. */
  type: string;
  /** Whether the field is createable (can be set on insert). */
  createable: boolean;
}

/** Dependencies for ForgeMetadataDiff. */
export interface MetadataDiffDeps {
  /** Describe an object's fields in a given org. */
  describeObject: (orgId: string, objectApiName: string) => Promise<{ fields: DescribedField[] }>;
}

/** A single metadata diff entry. */
export interface MetadataDiffEntry {
  /** Object API name. */
  objectApiName: string;
  /** Field API name; empty for an entry about the object as a whole. */
  fieldApiName: string;
  /**
   * Type of issue. `object_missing`: the target has no such object, or the
   * running user cannot see it. `unreadable`: an org could not describe it.
   */
  issue: 'missing' | 'type_mismatch' | 'permission_denied' | 'object_missing' | 'unreadable';
  /** Severity level. */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable description. */
  details: string;
}

/**
 * Compares source and target org schemas for field-level compatibility.
 */
export class ForgeMetadataDiff {
  private readonly deps: MetadataDiffDeps;

  constructor(deps: MetadataDiffDeps) {
    this.deps = deps;
  }

  /**
   * Compare schemas for a list of objects between source and target orgs.
   *
   * @param sourceOrgId - Source Salesforce org identifier.
   * @param targetOrgId - Target Salesforce org identifier.
   * @param objectApiNames - Objects to compare.
   * @returns Array of diff entries describing incompatibilities.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string,
    objectApiNames: string[],
  ): Promise<MetadataDiffEntry[]> {
    const diffs: MetadataDiffEntry[] = [];

    for (const objectApiName of objectApiNames) {
      // Each object on its own: one the target lacks is what the comparison
      // is for. Described together and left to throw, the target's NOT_FOUND
      // on a single object failed the whole comparison, run for real, and the
      // Review tab showed an error in place of every other object's result.
      const [source, target] = await Promise.allSettled([
        this.deps.describeObject(sourceOrgId, objectApiName),
        this.deps.describeObject(targetOrgId, objectApiName),
      ]);
      if (target.status === 'rejected' && isNotFound(target.reason)) {
        diffs.push({
          objectApiName,
          fieldApiName: '',
          issue: 'object_missing',
          severity: 'error',
          details: `${objectApiName} does not exist in the target org, or the running user cannot see it: its records cannot be written there`,
        });
        continue;
      }
      const failed =
        source.status === 'rejected'
          ? { org: 'source', reason: source.reason as unknown }
          : target.status === 'rejected'
            ? { org: 'target', reason: target.reason as unknown }
            : undefined;
      if (failed || source.status === 'rejected' || target.status === 'rejected') {
        diffs.push({
          objectApiName,
          fieldApiName: '',
          issue: 'unreadable',
          severity: 'warning',
          details: `${objectApiName} could not be compared: the ${failed?.org ?? 'target'} org did not describe it (${extractErrorMessage(failed?.reason)})`,
        });
        continue;
      }
      const sourceDesc = source.value;
      const targetDesc = target.value;

      const targetFieldMap = new Map(targetDesc.fields.map((f) => [f.name, f]));

      for (const sourceField of sourceDesc.fields) {
        const targetField = targetFieldMap.get(sourceField.name);

        if (!targetField) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'missing',
            severity: 'error',
            details: `Field ${sourceField.name} exists in source but not in target`,
          });
          continue;
        }

        if (sourceField.type !== targetField.type) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'type_mismatch',
            severity: 'warning',
            details: `Field ${sourceField.name} type differs: source=${sourceField.type}, target=${targetField.type}`,
          });
        }

        if (sourceField.createable && !targetField.createable) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'permission_denied',
            severity: 'warning',
            details: `Field ${sourceField.name} is createable in source but not in target`,
          });
        }
      }
    }

    return diffs;
  }
}

/**
 * Whether a describe failed because the org has no such object for the user
 * who asks: jsforce puts the API's `errorCode` on both `errorCode` and `name`
 * (see `extractErrorMessage`). A clone tells by it an object the target lacks,
 * which it cannot write, from a describe that failed for another reason.
 */
export function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { errorCode, name } = err as { errorCode?: unknown; name?: unknown };
  return errorCode === 'NOT_FOUND' || name === 'NOT_FOUND';
}
