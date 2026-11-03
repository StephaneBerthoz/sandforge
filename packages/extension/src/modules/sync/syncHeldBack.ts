/**
 * The rows a Sync run holds back because a lookup of theirs names a record of
 * an object the target takes none of, counted before its first write.
 *
 * The gate counts each object's rows under its filter before it reads one
 * (`SELECT COUNT()`), so the rows a run left out of an object would hold back
 * in the objects after it were counted as rows to write. Run against a real
 * target, a run whose account upsert matched on a field the target does not
 * match an upsert on said "4 record(s) to write … Contact 4", and its dry run
 * said 0 contacts written and 4 held back: written without the account their
 * `AccountId` names, the contacts would stand without it (`PARENT_REFUSED`).
 *
 * The run notes every record of such an object it sets out to create as
 * refused, and holds back each row whose lookup names one, and the rows under
 * those in turn. Here the same is read before the gate: the records of each
 * object left out, then those of every object whose write carries a lookup
 * at one of them, through the run's own read of the source, and each row is
 * told apart as the run tells it (`SyncRunLinks`): a record an earlier run of
 * a saved configuration copied stands in for its source, and the row naming
 * it goes, with the copy.
 */
import type { SyncObjectConfig } from '@sandforge/shared';
import { SyncRunLinks } from './syncRowPreparation.js';
import type { WriteLookup } from './syncWriteOrder.js';

/** An object of a run whose rows the run would hold back, and why. */
export interface SyncHeldBackObject {
  objectApiName: string;
  /** Its rows a lookup of which names a record the run leaves out or holds back. */
  rows: number;
  /** The object of the records the first such lookup names, and that lookup. */
  parent: string;
  field: string;
}

/** A Salesforce id, as a lookup holds one. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An API name as Salesforce matches one, whatever its case. */
const nameKey = (name: string): string => name.toLowerCase();

/** Whether an object's write sets out to create records: an insert, or an upsert. */
function creates(operation: SyncObjectConfig['operation']): boolean {
  return operation === 'insert' || operation === 'upsert';
}

/**
 * The field of the source record a write sends as `targetField`, a lookup of
 * the target: the field a direct or rename mapping takes there, or the field
 * of that name, sent as read. Undefined where the write sends no source id in
 * it — a value the configuration sets (an add-on, a constant, a formula), or
 * one a rule changes — which no refusal of this run reaches.
 */
export function sourceFieldOf(
  objectConfig: Pick<SyncObjectConfig, 'fieldMappings' | 'addOnFields' | 'transformRules'>,
  targetField: string,
): string | undefined {
  const key = nameKey(targetField);
  if (objectConfig.addOnFields.some((addOn) => nameKey(addOn.fieldApiName) === key)) {
    return undefined;
  }
  if (objectConfig.transformRules.some((rule) => rule.field && nameKey(rule.field) === key)) {
    return undefined;
  }
  const mapping = objectConfig.fieldMappings.find(
    (candidate) => candidate.type !== 'exclude' && nameKey(candidate.targetField) === key,
  );
  if (!mapping) return targetField;
  return (mapping.type === 'direct' || mapping.type === 'rename') &&
    (mapping.transformRules ?? []).length === 0
    ? mapping.sourceField
    : undefined;
}

/** What {@link heldBackOf} reads. */
export interface HeldBackInput {
  /** The run's objects, in the order it writes them. */
  ordered: readonly SyncObjectConfig[];
  /** Per object, the lookups its write carries (`lookupsOf`). */
  lookups: ReadonlyMap<string, readonly WriteLookup[]>;
  /** The objects the target takes none of, by API name, left out of the run as it writes. */
  leftOut: ReadonlySet<string>;
  /** What earlier runs of the configuration wrote, by the first fifteen characters of each source id. */
  earlier?: ReadonlyMap<string, string>;
  /**
   * Per object an insert writes, the source records an earlier run copied,
   * by the first fifteen characters of their id: left as they are, neither
   * written nor held back.
   */
  copied?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The records an object's read returns, as the run reads them. */
  read: (objectConfig: SyncObjectConfig) => Promise<Record<string, unknown>[]>;
}

/**
 * The rows of each object the run would hold back for a record of an object
 * left out, or for a row it holds back in turn, by object: what its gate
 * counts apart from the rows it writes. An object left out that creates
 * nothing — an update, a delete — names records the target holds, and holds
 * nothing back. Nothing is read when no object of the run carries a lookup
 * at one left out.
 */
export async function heldBackOf(input: HeldBackInput): Promise<Map<string, SyncHeldBackObject>> {
  const held = new Map<string, SyncHeldBackObject>();
  const links = new SyncRunLinks(input.earlier);
  /** The objects some of whose records the run would refuse, by {@link nameKey}. */
  const refusing = new Set<string>();
  const leftOut = new Set([...input.leftOut].map(nameKey));
  for (const objectConfig of input.ordered) {
    const name = objectConfig.objectApiName;
    if (leftOut.has(nameKey(name))) {
      if (!creates(objectConfig.operation)) continue;
      // Every record its read returns is noted refused, as the run notes it.
      for (const record of await input.read(objectConfig)) {
        const id = record['Id'];
        if (typeof id === 'string' && id !== '') links.noteRefused(id, name);
      }
      refusing.add(nameKey(name));
      continue;
    }
    if (objectConfig.operation === 'delete') continue;
    const carried = (input.lookups.get(name) ?? []).flatMap(({ field, referenceTo }) => {
      const parents = referenceTo.filter(
        (parent) => nameKey(parent) !== nameKey(name) && refusing.has(nameKey(parent)),
      );
      const source = parents.length > 0 ? sourceFieldOf(objectConfig, field) : undefined;
      return source !== undefined ? [{ field, source }] : [];
    });
    if (carried.length === 0) continue;
    let rows = 0;
    let first: { parent: string; field: string } | undefined;
    const copied = input.copied?.get(name);
    for (const record of await input.read(objectConfig)) {
      const id = record['Id'];
      if (copied && typeof id === 'string' && copied.has(id.slice(0, 15))) continue;
      const at = carried.find(({ source }) => {
        const value = record[source];
        return (
          typeof value === 'string' &&
          RECORD_ID.test(value) &&
          links.refusedObjectOf(value) !== undefined
        );
      });
      if (!at) continue;
      rows++;
      const parent = links.refusedObjectOf(record[at.source] as string) ?? '';
      first ??= { parent, field: at.field };
      // A row held back is refused too, for the objects after it.
      if (creates(objectConfig.operation) && typeof id === 'string' && id !== '') {
        links.noteRefused(id, name);
      }
    }
    if (rows > 0 && first) {
      held.set(name, { objectApiName: name, rows, ...first });
      if (creates(objectConfig.operation)) refusing.add(nameKey(name));
    }
  }
  return held;
}
