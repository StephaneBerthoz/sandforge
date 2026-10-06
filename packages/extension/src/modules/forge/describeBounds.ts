/**
 * What a field's describe says of the values it takes, past its type and its
 * length: how many digits a number holds, whether a value has to be unique,
 * whether the field is computed, whether a lookup filter checks it, and, for a
 * dependent picklist, which controlling values allow each of its values.
 *
 * A simulation reads these to find, row by row, what the target would refuse
 * before anything is written (`stages/SimulationGaps.ts`). Projected from the
 * describe the run already holds — the extension's and the command line's
 * alike — never read for themselves.
 */

/** The part of a describe's field these are read from, as jsforce gives it. */
export interface DescribedFieldBounds {
  name: string;
  type?: string;
  precision?: number | null;
  scale?: number | null;
  digits?: number | null;
  unique?: boolean | null;
  calculated?: boolean | null;
  filteredLookupInfo?: unknown;
  controllerName?: string | null;
  picklistValues?: ReadonlyArray<{
    value?: unknown;
    active?: unknown;
    validFor?: unknown;
  } | null> | null;
}

/** What {@link fieldBoundsOf} reads of a field; each absent when the describe says nothing of it. */
export interface FieldBounds {
  /** A number's digits in all, decimals included. */
  precision?: number;
  /** A number's decimals. */
  scale?: number;
  /** An integer's digits. */
  digits?: number;
  /** The target refuses a value another of its records holds. */
  unique?: true;
  /** A formula or a roll-up: no write sets it. */
  calculated?: true;
  /** A lookup filter checks the record it names. */
  filteredLookup?: true;
  /**
   * For a dependent picklist, per active value, the describe's `validFor`:
   * base64 bits, bit n read left to right standing for the controlling
   * field's n-th value (`controllingValues`), or for a checkbox `false` then
   * `true`.
   */
  validFor?: Record<string, string>;
  /**
   * For a picklist another field depends on, every value in the describe's
   * order, the inactive ones too: what the bits of its dependents' `validFor`
   * stand for.
   */
  controllingValues?: string[];
}

/** The fields of a describe other fields depend on: their values are what `validFor` indexes. */
export function controllersOf(
  fields: ReadonlyArray<Pick<DescribedFieldBounds, 'controllerName'>>,
): Set<string> {
  const controllers = new Set<string>();
  for (const field of fields) if (field.controllerName) controllers.add(field.controllerName);
  return controllers;
}

/** A count the describe gives, when it gives a positive one. */
function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The bounds of one field of a describe.
 *
 * @param controllers - The fields of the same describe others depend on
 *   (`controllersOf`): only theirs keep every value.
 */
export function fieldBoundsOf(
  field: DescribedFieldBounds,
  controllers: ReadonlySet<string>,
): FieldBounds {
  const precision = positive(field.precision);
  const scale = typeof field.scale === 'number' && field.scale >= 0 ? field.scale : undefined;
  const digits = positive(field.digits);
  const entries = (field.picklistValues ?? []).filter(
    (p): p is { value: string; active?: unknown; validFor?: unknown } =>
      p !== null && typeof p.value === 'string',
  );
  const validFor: Record<string, string> = {};
  if (field.controllerName) {
    for (const entry of entries) {
      if (entry.active === false || typeof entry.validFor !== 'string') continue;
      validFor[entry.value] = entry.validFor;
    }
  }
  return {
    ...(precision !== undefined ? { precision } : {}),
    ...(precision !== undefined && scale !== undefined ? { scale } : {}),
    ...(digits !== undefined ? { digits } : {}),
    ...(field.unique === true ? { unique: true as const } : {}),
    ...(field.calculated === true ? { calculated: true as const } : {}),
    ...(field.filteredLookupInfo ? { filteredLookup: true as const } : {}),
    ...(Object.keys(validFor).length > 0 ? { validFor } : {}),
    ...(controllers.has(field.name) && entries.length > 0
      ? { controllingValues: entries.map((entry) => entry.value) }
      : {}),
  };
}

/**
 * Whether a dependent value's `validFor` allows the controlling value at
 * `index`: bit `index`, read left to right, of the decoded bytes.
 */
export function allowsControllingValue(validFor: string, index: number): boolean {
  if (index < 0) return false;
  const bytes = Buffer.from(validFor, 'base64');
  const byte = bytes[index >> 3];
  return byte !== undefined && (byte & (0x80 >> (index % 8))) !== 0;
}
