/**
 * Post-load verifier (spec §7) — READ-ONLY, chained after the load. It
 * consumes the counting contract the loader wrote into the sas and checks:
 *
 *   - **counts**: per-object org counts vs the contract (files minus
 *     exclusions);
 *   - **link integrity**: orphans of the graph's MANDATORY lookups, and
 *     PersonContact pointers restored (sidecar + persisted mapping);
 *   - **presence by key** (ExternalId) for the referential shared with
 *     the org;
 *   - **robustness**: after a heavy DML storm the org can read
 *     transiently inconsistent — measurements repeat until TWO IDENTICAL
 *     snapshots (max 3 attempts, configurable interval); otherwise the
 *     verdict is the explicit `unstable`.
 *
 * The verdict is consigned in the manifest (`controls.dryRunLoad` — the
 * engine-owned extension point — with author and date).
 */

import * as fs from 'node:fs';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { SasPathGuard } from './SasPathGuard.js';
import { readCountingContract, type CountingContract } from './CountingContract.js';
import { parseManifest, serializeManifest } from './manifest.js';
import type { FrozenDataset } from './types.js';
import type { FrozenLoadProgressEvent, TargetOrgAccess } from './loadTypes.js';

/** Default pause between two measurements (ms). */
export const DEFAULT_MEASUREMENT_INTERVAL_MS = 2_000;
/** Hard cap on measurement attempts (spec §7: max 3 relevés). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default orphan sample size per mandatory lookup. */
export const DEFAULT_ORPHAN_SAMPLE_SIZE = 10;

/** One verification check outcome. */
export interface PostLoadCheck {
  name: 'stability' | 'counts' | 'orphans' | 'personcontact' | 'presence';
  passed: boolean;
  detail: string;
}

/** Final post-load verdict. */
export interface PostLoadVerdict {
  status: 'passed' | 'failed' | 'unstable';
  checks: PostLoadCheck[];
  /** Measurements taken (2 identical snapshots stop the loop early). */
  attempts: number;
  measuredAt: string;
  /** Manifest path when the verdict was consigned. */
  manifestPath?: string;
}

/** Dependencies of {@link PostLoadVerifier}. */
export interface PostLoadVerifierDeps {
  orgAccess: Pick<TargetOrgAccess, 'query'>;
  sasGuard?: SasPathGuard;
}

/** Options of one verification run. */
export interface PostLoadVerifyOptions {
  orgId: string;
  /** Sas path of the counting contract written by the loader. */
  contractPath: string;
  /** Frozen dataset — required for the PersonContact and presence checks. */
  dataset?: FrozenDataset;
  /** Persisted referenceId→real-ID mapping (loader's mapping store). */
  mapping?: ReadonlyMap<string, string>;
  /** Mandatory lookups of the graph: `ObjectApiName → [lookupField, ...]`. */
  mandatoryLookups?: Record<string, string[]>;
  /** Presence-by-key check: `ObjectApiName → key field` (e.g. ExternalId). */
  presenceKeys?: Record<string, string>;
  /** Pause between measurements (ms). Default {@link DEFAULT_MEASUREMENT_INTERVAL_MS}. */
  measurementIntervalMs?: number;
  /** Max measurements. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Orphan sample size per mandatory lookup. Default {@link DEFAULT_ORPHAN_SAMPLE_SIZE}. */
  orphanSampleSize?: number;
  /** Manifest to consign the verdict into (`controls.dryRunLoad`). */
  manifestPath?: string;
  /** Author consigned with the verdict. */
  author?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress sink. */
  onProgress?: (event: FrozenLoadProgressEvent) => void;
}

/** One measurement of the org state (JSON-compared across attempts). */
interface VerificationSnapshot {
  counts: Record<string, number>;
  orphans: Record<string, string[]>;
  personContact: { checked: number; unrestored: string[] };
  presence: Record<string, string[]>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PostLoadVerifier {
  private readonly sasGuard: SasPathGuard;

  constructor(private readonly deps: PostLoadVerifierDeps) {
    this.sasGuard = deps.sasGuard ?? new SasPathGuard();
  }

  /** Run the post-load verification and consign the verdict. */
  async verify(options: PostLoadVerifyOptions): Promise<PostLoadVerdict> {
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? defaultSleep;
    const emit = (event: FrozenLoadProgressEvent): void => options.onProgress?.(event);
    const intervalMs = options.measurementIntervalMs ?? DEFAULT_MEASUREMENT_INTERVAL_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const contract = readCountingContract(this.sasGuard, options.contractPath);

    emit({ phase: 'verify', status: 'started', progress: 0, message: 'Measuring org state' });
    // Robustness loop: re-measure until TWO IDENTICAL snapshots (spec §7).
    let previousSerialized: string | null = null;
    let stableSnapshot: VerificationSnapshot | null = null;
    let lastSnapshot: VerificationSnapshot | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      lastSnapshot = await this.measure(options, contract);
      const serialized = stableSerialize(lastSnapshot);
      if (previousSerialized !== null && serialized === previousSerialized) {
        stableSnapshot = lastSnapshot;
        break;
      }
      previousSerialized = serialized;
      if (attempt < maxAttempts) {
        await sleep(intervalMs);
      }
    }

    const checks = this.buildChecks(
      options,
      contract,
      stableSnapshot ?? lastSnapshot,
      stableSnapshot !== null,
    );
    const verdict: PostLoadVerdict = {
      status:
        stableSnapshot === null ? 'unstable' : checks.every((c) => c.passed) ? 'passed' : 'failed',
      checks,
      attempts,
      measuredAt: now().toISOString(),
    };

    if (options.manifestPath) {
      this.consignVerdict(options.manifestPath, verdict, options.author);
      verdict.manifestPath = this.sasGuard.assertOutsideRepo(options.manifestPath);
    }
    emit({
      phase: 'verify',
      status: verdict.status === 'passed' ? 'done' : 'error',
      progress: 100,
      message: `Post-load verification: ${verdict.status} (${attempts} measurement(s))`,
    });
    return verdict;
  }

  /** Take one measurement of the org state. */
  private async measure(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
  ): Promise<VerificationSnapshot> {
    return {
      counts: await this.measureCounts(options, contract),
      orphans: await this.measureOrphans(options),
      personContact: await this.measurePersonContacts(options),
      presence: await this.measurePresence(options),
    };
  }

  /** Per-object counts (`SELECT COUNT(Id)`) for every contract object. */
  private async measureCounts(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const objectApiName of Object.keys(contract.objects).sort()) {
      const soql = `SELECT COUNT(Id) cnt FROM ${assertSoqlIdentifier(objectApiName)}`;
      const rows = await this.deps.orgAccess.query(options.orgId, soql);
      counts[objectApiName] = Number(rows[0]?.cnt ?? 0);
    }
    return counts;
  }

  /** Sampled orphans per mandatory lookup of the graph. */
  private async measureOrphans(options: PostLoadVerifyOptions): Promise<Record<string, string[]>> {
    const orphans: Record<string, string[]> = {};
    const sample = options.orphanSampleSize ?? DEFAULT_ORPHAN_SAMPLE_SIZE;
    for (const [objectApiName, fields] of Object.entries(options.mandatoryLookups ?? {})) {
      for (const field of fields) {
        const soql =
          `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} ` +
          `WHERE ${assertSoqlIdentifier(field)} = null ORDER BY Id LIMIT ${sample}`;
        const rows = await this.deps.orgAccess.query(options.orgId, soql);
        orphans[`${objectApiName}.${field}`] = rows.map((r) => String(r.Id)).sort();
      }
    }
    return orphans;
  }

  /** PersonContact pointers restored on Accounts (sidecar + mapping). */
  private async measurePersonContacts(
    options: PostLoadVerifyOptions,
  ): Promise<VerificationSnapshot['personContact']> {
    const sidecar = options.dataset?.personContactSidecar ?? [];
    if (sidecar.length === 0 || !options.mapping) {
      return { checked: 0, unrestored: [] };
    }
    const resolvable = sidecar.filter(
      (link) =>
        options.mapping?.has(link.accountReferenceId) &&
        options.mapping?.has(link.contactReferenceId),
    );
    if (resolvable.length === 0) {
      return { checked: 0, unrestored: [] };
    }
    const accountIds = resolvable.map(
      (link) => options.mapping?.get(link.accountReferenceId) as string,
    );
    const soql =
      'SELECT Id, PersonContactId FROM Account WHERE Id IN (' +
      accountIds.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ') +
      ')';
    const rows = await this.deps.orgAccess.query(options.orgId, soql);
    const personContactByAccount = new Map(
      rows.map((r) => [
        String(r.Id),
        r.PersonContactId === null || r.PersonContactId === undefined
          ? null
          : String(r.PersonContactId),
      ]),
    );
    const unrestored: string[] = [];
    for (const link of resolvable) {
      const accountId = options.mapping.get(link.accountReferenceId) as string;
      const expectedContactId = options.mapping.get(link.contactReferenceId) as string;
      if (personContactByAccount.get(accountId) !== expectedContactId) {
        unrestored.push(link.accountReferenceId);
      }
    }
    return { checked: resolvable.length, unrestored: unrestored.sort() };
  }

  /** Presence by key (e.g. ExternalId) for the referential shared with the org. */
  private async measurePresence(options: PostLoadVerifyOptions): Promise<Record<string, string[]>> {
    const presence: Record<string, string[]> = {};
    if (!options.dataset) {
      return presence;
    }
    for (const [objectApiName, keyField] of Object.entries(options.presenceKeys ?? {})) {
      const records =
        options.dataset.objects.find((o) => o.objectApiName === objectApiName)?.records ?? [];
      const keys = [
        ...new Set(
          records
            .map((r) => r.fields[keyField])
            .filter((v): v is string => typeof v === 'string' && v !== ''),
        ),
      ].sort();
      if (keys.length === 0) {
        presence[objectApiName] = [];
        continue;
      }
      const soql =
        `SELECT ${assertSoqlIdentifier(keyField)} k FROM ${assertSoqlIdentifier(objectApiName)} ` +
        `WHERE ${assertSoqlIdentifier(keyField)} IN (${keys.map((k) => `'${sanitizeSoqlValue(k)}'`).join(', ')})`;
      const rows = await this.deps.orgAccess.query(options.orgId, soql);
      const found = new Set(rows.map((r) => String(r.k)));
      presence[objectApiName] = keys.filter((k) => !found.has(k));
    }
    return presence;
  }

  /** Derive the check list from a snapshot. */
  private buildChecks(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
    snapshot: VerificationSnapshot | null,
    stable: boolean,
  ): PostLoadCheck[] {
    const checks: PostLoadCheck[] = [];
    checks.push({
      name: 'stability',
      passed: stable,
      detail: stable
        ? 'Two identical consecutive measurements — org reads are stable'
        : 'No two identical measurements within the attempt budget — org reads are transiently inconsistent',
    });
    if (!snapshot) {
      return checks;
    }

    const countMismatches = Object.entries(contract.objects)
      .filter(([obj, entry]) => snapshot.counts[obj] !== entry.expected)
      .map(
        ([obj, entry]) => `${obj}: expected ${entry.expected}, got ${snapshot.counts[obj] ?? 0}`,
      );
    checks.push({
      name: 'counts',
      passed: countMismatches.length === 0,
      detail:
        countMismatches.length === 0
          ? 'All object counts match the counting contract'
          : `Count mismatches — ${countMismatches.join('; ')}`,
    });

    const orphanEntries = Object.entries(snapshot.orphans).filter(([, ids]) => ids.length > 0);
    checks.push({
      name: 'orphans',
      passed: orphanEntries.length === 0,
      detail:
        orphanEntries.length === 0
          ? 'No orphans on the mandatory lookups of the graph'
          : `Orphans — ${orphanEntries.map(([edge, ids]) => `${edge} (${ids.length}: ${ids.join(', ')})`).join('; ')}`,
    });

    if ((options.dataset?.personContactSidecar?.length ?? 0) > 0 && options.mapping) {
      checks.push({
        name: 'personcontact',
        passed: snapshot.personContact.unrestored.length === 0,
        detail:
          snapshot.personContact.unrestored.length === 0
            ? `All ${snapshot.personContact.checked} PersonContact pointer(s) restored`
            : `Unrestored PersonContact pointers — accounts: ${snapshot.personContact.unrestored.join(', ')}`,
      });
    }

    if (options.dataset && Object.keys(options.presenceKeys ?? {}).length > 0) {
      const missingEntries = Object.entries(snapshot.presence).filter(
        ([, keys]) => keys.length > 0,
      );
      checks.push({
        name: 'presence',
        passed: missingEntries.length === 0,
        detail:
          missingEntries.length === 0
            ? 'All referential keys present in the org'
            : `Missing keys — ${missingEntries.map(([obj, keys]) => `${obj}: ${keys.join(', ')}`).join('; ')}`,
      });
    }
    return checks;
  }

  /**
   * Consign the verdict in the manifest. `DryRunLoadControl.status` is an
   * engine-owned union ('pending' | 'passed' | 'failed') with no 'unstable'
   * value, so an unstable verdict is consigned as 'failed' with the explicit
   * `verdict=unstable` marker in the detail (plus author and date).
   */
  private consignVerdict(manifestPath: string, verdict: PostLoadVerdict, author?: string): void {
    const validated = this.sasGuard.assertOutsideRepo(manifestPath);
    const manifest = parseManifest(JSON.parse(fs.readFileSync(validated, 'utf8')));
    manifest.controls.dryRunLoad = {
      status: verdict.status === 'passed' ? 'passed' : 'failed',
      at: verdict.measuredAt,
      detail:
        `post-load check by ${author ?? 'unknown'}: verdict=${verdict.status}; ` +
        verdict.checks.map((c) => `${c.name}=${c.passed ? 'OK' : 'KO'}`).join(', '),
    };
    fs.writeFileSync(validated, serializeManifest(manifest), 'utf8');
  }
}

/** JSON.stringify with recursively sorted object keys (stable comparison). */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
