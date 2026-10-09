/**
 * Counting contract: written by the loader into the sas at load time, consumed by the PostLoadVerifier. Per object, the expected count
 * is « files minus exclusions » — dataset records considered for load,
 * minus every listed exclusion (duplicate skips, DML failures). Reused
 * reference records stay in the expected count: they ARE in the org, and so
 * does a record written again without the fields the target refused it on.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SasPathGuard, orgFileKey } from './SasPathGuard.js';

/**
 * File name of the one counting contract a sas kept, whichever org its load
 * went to, before contracts were kept per target org. A load into another
 * org replaced it, and the last load into the first could no longer be
 * verified. A run recorded then names it by its path, which is still read.
 */
export const COUNTING_CONTRACT_FILENAME = 'counting-contract.json';

/** File name of the counting contract of the last load into one registered org. */
export function countingContractFileName(orgId: string): string {
  return `counting-contract.${orgFileKey(orgId)}.json`;
}

/** Per-object entry of the counting contract. */
export interface CountingContractEntry {
  /** Records considered for load (dataset files, pilot scope applied). */
  fromFiles: number;
  /** Records NOT loaded, by listed reason (e.g. `duplicate-skipped`, `dml-failed`). */
  exclusionReasons: Record<string, number>;
  /** Total excluded records (sum of exclusionReasons). */
  excluded: number;
  /** Records added beyond the dataset (technical placeholders). */
  added: number;
  /** Expected record count in the org: fromFiles − excluded + added. */
  expected: number;
  /**
   * Per field, the referenceIds of the records the target refused on it and
   * took once written again without it: loaded, and counted in `expected`, the
   * field left empty on purpose — which the verification does not take for an
   * orphan, or for a key missing from the org. Absent when there were none,
   * and from contracts written before a refused record was written again.
   */
  writtenWithout?: Record<string, string[]>;
}

/** The counting contract consumed by the PostLoadVerifier. */
export interface CountingContract {
  version: 1;
  orgId: string;
  datasetVersion: string;
  writtenAt: string;
  /**
   * When the load that wrote the contract began, as its mapping records it
   * (`RecordedLoad.startedAt`): the load the contract counts. Absent from
   * contracts written before it was recorded.
   */
  loadStartedAt?: string;
  objects: Record<string, CountingContractEntry>;
}

/**
 * Absolute path of the contract of the loads into `orgId` inside `sasDir`
 * (repo-containment checked).
 */
export function countingContractPath(guard: SasPathGuard, sasDir: string, orgId: string): string {
  return guard.assertOutsideRepo(path.join(sasDir, countingContractFileName(orgId)));
}

/** Persist the counting contract in the sas, in the file of the org it counts a load into. */
export function writeCountingContract(
  guard: SasPathGuard,
  sasDir: string,
  contract: CountingContract,
): string {
  const filePath = countingContractPath(guard, sasDir, contract.orgId);
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

/**
 * Whether a contract counts the load a mapping names as its last: the one
 * whose records a verification would count against it.
 *
 * Every load keeps its mapping, one that stopped part way included, and only
 * a load that ended writes a contract: after a cancel, the contract in the sas
 * counted the load before, and a verification judged the stopped load's
 * records by it — the verdict written into the manifest. A contract names its
 * load by when it began, as the mapping does. One written before contracts
 * named their load counts the mapping's when it was written once that load
 * had ended: a load writes its contract right after its mapping, and a load
 * that stopped later wrote a mapping after it.
 *
 * @param load - The last load the mapping names: when it began, when the
 *   mapping says, and when it wrote its last record.
 */
export function contractCountsLoad(
  contract: Pick<CountingContract, 'loadStartedAt' | 'writtenAt'>,
  load: { startedAt?: string; endedAt: string },
): boolean {
  if (contract.loadStartedAt !== undefined) return contract.loadStartedAt === load.startedAt;
  const written = Date.parse(contract.writtenAt);
  const ended = Date.parse(load.endedAt);
  return Number.isFinite(written) && Number.isFinite(ended) && written >= ended;
}
