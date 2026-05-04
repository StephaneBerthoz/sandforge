/**
 * Plan 03-04 — Drift v2 canonicalization helpers (P-03.2 mitigation).
 *
 * # Why this module exists
 *
 * Salesforce describe responses are NOT stable shapes:
 *   - `lastModifiedDate`, `lastModifiedById`, `systemModstamp`, `urls`,
 *     `attributes` tick on every Setup save, even when nothing semantically
 *     changed.
 *   - Field arrays inside Profile / PermissionSet (`fieldPermissions`,
 *     `objectPermissions`) come back in *unspecified* order, so a naive deep
 *     diff would flag every fetch as drift.
 *   - CustomField describes carry dozens of internal flags (`compoundFieldName`,
 *     `digits`, `htmlFormatted`, …) we don't care about for drift detection.
 *
 * The functions in this file produce a canonical, allowlisted projection of
 * each shape so `microdiff` only sees fields that semantically matter and in
 * a deterministic order. The output of `canonicalize*` is what gets diffed —
 * NOT the raw describe.
 *
 * # Pure-function contract
 *
 * Every export is a pure function with no I/O, no logger, no global state.
 * Callers (`DriftDetector`) own all side effects.
 */

/** Allowlist of comparison fields per metadata type (P-03.2). */
export const FIELD_ALLOWLIST: Record<string, readonly string[]> = {
  CustomField: [
    'type',
    'length',
    'picklistValues',
    'required',
    'externalId',
    'unique',
    'referenceTo',
  ],
  PermissionSet: ['fieldPermissions', 'objectPermissions'],
  Profile: ['fieldPermissions', 'objectPermissions'],
};

/** Fields that change on every fetch — always strip before diffing. */
export const NOISE_FIELDS: ReadonlySet<string> = new Set([
  'lastModifiedDate',
  'lastModifiedById',
  'systemModstamp',
  'urls',
  'attributes',
]);

/** Shape of one entry inside a CustomField's `picklistValues` array. */
interface PicklistValueLike {
  value?: unknown;
  [key: string]: unknown;
}

/** Shape of one entry inside `fieldPermissions`. */
interface FieldPermissionLike {
  field?: unknown;
  [key: string]: unknown;
}

/** Shape of one entry inside `objectPermissions`. */
interface ObjectPermissionLike {
  object?: unknown;
  [key: string]: unknown;
}

/**
 * Project a CustomField describe down to the allowlisted comparison surface.
 *
 *   - Strips every key that isn't in `FIELD_ALLOWLIST.CustomField` —
 *     guarantees noise fields like `lastModifiedDate` cannot leak into the
 *     diff.
 *   - Sorts `picklistValues` by `value` alphabetically so unstable ordering
 *     between two fetches does not produce a spurious `picklist-changed`
 *     entry.
 *
 * Returns `raw` verbatim if it is `null` or `undefined` (lets callers chain).
 */
export function canonicalizeField<T extends Record<string, unknown>>(
  raw: T | null | undefined,
): Partial<T> | null | undefined {
  if (raw === null || raw === undefined) {
    return raw;
  }
  const out: Record<string, unknown> = {};
  for (const key of FIELD_ALLOWLIST.CustomField) {
    if (key in raw) {
      out[key] = raw[key];
    }
  }
  // Sort picklist values by `value` for stable diff.
  if (Array.isArray(out.picklistValues)) {
    out.picklistValues = [...(out.picklistValues as PicklistValueLike[])].sort(
      (a, b) => String(a.value ?? '').localeCompare(String(b.value ?? '')),
    );
  }
  return out as Partial<T>;
}

/**
 * Project a PermissionSet / Profile describe down to its sorted permission
 * arrays.
 *
 *   - Sorts `fieldPermissions` by `field` (the `Object.Field` API name).
 *   - Sorts `objectPermissions` by `object` (the object API name).
 *
 * Returns `raw` verbatim if it is `null` or `undefined`.
 */
export function canonicalizePermissionSet<T extends Record<string, unknown>>(
  raw: T | null | undefined,
): { fieldPermissions?: FieldPermissionLike[]; objectPermissions?: ObjectPermissionLike[] } | null | undefined {
  if (raw === null || raw === undefined) {
    return raw;
  }
  const out: { fieldPermissions?: FieldPermissionLike[]; objectPermissions?: ObjectPermissionLike[] } = {};
  if (Array.isArray(raw.fieldPermissions)) {
    out.fieldPermissions = [...(raw.fieldPermissions as FieldPermissionLike[])].sort(
      (a, b) => String(a.field ?? '').localeCompare(String(b.field ?? '')),
    );
  }
  if (Array.isArray(raw.objectPermissions)) {
    out.objectPermissions = [...(raw.objectPermissions as ObjectPermissionLike[])].sort(
      (a, b) => String(a.object ?? '').localeCompare(String(b.object ?? '')),
    );
  }
  return out;
}

/**
 * Strip every key in {@link NOISE_FIELDS} from a record. Returns a new object
 * (input is not mutated). Useful when callers want noise removal without
 * also doing the allowlist projection done by {@link canonicalizeField}.
 */
export function stripNoiseFields<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!NOISE_FIELDS.has(k)) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}
