/**
 * Counting contract (spec §7): written by the loader into the sas at load
 * time, consumed by the PostLoadVerifier. Per object, the expected count
 * is « files minus exclusions » — dataset records considered for load,
 * minus every listed exclusion (duplicate skips, DML failures). Reused
 * reference records stay in the expected count: they ARE in the org.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SasPathGuard } from './SasPathGuard.js';

/** File name of the counting contract inside the sas directory. */
export const COUNTING_CONTRACT_FILENAME = 'counting-contract.json';

/** Per-object entry of the counting contract. */
export interface CountingContractEntry {
  /** Records considered for load (dataset files, pilot scope applied). */
  fromFiles: number;
  /** Records NOT loaded, by listed reason (e.g. `duplicate-skipped`, `dml-failed`). */
  exclusionReasons: Record<string, number>;
  /** Total excluded records (sum of exclusionReasons). */
  excluded: number;
  /** Records added beyond the dataset (technical placeholders, spec pitfall 3). */
  added: number;
  /** Expected record count in the org: fromFiles − excluded + added. */
  expected: number;
}

/** The counting contract consumed by the PostLoadVerifier. */
export interface CountingContract {
  version: 1;
  orgId: string;
  datasetVersion: string;
  writtenAt: string;
  objects: Record<string, CountingContractEntry>;
}

/** Absolute path of the contract file inside `sasDir` (repo-containment checked). */
export function countingContractPath(guard: SasPathGuard, sasDir: string): string {
  return guard.assertOutsideRepo(path.join(sasDir, COUNTING_CONTRACT_FILENAME));
}

/** Persist the counting contract in the sas. */
export function writeCountingContract(
  guard: SasPathGuard,
  sasDir: string,
  contract: CountingContract,
): string {
  const filePath = countingContractPath(guard, sasDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return filePath;
}

/** Read a counting contract previously written by the loader. */
export function readCountingContract(guard: SasPathGuard, contractPath: string): CountingContract {
  const validated = guard.assertOutsideRepo(contractPath);
  const payload = JSON.parse(fs.readFileSync(validated, 'utf8')) as CountingContract;
  if (payload.version !== 1 || typeof payload.objects !== 'object' || payload.objects === null) {
    throw new Error(`Invalid counting contract at ${validated}: version 1 with objects expected`);
  }
  return payload;
}
