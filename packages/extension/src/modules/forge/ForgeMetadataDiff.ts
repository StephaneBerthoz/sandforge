/**
 * ForgeMetadataDiff compares source and target org schemas for field-level compatibility.
 * Identifies missing fields, type mismatches, and permission issues before execution.
 */

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { noUserCreates, type NotCreatableBy } from './targetCreators.js';

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
  /**
   * Describe an object's fields in a given org, and whether the user the
   * connection runs as may create its records there (absent when the org
   * does not say).
   */
  describeObject: (
    orgId: string,
    objectApiName: string,
  ) => Promise<{ fields: DescribedField[]; createable?: boolean }>;
  /**
   * Why the user may not create each of the objects named in an org
   * (`notCreatableBy`), asked once for every object whose target describe
   * says so. Without it, or unanswered, each is said one the user may not
   * create, with the grant that would open it.
   */
  whyNotCreatable?: (
    orgId: string,
    objectApiNames: readonly string[],
  ) => Promise<ReadonlyMap<string, NotCreatableBy>>;
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
   * `object_not_createable`: the target has it, and the running user may not
   * create its records there.
   */
  issue:
    | 'missing'
    | 'type_mismatch'
    | 'permission_denied'
    | 'object_missing'
    | 'unreadable'
    | 'object_not_createable';
  /** Severity level. */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable description. */
  details: string;
  /**
   * Of `object_not_createable`, who may create its records, as the target
   * said: what the tab asks of the target's admin, or that no one can.
   */
  notCreatableBy?: NotCreatableBy;
}

/** What an object the user may not create is said to be, by who may create it. */
const NOT_CREATABLE_DETAILS: Readonly<Record<NotCreatableBy, (object: string) => string>> = {
  platform: (object) =>
    `${object} is in the target org, but no user can create its records there, the platform writes them itself: Execute skips it`,
  setup: (object) =>
    `${object} is in the target org, but no user can create its records there, not even one with Modify All Data: Execute skips it`,
  feature: (object) =>
    `${object} is in the target org, but even a user with Modify All Data may not create its records there: a feature or licence the target has not turned on keeps it closed, and Execute skips it`,
  parent: (object) =>
    `${object} is in the target org, but the user the clone writes as may not create its records there, and no permission set gives Create on it: Edit on the records it hangs from may, or no user can. Execute skips it`,
  user: (object) =>
    `${object} is in the target org, but the user the clone writes as may not create its records there: Execute skips it`,
};

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
    /** Where the entries of the objects the target user may not create are. */
    const closed: number[] = [];

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
      // One entry for the object, in place of one per field: the tab listed
      // each field "createable in source but not in target", in English, and
      // nothing said Execute would skip the object, after its parents.
      if (targetDesc.createable === false) {
        closed.push(diffs.length);
        diffs.push({
          objectApiName,
          fieldApiName: '',
          issue: 'object_not_createable',
          severity: 'error',
          details: `${objectApiName} is in the target org, but the user the clone writes as may not create its records there: Execute skips it`,
        });
        continue;
      }

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

    await this.sayWhoMayCreate(targetOrgId, diffs, closed);
    return diffs;
  }

  /**
   * The entries at `closed`, each said by who may create its object, as the
   * target says it: once for all of them. One no user can create is an info,
   * and none asks a grant no permission set gives.
   */
  private async sayWhoMayCreate(
    targetOrgId: string,
    diffs: MetadataDiffEntry[],
    closed: readonly number[],
  ): Promise<void> {
    const ask = this.deps.whyNotCreatable;
    if (!ask || closed.length === 0) return;
    let answered: ReadonlyMap<string, NotCreatableBy>;
    try {
      answered = await ask(
        targetOrgId,
        closed.map((at) => diffs[at].objectApiName),
      );
    } catch {
      return;
    }
    for (const at of closed) {
      const { objectApiName } = diffs[at];
      const by = answered.get(objectApiName);
      if (by === undefined) continue;
      diffs[at] = {
        ...diffs[at],
        severity: noUserCreates(by) ? 'info' : 'error',
        details: NOT_CREATABLE_DETAILS[by](objectApiName),
        notCreatableBy: by,
      };
    }
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
