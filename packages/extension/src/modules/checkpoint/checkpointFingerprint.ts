/**
 * What an object's fields looked like when a checkpoint was taken, kept as
 * hashes, so that a later describe says which of them changed since.
 *
 * A rewind writes a checkpoint's values back into the fields they came from.
 * A field deleted since is no longer there to take one, a field added since
 * holds values the checkpoint never saw, and a field whose type, writability
 * or targets changed may refuse the value it held. Each is said before a
 * rewind writes, by name, from these prints: one hash per object, equal when
 * nothing changed, and one per field, to tell which.
 */

import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { CheckpointField } from './checkpointFields.js';

/** What a field's print is made of: what a write of its value back depends on. */
export type FingerprintField = Pick<
  CheckpointField,
  'name' | 'type' | 'createable' | 'updateable' | 'nillable' | 'referenceTo' | 'encrypted'
>;

/** The hex characters of a field's print: enough to tell one field's two shapes apart. */
const FIELD_PRINT_LENGTH = 16;

/** An object's fields, as a checkpoint keeps them to compare with a later describe. */
export interface ObjectFingerprint {
  /** One hash of every field: the checkpoint's `fingerprint` of the object. */
  digest: string;
  /** Per field, by its name, the hash of what its print is made of. */
  fields: Record<string, string>;
}

/** {@link ObjectFingerprint} as it is read back from disk, checked. */
export const objectFingerprintSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  fields: z.record(z.string(), z.string().regex(new RegExp(`^[0-9a-f]{${FIELD_PRINT_LENGTH}}$`))),
});

/** The hex sha256 of `text`. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * One field as its print reads it. Its name whatever its case, as Salesforce
 * matches one; an absent flag as false; and the objects a lookup may point at
 * in name order: the describe lists them in no order it promises.
 */
function lineOf(field: FingerprintField): string {
  return JSON.stringify([
    field.name.toLowerCase(),
    field.type,
    field.createable === true,
    field.updateable === true,
    field.nillable === true,
    [...(field.referenceTo ?? [])].sort(),
    field.encrypted === true,
  ]);
}

/**
 * The prints of an object's fields, as its describe lists them: each field's
 * name, type, whether the user may create and edit it, whether it may be
 * empty, the objects it may point at, and whether Shield encrypts it.
 *
 * In name order, so that the same fields listed in another order print the
 * same.
 */
export function fingerprintOf(fields: readonly FingerprintField[]): ObjectFingerprint {
  const lines = fields
    .map((field) => ({ name: field.name, key: field.name.toLowerCase(), line: lineOf(field) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    digest: sha256(lines.map(({ line }) => line).join('\n')),
    fields: Object.fromEntries(
      lines.map(({ name, line }) => [name, sha256(line).slice(0, FIELD_PRINT_LENGTH)]),
    ),
  };
}

/** How an object's fields changed between two prints of it. */
export interface SchemaDrift {
  /** Fields the later describe lists and the earlier did not. */
  added: string[];
  /** Fields the earlier describe listed and the later does not. */
  removed: string[];
  /** Fields both list whose print changed. */
  changed: string[];
}

/**
 * The fields added, removed and changed between `then` and `now`, each in
 * name order. A field is the same field whatever the case of its name, as
 * Salesforce matches one.
 */
export function schemaDrift(then: ObjectFingerprint, now: ObjectFingerprint): SchemaDrift {
  const drift: SchemaDrift = { added: [], removed: [], changed: [] };
  if (then.digest === now.digest) return drift;
  const before = new Map(
    Object.entries(then.fields).map(([name, print]) => [name.toLowerCase(), { name, print }]),
  );
  const after = new Map(
    Object.entries(now.fields).map(([name, print]) => [name.toLowerCase(), { name, print }]),
  );
  for (const [key, { name, print }] of after) {
    const earlier = before.get(key);
    if (earlier === undefined) drift.added.push(name);
    else if (earlier.print !== print) drift.changed.push(name);
  }
  for (const [key, { name }] of before) {
    if (!after.has(key)) drift.removed.push(name);
  }
  drift.added.sort();
  drift.removed.sort();
  drift.changed.sort();
  return drift;
}
