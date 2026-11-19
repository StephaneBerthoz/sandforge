/**
 * Which relationships of an object a rewind deletes many records of
 * something in the org points through: what its removal asks first, once,
 * past one read of the object's records (`ForgeRunRemoval.anyPointing`), and
 * reads for each 200 records only of those that answer one. Asked by the
 * preview in the same words, a query of one row each, and kept in its folder
 * for the rewind's own gate, which prices the reads of its removal from it
 * (`ObjectRelationships.pointing`).
 *
 * Run for real (gate G-Z03, 19/11), a rewind of 1,000 contacts limited to
 * Contact, on an org whose contacts held nothing but the relation the
 * platform writes with each, was estimated 173 requests and sent 84: every
 * relationship the check reads was priced for each 200 contacts, where the
 * removal read the relation alone.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import type { CompositeReader } from './compositeQueries.js';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from './OrgCheckpointStore.js';
import { readStreams } from './orgStreams.js';

/** The file of a preview's folder that keeps, per object, the relationships something points through. */
const POINTING_FILE = 'dependents-pointing.json';

const pointingSchema = z.record(z.string(), z.number().int().nonnegative());

/** The number of a deletion's records past which its removal asks each relationship first. */
export const ASKED_FIRST_PAST = RECORDS_PER_CALL;

/**
 * How many of `relationships` something in the org points through, asked as
 * the removal asks: `SELECT Id FROM <child> WHERE <field> != null LIMIT 1`.
 * One the org would not answer counts as pointing, as the removal reads it.
 */
export async function pointingCount(
  reader: CompositeReader,
  relationships: ReadonlyArray<{ childSObject: string; field: string }>,
  signal?: AbortSignal,
): Promise<number> {
  if (relationships.length === 0) return 0;
  const found = new Array<boolean>(relationships.length).fill(false);
  const outcomes = await readStreams(
    reader,
    relationships.map(({ childSObject, field }) => {
      const child = assertSoqlIdentifier(childSObject);
      return {
        objectApiName: child,
        soql: `SELECT Id FROM ${child} WHERE ${assertSoqlIdentifier(field)} != null LIMIT 1`,
        scanAll: false,
      };
    }),
    (index, rows) => {
      if (rows.length > 0) found[index] = true;
    },
    signal,
    { oneRow: true },
  );
  return outcomes.filter((outcome, at) => !outcome.read || found[at]).length;
}

/** Keep, in a preview's folder, the relationships something points through, per object. */
export async function keepPointing(
  previewDir: string,
  pointing: ReadonlyMap<string, number>,
): Promise<void> {
  if (pointing.size === 0) return;
  await makePrivateDir(previewDir);
  await writeFile(join(previewDir, POINTING_FILE), JSON.stringify(Object.fromEntries(pointing)), {
    encoding: 'utf8',
    mode: CHECKPOINT_FILE_MODE,
  });
}

/** What a preview kept ({@link keepPointing}): none for one that asked nothing, or made before it asked. */
export async function keptPointing(previewDir: string): Promise<ReadonlyMap<string, number>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(previewDir, POINTING_FILE), 'utf8'));
  } catch {
    return new Map();
  }
  const parsed = pointingSchema.safeParse(raw);
  return parsed.success ? new Map(Object.entries(parsed.data)) : new Map();
}
