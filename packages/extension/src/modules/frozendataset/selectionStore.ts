/**
 * Persistence of the retained-ID list in the sas: the selection contains
 * source-org record IDs, so it must live outside the repo —
 * versioned, it would form a real↔anonymized correspondence table.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SasPathGuard } from './SasPathGuard.js';
import type { CoverageSelectionResult } from './CoverageMatrixSelector.js';

/** File name of the selection inside the sas directory. */
export const SELECTION_FILE_NAME = 'selection.json';

/** Envelope of the persisted selection file. */
export interface SelectionFile {
  /** Envelope format version. */
  fileVersion: 1;
  selection: CoverageSelectionResult;
}

/**
 * Write the selection result to `<sasDir>/selection.json`. The write is
 * asynchronous: it runs on the extension host, where a synchronous one
 * holds the extension host.
 *
 * @returns The absolute path written.
 */
export async function writeSelectionToSas(
  sasDir: string,
  selection: CoverageSelectionResult,
  guard?: SasPathGuard,
): Promise<string> {
  const effectiveGuard = guard ?? new SasPathGuard();
  const dir = effectiveGuard.assertOutsideRepo(sasDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = effectiveGuard.assertOutsideRepo(path.join(dir, SELECTION_FILE_NAME));
  const envelope: SelectionFile = { fileVersion: 1, selection };
  await fs.writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * Read a persisted selection from the sas. The extraction phase injects
 * these IDs into its queries at execution time: no hard-coded IDs in
 * templates — values come from the sas.
 */
export async function readSelectionFromSas(
  sasDir: string,
  guard?: SasPathGuard,
): Promise<CoverageSelectionResult> {
  const effectiveGuard = guard ?? new SasPathGuard();
  const filePath = effectiveGuard.assertOutsideRepo(path.join(sasDir, SELECTION_FILE_NAME));
  const payload: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload as SelectionFile).fileVersion !== 1 ||
    typeof (payload as SelectionFile).selection !== 'object'
  ) {
    throw new Error(`Invalid selection file at ${filePath} (expected fileVersion 1)`);
  }
  return (payload as SelectionFile).selection;
}
