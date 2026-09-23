/**
 * An object's lookups as a describe gives them: what each may point at, and
 * whether a create or an update may set it.
 *
 * A writer reads them from the describe it already holds for the fields it
 * may send, never from one more. The panel and the command line read the
 * same describe the same way through this, so a run decides alike from
 * either: which lookup is left to the target's default, what a cycle writes
 * first, and what a second pass may fill.
 */

import { z } from 'zod';

/** One lookup of an object, as the describe reports it. */
export interface DescribedLookup {
  /** Field API name. */
  name: string;
  /** Every object it may point at. */
  referenceTo: readonly string[];
  /** Whether a create may set it. */
  createable: boolean;
  /** Whether an update may set it. */
  updateable: boolean;
}

/** One entry of a describe's `fields`: external input, checked before it is read. */
const lookupFieldSchema = z
  .object({
    name: z.string().min(1),
    referenceTo: z.array(z.string()).min(1),
    createable: z.boolean().optional(),
    updateable: z.boolean().optional(),
  })
  .passthrough();

/**
 * The lookups among a describe's fields. A field that points at nothing, or
 * that is not the shape a describe gives, is left out; anything that is not
 * a list reads as no lookup at all. A flag the describe leaves out reads as
 * `false`: a field it does not say may be set is not set.
 *
 * @param fields - `fields` of a describe, as the org returned it.
 */
export function describedLookups(fields: unknown): DescribedLookup[] {
  if (!Array.isArray(fields)) return [];
  const lookups: DescribedLookup[] = [];
  for (const field of fields) {
    const parsed = lookupFieldSchema.safeParse(field);
    if (!parsed.success) continue;
    lookups.push({
      name: parsed.data.name,
      referenceTo: parsed.data.referenceTo,
      createable: parsed.data.createable ?? false,
      updateable: parsed.data.updateable ?? false,
    });
  }
  return lookups;
}
