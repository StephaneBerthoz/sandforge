/**
 * Post-load verifier — READ-ONLY, chained after the load. It
 * consumes the counting contract the loader wrote into the sas and checks:
 *
 *   - **counts**: per-object org counts vs the contract (files minus
 *     exclusions);
 *   - **link integrity**: orphans of the graph's MANDATORY lookups, and each
 *     account the target holds as a person account holding the contact the
 *     load linked (sidecar + persisted mapping);
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
/** Hard cap on measurement attempts. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default orphan sample size per mandatory lookup. */
export const DEFAULT_ORPHAN_SAMPLE_SIZE = 10;

/** One verification check outcome. */
export interface PostLoadCheck {
  name: 'stability' | 'counts' | 'load' | 'orphans' | 'personcontact' | 'presence';
  passed: boolean;
  detail: string;
}

/**
 * Final post-load verdict. `partial` when all that is wrong is that the load
 * did not write part of the dataset — some records of an object refused or
 * held back, none of them whole, or lookups it left empty because the record
 * they name was not loaded — and `failed` when it wrote none of an object, or
 * the org does not hold what the load says it wrote.
 */
export interface PostLoadVerdict {
  status: 'passed' | 'partial' | 'failed' | 'unstable';
  checks: PostLoadCheck[];
  /** Measurements taken (2 identical snapshots stop the loop early). */
  attempts: number;
  measuredAt: string;
  /** Manifest path when the verdict was consigned. */
  manifestPath?: string;
}

/** Dependencies of {@link PostLoadVerifier}. */
export interface PostLoadVerifierDeps {
  /**
   * Read access to the target. Its describe, when given, says whether the
   * target has person accounts before their contacts are asked about.
   */
  orgAccess: Pick<TargetOrgAccess, 'query' | 'count'> & Partial<Pick<TargetOrgAccess, 'describe'>>;
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
  /** Whether each target describes person accounts, asked once: see `describesPersonAccounts`. */
  private readonly personAccounts = new Map<string, Promise<boolean>>();

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
    // Robustness loop: re-measure until TWO IDENTICAL snapshots.
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
      status: verdictOf(checks, contract, stableSnapshot),
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
      orphans: await this.measureOrphans(options, contract),
      personContact: await this.measurePersonContacts(options),
      presence: await this.measurePresence(options, contract),
    };
  }

  /**
   * Per-object counts (`SELECT COUNT()`) for every contract object, of the
   * records this load wrote.
   *
   * Counted among the ids the mapping holds for the object, not across it: a
   * sandbox is seldom empty, and run for real against one, the count of the
   * whole object read 202 accounts where the load had written one — a check
   * that could only pass on an org with nothing in it. Without a mapping there
   * is nothing to scope by, and the whole object is what gets counted.
   */
  private async measureCounts(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
  ): Promise<Record<string, number>> {
    const loaded = options.mapping ? loadedIdsByObject(options.mapping) : undefined;
    const counts: Record<string, number> = {};
    for (const objectApiName of Object.keys(contract.objects).sort()) {
      const from = `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}`;
      if (!loaded) {
        counts[objectApiName] = await this.deps.orgAccess.count(options.orgId, from);
        continue;
      }
      let total = 0;
      for (const clause of idInClauses(loaded.get(objectApiName) ?? [])) {
        total += await this.deps.orgAccess.count(options.orgId, `${from} WHERE ${clause}`);
      }
      counts[objectApiName] = total;
    }
    return counts;
  }

  /**
   * Sampled orphans per mandatory lookup of the graph — among the records
   * this load wrote when the mapping says which they are, for the reason the
   * counts are: the records already in the org are not this load's to judge.
   * Nor is a record the load wrote without the lookup, which the target
   * refused it on and took once it was left out (`writtenWithout`): the
   * lookup is empty on purpose, and the load report says why.
   */
  private async measureOrphans(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
  ): Promise<Record<string, string[]>> {
    const orphans: Record<string, string[]> = {};
    const sample = options.orphanSampleSize ?? DEFAULT_ORPHAN_SAMPLE_SIZE;
    const loaded = options.mapping ? loadedIdsByObject(options.mapping) : undefined;
    for (const [objectApiName, fields] of Object.entries(options.mandatoryLookups ?? {})) {
      for (const field of fields) {
        // Counted apart, beside the orphans: the load left the lookup empty
        // because the record it names was not loaded, and says so.
        const leftEmpty = new Set(
          [
            ...writtenWithout(contract, objectApiName, field),
            ...namedIn(contract.objects[objectApiName]?.parentNotLoaded, field),
          ].flatMap((referenceId) => {
            const id = options.mapping?.get(referenceId);
            return id === undefined ? [] : [id];
          }),
        );
        const clauses = loaded
          ? idInClauses((loaded.get(objectApiName) ?? []).filter((id) => !leftEmpty.has(id)))
          : [''];
        const found: string[] = [];
        for (const clause of clauses) {
          const soql =
            `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} ` +
            `WHERE ${assertSoqlIdentifier(field)} = null${clause ? ` AND ${clause}` : ''} ` +
            `ORDER BY Id LIMIT ${sample}`;
          const rows = await this.deps.orgAccess.query(options.orgId, soql);
          found.push(...rows.map((r) => String(r.Id)));
        }
        orphans[`${objectApiName}.${field}`] = found.sort().slice(0, sample);
      }
    }
    return orphans;
  }

  /**
   * Each person account's link to its contact (sidecar + mapping), for the
   * accounts the load has in the target that the target holds as person
   * accounts: the account names, as its `PersonContactId`, the contact the
   * mapping holds for the dataset's — the one the platform wrote with it,
   * which the load linked. One the target holds as a business account names
   * none, and the load sent the dataset's contact as one of its own, which the
   * counts check: it is no person account to judge here. A target that
   * describes no account's lookup at its contact holds no person account, and
   * is not asked: the query names a field it does not have.
   */
  private async measurePersonContacts(
    options: PostLoadVerifyOptions,
  ): Promise<VerificationSnapshot['personContact']> {
    const sidecar = options.dataset?.personContactSidecar ?? [];
    if (sidecar.length === 0 || !options.mapping) {
      return { checked: 0, unrestored: [] };
    }
    const resolvable = sidecar.filter((link) => options.mapping?.has(link.accountReferenceId));
    if (resolvable.length === 0 || !(await this.describesPersonAccounts(options.orgId))) {
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
    let checked = 0;
    for (const link of resolvable) {
      const accountId = options.mapping.get(link.accountReferenceId) as string;
      const contactOfTheAccount = personContactByAccount.get(accountId);
      if (contactOfTheAccount === null || contactOfTheAccount === undefined) continue;
      checked++;
      if (options.mapping.get(link.contactReferenceId) !== contactOfTheAccount) {
        unrestored.push(link.accountReferenceId);
      }
    }
    return { checked, unrestored: unrestored.sort() };
  }

  /**
   * Whether the target describes an account's lookup at its contact, which
   * only an org with person accounts does — asked once per org. A target
   * whose describe cannot be read, or a verifier given none, is asked as one
   * that has them.
   */
  private describesPersonAccounts(orgId: string): Promise<boolean> {
    let known = this.personAccounts.get(orgId);
    if (!known) {
      const describe = this.deps.orgAccess.describe;
      known = describe
        ? describe
            .call(this.deps.orgAccess, orgId, 'Account')
            .then((account) => account.fields.some((f) => f.name === 'PersonContactId'))
            .catch(() => true)
        : Promise.resolve(true);
      this.personAccounts.set(orgId, known);
    }
    return known;
  }

  /**
   * Presence by key (e.g. ExternalId) for the referential shared with the
   * org — but the key of a record the load wrote without it, which the target
   * refused it on and took once it was left out (`writtenWithout`): the
   * record is in the org, its key empty on purpose.
   */
  private async measurePresence(
    options: PostLoadVerifyOptions,
    contract: CountingContract,
  ): Promise<Record<string, string[]>> {
    const presence: Record<string, string[]> = {};
    if (!options.dataset) {
      return presence;
    }
    for (const [objectApiName, keyField] of Object.entries(options.presenceKeys ?? {})) {
      const withoutTheKey = new Set(writtenWithout(contract, objectApiName, keyField));
      const records = (
        options.dataset.objects.find((o) => o.objectApiName === objectApiName)?.records ?? []
      ).filter((r) => !withoutTheKey.has(r.referenceId));
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

    // What the load did not write. The counts are of what it wrote, and
    // matched them: run for real, a load that failed a third of the dataset —
    // the accounts refused by a validation rule, every contract for want of
    // its account — was verified PASSED.
    const notLoaded = notLoadedOf(contract);
    checks.push({
      name: 'load',
      passed: notLoaded.records === 0,
      detail: notLoadedDetail(notLoaded),
    });

    const orphanEntries = Object.entries(snapshot.orphans).filter(([, ids]) => ids.length > 0);
    const withoutParent = parentsNotLoadedOf(contract);
    const orphanParts = [
      ...(orphanEntries.length > 0
        ? [
            `Orphans — ${orphanEntries.map(([edge, ids]) => `${edge} (${ids.length}: ${ids.join(', ')})`).join('; ')}`,
          ]
        : []),
      ...(withoutParent.length > 0
        ? [
            'Lookups the load left empty because the record they name was not loaded — ' +
              withoutParent.map(({ link, count }) => `${link} (${count})`).join('; '),
          ]
        : []),
    ];
    checks.push({
      name: 'orphans',
      passed: orphanParts.length === 0,
      detail:
        orphanParts.length === 0
          ? 'No orphans on the mandatory lookups of the graph'
          : orphanParts.join('; '),
    });

    if ((options.dataset?.personContactSidecar?.length ?? 0) > 0 && options.mapping) {
      checks.push({
        name: 'personcontact',
        passed: snapshot.personContact.unrestored.length === 0,
        detail:
          snapshot.personContact.unrestored.length === 0
            ? `All ${snapshot.personContact.checked} person account(s) hold the contact the load linked`
            : `Person accounts without the contact the load linked — accounts: ${snapshot.personContact.unrestored.join(', ')}`,
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

/**
 * The referenceIds of the records of `objectApiName` the load wrote without
 * `field`, as the contract names them: none from a contract written before a
 * refused record was written again, or that names something else there.
 */
function writtenWithout(
  contract: CountingContract,
  objectApiName: string,
  field: string,
): string[] {
  return namedIn(contract.objects[objectApiName]?.writtenWithout, field);
}

/** The referenceIds a contract entry's per-field list names under `field`: none when it names none there. */
function namedIn(byField: Record<string, unknown> | undefined, field: string): string[] {
  const named = byField?.[field];
  return Array.isArray(named)
    ? named.filter((referenceId): referenceId is string => typeof referenceId === 'string')
    : [];
}

/**
 * Why the records the load did not write went unwritten, as its contract
 * counts them: refused by the target, held back for a parent it refused, or a
 * person account's contact whose account it did not write. A duplicate the
 * target skipped is none of them — the target holds it — nor is a record the
 * dataset leaves to the platform or holds for an object `excludedObjects`
 * leaves out: the load said so before it wrote anything.
 *
 * Nor is a record of an object the load could not send — the target lacks
 * it, or takes no insert of it — which the load's plan announced before
 * anything was written, and which no load into that target can write: it is
 * counted apart, and fails nothing. Run for real, a load's verification said
 * FAILED for the history rows and the entitlement process its preview had
 * already called not loadable.
 */
const NOT_LOADED_REASONS = {
  refused: ['dml-failed', 'person-contact-not-sent'],
  heldBack: ['parent-refused'],
  notLoadable: ['object-not-loaded'],
} as const;

/** What a load did not write, per object and in all, from its contract. */
interface NotLoaded {
  /** Objects of which it wrote no record, though it had some to write. */
  whole: Array<{ objectApiName: string; notLoaded: number }>;
  /** Objects of which it wrote part. */
  part: Array<{ objectApiName: string; notLoaded: number; of: number }>;
  /** Records refused. */
  refused: number;
  /** Records held back for a parent it refused. */
  heldBack: number;
  /** Records of each object the load could not send, as its plan said: counted apart. */
  notLoadable: Array<{ objectApiName: string; records: number }>;
  /** Records refused or held back: what fails the check. */
  records: number;
}

/** What the load whose contract this is did not write. */
function notLoadedOf(contract: CountingContract): NotLoaded {
  const notLoaded: NotLoaded = {
    whole: [],
    part: [],
    refused: 0,
    heldBack: 0,
    notLoadable: [],
    records: 0,
  };
  for (const [objectApiName, entry] of Object.entries(contract.objects).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const count = (reasons: readonly string[]): number =>
      reasons.reduce((sum, reason) => sum + (entry.exclusionReasons[reason] ?? 0), 0);
    const notLoadable = count(NOT_LOADED_REASONS.notLoadable);
    if (notLoadable > 0) notLoaded.notLoadable.push({ objectApiName, records: notLoadable });
    const refused = count(NOT_LOADED_REASONS.refused);
    const heldBack = count(NOT_LOADED_REASONS.heldBack);
    const missed = refused + heldBack;
    if (missed === 0) continue;
    notLoaded.refused += refused;
    notLoaded.heldBack += heldBack;
    notLoaded.records += missed;
    if (entry.expected === 0) notLoaded.whole.push({ objectApiName, notLoaded: missed });
    else notLoaded.part.push({ objectApiName, notLoaded: missed, of: missed + entry.expected });
  }
  return notLoaded;
}

/** What the `load` check says of what the load did not write. */
function notLoadedDetail(notLoaded: NotLoaded): string {
  const loadable = notLoadableDetail(notLoaded);
  if (notLoaded.records === 0) return `Every record the load had to write went in${loadable}`;
  const parts = [
    ...(notLoaded.whole.length > 0
      ? [
          'Objects the load wrote none of — ' +
            notLoaded.whole.map((o) => `${o.objectApiName} (${o.notLoaded} not loaded)`).join(', '),
        ]
      : []),
    ...(notLoaded.part.length > 0
      ? [
          'Objects it wrote part of — ' +
            notLoaded.part
              .map((o) => `${o.objectApiName} (${o.notLoaded} of ${o.of} not loaded)`)
              .join(', '),
        ]
      : []),
  ];
  const why = [
    ...(notLoaded.refused > 0 ? [`${notLoaded.refused} refused by the target org`] : []),
    ...(notLoaded.heldBack > 0
      ? [`${notLoaded.heldBack} held back for a parent the target org refused`]
      : []),
  ];
  return `${notLoaded.records} record(s) not loaded: ${why.join(', ')}. ${parts.join('; ')}${loadable}`;
}

/** The records of objects the load could not send, said apart: `''` when there are none. */
function notLoadableDetail(notLoaded: NotLoaded): string {
  if (notLoaded.notLoadable.length === 0) return '';
  const records = notLoaded.notLoadable.reduce((sum, o) => sum + o.records, 0);
  return (
    `; ${records} record(s) not loadable, as the preview said — ` +
    notLoaded.notLoadable.map((o) => `${o.objectApiName} (${o.records})`).join(', ')
  );
}

/** Per lookup, how many records the load wrote with it left empty because the record it named was not loaded. */
function parentsNotLoadedOf(contract: CountingContract): Array<{ link: string; count: number }> {
  const links: Array<{ link: string; count: number }> = [];
  for (const [objectApiName, entry] of Object.entries(contract.objects).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const field of Object.keys(entry.parentNotLoaded ?? {}).sort()) {
      const count = namedIn(entry.parentNotLoaded, field).length;
      if (count > 0) links.push({ link: `${objectApiName}.${field}`, count });
    }
  }
  return links;
}

/**
 * The verdict of a verification: `unstable` without two identical readings,
 * `passed` when every check passed, `partial` when all that failed is that
 * the load wrote part of an object or left lookups empty for a parent it did
 * not load — none of an object refused whole, nothing the org was asked about
 * amiss — and `failed` otherwise.
 */
function verdictOf(
  checks: readonly PostLoadCheck[],
  contract: CountingContract,
  stable: VerificationSnapshot | null,
): PostLoadVerdict['status'] {
  if (stable === null) return 'unstable';
  const failing = checks.filter((c) => !c.passed);
  if (failing.length === 0) return 'passed';
  const measuredOrphans = Object.values(stable.orphans).some((ids) => ids.length > 0);
  const partOnly =
    failing.every((c) => c.name === 'load' || c.name === 'orphans') &&
    !measuredOrphans &&
    notLoadedOf(contract).whole.length === 0;
  return partOnly ? 'partial' : 'failed';
}

/** Ids per SOQL `IN` list: short enough for any statement to stay well inside the limit. */
const ID_CHUNK = 200;

/**
 * The target ids the load wrote, per object, from the persisted mapping.
 * Dataset references read `<Object>-<n>`; placeholders read
 * `placeholder:<Object>:<Object.field>`.
 */
function loadedIdsByObject(mapping: ReadonlyMap<string, string>): Map<string, string[]> {
  const byObject = new Map<string, string[]>();
  for (const [referenceId, id] of mapping) {
    const objectApiName = referenceId.startsWith('placeholder:')
      ? referenceId.split(':')[1]
      : referenceId.slice(0, referenceId.lastIndexOf('-'));
    if (!objectApiName) continue;
    const ids = byObject.get(objectApiName) ?? [];
    ids.push(id);
    byObject.set(objectApiName, ids);
  }
  return byObject;
}

/** `Id IN (…)` clauses covering `ids`; none for no id, so nothing is counted. */
function idInClauses(ids: readonly string[]): string[] {
  const clauses: string[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK).map((id) => `'${sanitizeSoqlValue(id)}'`);
    clauses.push(`Id IN (${chunk.join(', ')})`);
  }
  return clauses;
}
