/**
 * What a seed reads of an object's describe, each object described once for
 * the run: the fields the org takes on a write, the active values of its
 * picklists, and the fields it refuses a record without. The panel and the
 * command line read them the same way.
 */

import type { DescribedSeedField } from '@sandforge/shared';
import { integerDigitsOf } from '@sandforge/shared';

/** One field of an object's describe, the part a seed reads. */
export interface SeedDescribeField {
  name: string;
  type?: string;
  createable?: boolean;
  nillable?: boolean;
  defaultedOnCreate?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  digits?: number;
  referenceTo?: readonly string[] | null;
  picklistValues?: ReadonlyArray<{ value?: string | null; active?: boolean }> | null;
}

/** The part of an object's describe a seed reads. */
export interface SeedDescribe {
  fields: readonly SeedDescribeField[];
}

/** The describe types whose values a pick is kept to. */
const PICKLIST_TYPES: ReadonlySet<string> = new Set(['picklist', 'multipicklist']);

/** The fields a seed reads of each object, from one describe of it. */
export interface DescribedFields {
  /** The fields the org lets a write set. */
  createable(objectApiName: string): Promise<ReadonlySet<string>>;
  /** The active values of each picklist that has any, by field. */
  picklistValues(objectApiName: string): Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * The fields the org refuses a record without and fills none of itself,
   * lookups apart, as the wizard describes a field before giving it a rule.
   */
  required(objectApiName: string): Promise<DescribedSeedField[]>;
}

/** A field's active picklist values. */
function activeValues(field: SeedDescribeField): string[] {
  return (field.picklistValues ?? [])
    .filter((p) => p.active !== false && typeof p.value === 'string' && p.value !== '')
    .map((p) => p.value as string);
}

/**
 * Read each object's fields from one describe, kept for the run. A describe
 * that fails fails each read of it, which the orchestrator takes for "cannot
 * tell" and leaves the object's rules as written.
 */
export function describedFieldsOf(
  describe: (objectApiName: string) => Promise<SeedDescribe>,
): DescribedFields {
  const described = new Map<string, Promise<SeedDescribe>>();
  const describeOnce = (objectApiName: string): Promise<SeedDescribe> => {
    let answer = described.get(objectApiName);
    if (!answer) {
      answer = describe(objectApiName);
      described.set(objectApiName, answer);
    }
    return answer;
  };
  return {
    async createable(objectApiName) {
      const { fields } = await describeOnce(objectApiName);
      return new Set(fields.filter((f) => f.createable === true).map((f) => f.name));
    },
    async picklistValues(objectApiName) {
      const { fields } = await describeOnce(objectApiName);
      const values = new Map<string, readonly string[]>();
      for (const field of fields) {
        if (!PICKLIST_TYPES.has(field.type ?? '')) continue;
        const active = activeValues(field);
        if (active.length > 0) values.set(field.name, active);
      }
      return values;
    },
    async required(objectApiName) {
      const { fields } = await describeOnce(objectApiName);
      return fields
        .filter(
          (f) =>
            f.createable === true &&
            f.nillable === false &&
            f.defaultedOnCreate !== true &&
            (f.referenceTo ?? []).length === 0,
        )
        .map((f) => ({
          fieldApiName: f.name,
          type: f.type ?? 'string',
          picklistValues: activeValues(f),
          referenceTo: [],
          length: f.length ?? 0,
          integerDigits: integerDigitsOf({ ...f, type: f.type ?? 'string' }),
          objectApiName,
          required: true,
        }));
    },
  };
}
