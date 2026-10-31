/**
 * Muting the target's automation for a run, as a lease on the org's own
 * bypass.
 *
 * Every run's automation report reads the custom permissions the target's
 * flows, processes and workflow rules test to stay quiet, and the smallest
 * permission set holding each, and said "bypass: assign … to the user the run
 * writes as": shown, never run. Asked to mute, a run runs it, for its own
 * duration: it assigns the user it writes as the sets that user lacks, and
 * takes back, as it ends, the assignments it made. Nothing is deactivated, no
 * other user is touched, and a production org is refused whatever its
 * setting says.
 *
 * Two runs of one machine may write to one org as one user at once, and need
 * the same set: the trap org's bypass lease (`scripts/trap-bypass.mjs`) lost
 * a run its bypass when another, ending, gave the set back by assignee. So a
 * lease is journaled on this machine before anything is assigned — per org
 * and user, the run, its process, when it ends, and the assignments it
 * created — and a lease that ends removes only the assignments it created,
 * and none another live lease of this machine needs: those pass to that
 * lease, which removes them as it ends. A lease past its end, or whose process
 * is gone, holds nothing, and is released by the next run that takes one: a
 * machine that died under a run leaves the assignments to that.
 *
 * The journal of an org's user is one file in `.sandforge/mute-leases` of the
 * home directory, whatever `SANDFORGE_JOURNAL_DIR` says, as the checkpoint
 * locks are: two journals of one user would let one run take back what the
 * other counts on. It is changed under a lock of its own, written whole
 * through a file beside it renamed over it.
 */

import { randomUUID } from 'node:crypto';
import { hostname, homedir, uptime } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import type { Connection } from 'jsforce';
import {
  alsoLiftedWords,
  liftsUnreadWords,
  mutedAutomationOf,
  mutedEntryWords,
  mutePermissionsOf,
  mutePlanOf,
  recordWriteHeaders,
  stillRunsWords,
  type ForgeAutomationWrite,
  type ForgeTargetAutomation,
  type MutedAutomation,
  type MutePlan,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../../core/precheck/orgKindLive.js';
import { linkedLockKind, lockHolderShape, type LockSelf } from '../checkpoint/linkedLock.js';
import { THIS_HOST, processRunning, type RunWriterChecks } from '../sync/runWriter.js';

// ─── The org ─────────────────────────────────────────────────────────────────

/** What one write of a record answered: its id, or the errors the org refused it with. */
export interface MuteSaveResult {
  id?: string;
  success: boolean;
  errors?: Array<{ statusCode?: string; errorCode?: string; message?: string }>;
}

/**
 * What a lease reads and writes of the target, as a jsforce connection gives
 * it ({@link muteOrgOf}): what org it is, a query, the user the connection
 * is, and the inserts and deletes of `PermissionSetAssignment`.
 */
export interface MuteOrg {
  /** What the org says it is, read live (`typeTarget`): a production org is refused. */
  typeOrg: () => Promise<TypedTarget>;
  query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
  identity: () => Promise<{ user_id: string; organization_id: string }>;
  createAssignment: (record: {
    AssigneeId: string;
    PermissionSetId: string;
  }) => Promise<MuteSaveResult>;
  deleteAssignment: (id: string) => Promise<MuteSaveResult>;
}

/** An error the org answered a write with, as a save result says it. */
function refusedSave(err: unknown): MuteSaveResult {
  const coded = err as { errorCode?: unknown; name?: unknown } | undefined;
  const code =
    typeof coded?.errorCode === 'string'
      ? coded.errorCode
      : typeof coded?.name === 'string'
        ? coded.name
        : undefined;
  return {
    success: false,
    errors: [{ ...(code ? { statusCode: code } : {}), message: extractErrorMessage(err) }],
  };
}

/** One save result of what jsforce answers, which may be a list of one. */
function oneResult(answer: unknown): MuteSaveResult {
  const result = (Array.isArray(answer) ? answer[0] : answer) as MuteSaveResult | undefined;
  return result ?? { success: false, errors: [{ message: 'the org answered nothing' }] };
}

/** The lease's view of a jsforce connection to the target. */
export function muteOrgOf(conn: Pick<Connection, 'query' | 'identity' | 'sobject'>): MuteOrg {
  return {
    typeOrg: () => typeTarget(conn),
    query: async (soql) => {
      const answer = await conn.query<Record<string, unknown>>(soql);
      return { records: answer.records };
    },
    identity: async () => {
      const identity = await conn.identity();
      return { user_id: identity.user_id, organization_id: identity.organization_id };
    },
    createAssignment: async (record) =>
      conn
        .sobject('PermissionSetAssignment')
        .create(record, { headers: recordWriteHeaders() })
        .then(oneResult, refusedSave),
    deleteAssignment: async (id) =>
      conn.sobject('PermissionSetAssignment').destroy(id).then(oneResult, refusedSave),
  };
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a run was not muted, and nothing assigned: `MUTE_PRODUCTION`, the
 * target is a production org; `MUTE_NO_RIGHT`, the user the run writes as
 * cannot assign permission sets, or the org would not say; `MUTE_FAILED`, a
 * set could not be found, assigned or read back.
 */
export type MuteRefusalCode = 'MUTE_PRODUCTION' | 'MUTE_NO_RIGHT' | 'MUTE_FAILED';

/** A mute refused, in words, with its code. */
export interface MuteRefusal {
  code: MuteRefusalCode;
  message: string;
}

/**
 * Raised when a run asked to mute could not be: nothing was assigned, and the
 * run writes nothing — it was asked to run with the target's automation
 * quiet, and would not be.
 */
export class MuteRefusedError extends Error {
  constructor(readonly refusal: MuteRefusal) {
    super(refusal.message);
    this.name = 'MuteRefusedError';
  }

  get code(): MuteRefusalCode {
    return this.refusal.code;
  }
}

/** Whether `error` is a refused mute, by its name as well as its class, as a gate stop is told. */
export function isMuteRefusedError(error: unknown): error is MuteRefusedError {
  return (
    error instanceof MuteRefusedError ||
    (error instanceof Error && error.name === 'MuteRefusedError' && 'refusal' in error)
  );
}

// ─── The journal ─────────────────────────────────────────────────────────────

/** How long a lease holds unless renewed: past it, the next run that takes one releases it. */
export const MUTE_LEASE_MINUTES = 60;

/** How often a held lease pushes its end back while its run goes on. */
export const MUTE_RENEW_EVERY_MS = 5 * 60_000;

/** How long a run waits for another to be done with the journal before it gives up. */
const JOURNAL_WAIT_MS = 60_000;

/** Between two tries at the journal's lock. */
const JOURNAL_RETRY_MS = 200;

/** What a folder of the journals is made with: its owner alone lists it. */
const JOURNAL_DIR_MODE = 0o700;

/** What a journal is made with: its owner alone reads it. */
const JOURNAL_FILE_MODE = 0o600;

/** An org's or a record's id, 15 or 18 letters and digits. */
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

const sfIdSchema = z.string().regex(SF_ID);

/** An assignment a lease created, which it takes back as it ends. */
const createdSchema = z.object({
  id: sfIdSchema,
  permissionSetId: sfIdSchema,
  permissionSet: z.string().min(1).max(255),
});

/** One run's lease, as the journal keeps it. */
const leaseSchema = z.object({
  runId: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  pid: z.number().int().nonnegative(),
  /** When the lease's process started, by its machine's clock. */
  hostStartedAt: z.iso.datetime({ offset: true }),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Past it the lease holds nothing, whatever its process does. */
  endsAt: z.iso.datetime({ offset: true }),
  /** The permission sets the run needs held, by id: another lease ending keeps them for it. */
  needs: z.array(sfIdSchema),
  /**
   * The sets the lease was assigning when the journal was last written, by
   * id: a process that died between an assignment and its line leaves it
   * here, and the release looks it up.
   */
  assigning: z.array(sfIdSchema),
  created: z.array(createdSchema),
});

const journalSchema = z.object({
  version: z.literal(1),
  organizationId: sfIdSchema,
  userId: sfIdSchema,
  leases: z.array(leaseSchema),
});

type Lease = z.infer<typeof leaseSchema>;
type Journal = z.infer<typeof journalSchema>;
type Created = z.infer<typeof createdSchema>;

/** The journal lock's file: who holds it, read back by its own schema. */
const journalLockSchema = z.object(lockHolderShape);
const journalLocks = linkedLockKind((content) => {
  const parsed = journalLockSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});

/**
 * The folder the journals are in when nothing names another: one place per
 * user of the machine, `.sandforge/mute-leases` of the home directory, unless
 * `SANDFORGE_MUTE_LEASES_DIR` names another — a test's, or a job that runs
 * under a home of its own and wants its leases kept elsewhere. Every run of
 * the user that may write to the same org must name the same one.
 */
export function defaultMuteLeasesDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const named = env['SANDFORGE_MUTE_LEASES_DIR'];
  return named !== undefined && named.trim() !== ''
    ? named
    : join(home, '.sandforge', 'mute-leases');
}

/** The journal of one org's user. */
export function muteJournalFileOf(dir: string, organizationId: string, userId: string): string {
  if (!SF_ID.test(organizationId) || !SF_ID.test(userId)) {
    throw new Error('A mute lease is journaled under an org id and a user id.');
  }
  return join(dir, `${organizationId.slice(0, 15)}-${userId.slice(0, 15)}.json`);
}

/** Who takes leases, and how a lease is told alive from gone. */
export interface MuteLeaseOptions {
  /** The journals' folder: {@link defaultMuteLeasesDir} when not told. */
  dir?: string;
  /** This process, as its leases name it. */
  self?: LockSelf;
  checks?: RunWriterChecks;
  /** How long a lease holds before it is renewed: {@link MUTE_LEASE_MINUTES}. */
  minutes?: number;
  /** How often a held lease is renewed: {@link MUTE_RENEW_EVERY_MS}; 0 never. */
  renewEveryMs?: number;
}

/** This process. */
const THIS_PROCESS: LockSelf = {
  host: hostname(),
  pid: THIS_HOST.pid,
  startedAt: THIS_HOST.startedAt,
};

/** How far two readings of when a process started may differ: the clocks they are read from. */
const STARTED_LEEWAY_MS = 60_000;

/** The leases this process holds, by the token each was given: another of its own process is believed only while listed. */
const heldHere = new Set<string>();

/** A lease's key among those this process holds. */
function heldKey(file: string, runId: string, acquiredAt: string): string {
  return `${file}\n${runId}\n${acquiredAt}`;
}

/**
 * Whether a lease holds: before its end, and its process at work. A lease of
 * this process holds while it is listed among those it holds; one of another
 * process of this machine while that process runs and started after the
 * machine did; one of another machine sharing the home folder cannot be
 * asked, and holds until its end.
 */
function isLive(lease: Lease, file: string, self: LockSelf, checks: RunWriterChecks = {}): boolean {
  const now = checks.now?.() ?? Date.now();
  if (!(Date.parse(lease.endsAt) > now)) return false;
  if (lease.host !== self.host) return true;
  if (lease.pid === self.pid && lease.hostStartedAt === self.startedAt) {
    return heldHere.has(heldKey(file, lease.runId, lease.acquiredAt));
  }
  const booted = checks.bootedAt?.() ?? Date.now() - uptime() * 1000;
  const started = Date.parse(lease.hostStartedAt);
  if (Number.isFinite(started) && started < booted - STARTED_LEEWAY_MS) return false;
  return (checks.isAlive ?? processRunning)(lease.pid);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Change the journal `file` under its lock: read it — none yet is an empty
 * one —, hand it to `change`, and write what it gives back whole.
 */
async function withJournal<T>(
  file: string,
  ids: { organizationId: string; userId: string },
  options: MuteLeaseOptions,
  change: (journal: Journal, save: (journal: Journal) => Promise<void>) => Promise<T>,
): Promise<T> {
  const self = options.self ?? THIS_PROCESS;
  const lockOptions = { self, ...(options.checks ? { checks: options.checks } : {}) };
  const deadline = Date.now() + JOURNAL_WAIT_MS;
  await mkdir(dirname(file), { recursive: true, mode: JOURNAL_DIR_MODE });
  for (;;) {
    const taken = journalLocks.acquire(`${file}.lock`, (head) => head, lockOptions);
    if ('lock' in taken) {
      try {
        const journal = await readJournal(file, ids);
        const save = async (next: Journal): Promise<void> => {
          const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
          await writeFile(temp, JSON.stringify(next, null, 2), {
            encoding: 'utf8',
            mode: JOURNAL_FILE_MODE,
          });
          await rename(temp, file);
        };
        return await change(journal, save);
      } finally {
        taken.lock.release();
      }
    }
    if (Date.now() > deadline) {
      throw new MuteRefusedError({
        code: 'MUTE_FAILED',
        message:
          `The journal of the mute leases (${file}) stayed held by process ${taken.busy.pid} ` +
          'for a minute: nothing was assigned.',
      });
    }
    await sleep(JOURNAL_RETRY_MS);
  }
}

/** The journal as it is on disk; an empty one when there is none, or when it does not parse. */
async function readJournal(
  file: string,
  ids: { organizationId: string; userId: string },
): Promise<Journal> {
  const empty: Journal = { version: 1, ...ids, leases: [] };
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw err;
  }
  try {
    const parsed = journalSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: read as an empty journal below.
  }
  // A journal that does not parse names no lease: its assignments, if any,
  // are an admin's to look at. It is kept aside rather than written over.
  await rename(file, `${file}.${Date.now()}.unreadable`).catch(() => undefined);
  return empty;
}

// ─── Releasing ───────────────────────────────────────────────────────────────

/** Errors a delete of an assignment answers when the assignment is gone already. */
const GONE = new Set(['ENTITY_IS_DELETED', 'INVALID_CROSS_REFERENCE_KEY', 'NOT_FOUND']);

/** What releasing one lease did. */
interface Released {
  removed: Created[];
  /** Passed to another live lease that needs them. */
  passed: Created[];
  /** Left in the org: the delete was refused. */
  left: Array<Created & { why: string }>;
}

/**
 * Release `lease` in `journal`: each assignment it created another live lease
 * needs passes to that lease; every other is deleted. A set it was assigning
 * when its process died is looked up, and taken as its own when the user
 * holds it and no other lease created it: the run read the user without it
 * before it journaled the set. The lease goes from the journal, unless an
 * assignment could not be deleted: it stays, past its end, for the next run
 * to try again.
 */
async function releaseLease(
  org: MuteOrg,
  journal: Journal,
  lease: Lease,
  live: (other: Lease) => boolean,
): Promise<Released> {
  const others = journal.leases.filter((other) => other !== lease && live(other));
  const created = [...lease.created];
  if (lease.assigning.length > 0) {
    const ownedElsewhere = new Set(
      journal.leases.flatMap((other) => (other === lease ? [] : other.created.map((c) => c.id))),
    );
    const found = await org
      .query(
        'SELECT Id, PermissionSetId, PermissionSet.Name FROM PermissionSetAssignment ' +
          `WHERE AssigneeId = '${journal.userId}' AND PermissionSetId IN (${lease.assigning
            .map((id) => `'${id}'`)
            .join(', ')})`,
      )
      .then((answer) => answer.records)
      .catch(() => []);
    for (const row of found) {
      const id = typeof row['Id'] === 'string' ? row['Id'] : undefined;
      const setId = typeof row['PermissionSetId'] === 'string' ? row['PermissionSetId'] : undefined;
      if (!id || !setId || ownedElsewhere.has(id) || created.some((c) => c.id === id)) continue;
      const set = row['PermissionSet'] as { Name?: unknown } | undefined;
      created.push({
        id,
        permissionSetId: setId,
        permissionSet: typeof set?.Name === 'string' ? set.Name : setId,
      });
    }
  }
  const released: Released = { removed: [], passed: [], left: [] };
  for (const assignment of created) {
    const taker = others.find((other) => other.needs.includes(assignment.permissionSetId));
    if (taker) {
      if (!taker.created.some((c) => c.id === assignment.id)) taker.created.push(assignment);
      released.passed.push(assignment);
      continue;
    }
    const answer = await org.deleteAssignment(assignment.id);
    const code = answer.errors?.[0]?.statusCode ?? answer.errors?.[0]?.errorCode;
    if (answer.success || (code !== undefined && GONE.has(code))) {
      released.removed.push(assignment);
    } else {
      released.left.push({
        ...assignment,
        why: answer.errors?.[0]?.message ?? code ?? 'the org refused the delete',
      });
    }
  }
  const at = journal.leases.indexOf(lease);
  if (released.left.length === 0) {
    journal.leases.splice(at, 1);
  } else {
    journal.leases[at] = {
      ...lease,
      endsAt: new Date(0).toISOString(),
      needs: [],
      assigning: [],
      created: released.left.map(({ id, permissionSetId, permissionSet }) => ({
        id,
        permissionSetId,
        permissionSet,
      })),
    };
  }
  return released;
}

/** Release every lease of `journal` that no longer holds: past its end, or its process gone. */
async function releaseStale(
  org: MuteOrg,
  journal: Journal,
  live: (lease: Lease) => boolean,
): Promise<number> {
  let count = 0;
  for (const lease of [...journal.leases]) {
    if (live(lease)) continue;
    await releaseLease(org, journal, lease, live);
    count += 1;
  }
  return count;
}

// ─── Taking a lease ──────────────────────────────────────────────────────────

/** A lease held for a run, until it is released. */
export interface HeldMute {
  /** What the run mutes, as it stands while it runs. */
  readonly outcome: MutedAutomation;
  /**
   * Take back the assignments the lease created, but those another live
   * lease needs, and end it. Once is enough, and again answers the same.
   * Never throws: what could not be taken back is said in the outcome, and
   * the lease's end time stands for it.
   */
  release(): Promise<MutedAutomation>;
}

/** What a run asked to mute holds once its gate has read the target, before it writes. */
export interface MutePrepared {
  plan: MutePlan;
  /**
   * The read as the run's gate is to take it: the bypasses the mute holds
   * held, so that what they keep quiet is neither counted nor asked about.
   */
  automation: ForgeTargetAutomation;
  /** What the mute would do, as a dry run says it: nothing assigned. */
  planned: MutedAutomation;
  /**
   * Take the lease and assign what the user lacks, before the run's first
   * write. With nothing to mute, a lease that holds nothing. Throws
   * {@link MuteRefusedError} when a set cannot be assigned, nothing left
   * assigned.
   */
  acquire(runId: string): Promise<HeldMute>;
}

/** Why the user cannot assign permission sets, or nothing when they can. */
async function assignRightRefusal(org: MuteOrg): Promise<string | undefined> {
  let row: Record<string, unknown> | undefined;
  try {
    row = (
      await org.query(
        'SELECT PermissionsAssignPermissionSets, PermissionsManageUsers FROM UserPermissionAccess',
      )
    ).records[0];
  } catch (err: unknown) {
    return (
      'the org would not say whether the user the run writes as may assign permission sets ' +
      `(${extractErrorMessage(err)})`
    );
  }
  if (
    row?.['PermissionsAssignPermissionSets'] === true ||
    row?.['PermissionsManageUsers'] === true
  ) {
    return undefined;
  }
  return (
    'the user the run writes as cannot assign permission sets (neither Assign Permission Sets ' +
    'nor Manage Users)'
  );
}

/** A permission set's API name, split into its namespace and its own name. */
function namespacedOf(name: string): { namespace: string; developerName: string } {
  const at = name.indexOf('__');
  // `ns__Name` names the set `Name` of the namespace `ns`; a custom object's
  // `__c` is never in a permission set's name.
  return at > 0 && !name.slice(at + 2).includes('__')
    ? { namespace: name.slice(0, at), developerName: name.slice(at + 2) }
    : { namespace: '', developerName: name };
}

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The ids of the permission sets `names` names, read from the org; a name not found is left out. */
async function permissionSetIds(
  org: MuteOrg,
  names: readonly string[],
): Promise<Map<string, string>> {
  const parts = names.map(namespacedOf);
  const safe = parts.filter(
    (p) => API_NAME.test(p.developerName) && (!p.namespace || API_NAME.test(p.namespace)),
  );
  if (safe.length === 0) return new Map();
  const answer = await org.query(
    'SELECT Id, Name, NamespacePrefix FROM PermissionSet WHERE Name IN (' +
      [...new Set(safe.map((p) => `'${p.developerName}'`))].join(', ') +
      ')',
  );
  const ids = new Map<string, string>();
  for (const name of names) {
    const { namespace, developerName } = namespacedOf(name);
    const row = answer.records.find(
      (r) =>
        String(r['Name'] ?? '').toLowerCase() === developerName.toLowerCase() &&
        String(r['NamespacePrefix'] ?? '').toLowerCase() === namespace.toLowerCase(),
    );
    if (typeof row?.['Id'] === 'string') ids.set(name, row['Id']);
  }
  return ids;
}

/** The ids of the assignments of the sets `setIds` the user holds, by set id. */
async function assignmentsOf(
  org: MuteOrg,
  userId: string,
  setIds: readonly string[],
): Promise<Map<string, string>> {
  if (setIds.length === 0) return new Map();
  const answer = await org.query(
    `SELECT Id, PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' ` +
      `AND PermissionSetId IN (${setIds.map((id) => `'${id}'`).join(', ')})`,
  );
  const held = new Map<string, string>();
  for (const row of answer.records) {
    const setId = row['PermissionSetId'];
    const id = row['Id'];
    if (typeof setId === 'string' && typeof id === 'string') held.set(setId, id);
  }
  return held;
}

/** The lease's outcome before anything is assigned. */
function plannedOf(
  plan: MutePlan,
  state: MutedAutomation['state'],
  reason?: string,
): MutedAutomation {
  return {
    state,
    assigned: [],
    held: [],
    permissions: mutePermissionsOf(plan),
    silenced: plan.silenced.map((entry) => ({ ...entry })),
    stillRan: plan.stillRuns.map((entry) => ({ ...entry })),
    // What the sets lift beside what they are assigned for, said wherever
    // the mute is: the trap org's set lifted two validation rules unsaid.
    ...(plan.assign.length > 0
      ? { alsoLifted: (plan.alsoLifts ?? []).map((e) => ({ ...e })) }
      : {}),
    ...(plan.liftsUnread ? { liftsUnread: plan.liftsUnread.map((u) => ({ ...u })) } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Why nothing found can be muted, in words. */
export const NOTHING_TO_MUTE =
  'nothing found can be muted: no flow, process or workflow rule the run fires has a bypass ' +
  'a permission set of the target holds; the run goes on as without the option';

/** What {@link prepareMute} takes. */
export interface PrepareMuteOptions extends MuteLeaseOptions {
  /** The writes the run makes, per object ({@link mutePlanOf}); every write when not told. */
  writes?: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
}

/**
 * Prepare a run's mute once its gate has read the target: plan it, and refuse
 * it — nothing assigned — on a production org, whatever the setting, and for
 * a user who cannot assign permission sets. With nothing found to mute, the
 * run goes on as without the option, and says so.
 *
 * Reads only. The assignments are made by {@link MutePrepared.acquire}, before
 * the run's first write.
 */
export async function prepareMute(
  org: MuteOrg,
  automation: ForgeTargetAutomation,
  options: PrepareMuteOptions = {},
): Promise<MutePrepared | { refused: MuteRefusal }> {
  let production: boolean;
  try {
    production = isProductionTarget(await org.typeOrg());
  } catch (err: unknown) {
    return {
      refused: {
        code: 'MUTE_PRODUCTION',
        message:
          `The target did not say what org it is (${extractErrorMessage(err)}), and its ` +
          'automation is muted on no org that cannot be told from a production one. Nothing was assigned.',
      },
    };
  }
  if (production) {
    return {
      refused: {
        code: 'MUTE_PRODUCTION',
        message:
          'The target is a production org: its automation is never muted there, whatever the ' +
          'setting says. Nothing was assigned; run without the option.',
      },
    };
  }
  const { plan, automation: muted, planned } = planMute(automation, options.writes);
  if (plan.assign.length === 0) {
    return {
      plan,
      automation,
      planned,
      acquire: async () => ({ outcome: planned, release: async () => planned }),
    };
  }
  const noRight = await assignRightRefusal(org);
  if (noRight !== undefined) {
    return {
      refused: {
        code: 'MUTE_NO_RIGHT',
        message: `The target's automation cannot be muted: ${noRight}. Nothing was assigned.`,
      },
    };
  }
  return {
    plan,
    automation: muted,
    planned,
    acquire: (runId) => acquireMute(org, plan, runId, options),
  };
}

/**
 * A mute planned from the read of the target alone, nothing read of the org
 * and nothing assigned: what a dry run says, and the read a command line's
 * own gate takes before it hands the run to the extension.
 */
export function planMute(
  automation: ForgeTargetAutomation,
  writes?: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
): { plan: MutePlan; automation: ForgeTargetAutomation; planned: MutedAutomation } {
  const plan = mutePlanOf(automation, writes);
  if (plan.assign.length === 0) {
    return { plan, automation, planned: plannedOf(plan, 'nothing', NOTHING_TO_MUTE) };
  }
  return {
    plan,
    automation: mutedAutomationOf(automation, mutePermissionsOf(plan)),
    planned: plannedOf(plan, 'planned'),
  };
}

/**
 * Take a lease for a run and assign the user the sets of `plan` they lack:
 * the lease is journaled first, each assignment as it is made, and every set
 * is read back held before the run writes. What fails takes back what it
 * assigned and refuses, nothing left assigned.
 */
export async function acquireMute(
  org: MuteOrg,
  plan: MutePlan,
  runId: string,
  options: MuteLeaseOptions = {},
): Promise<HeldMute> {
  const self = options.self ?? THIS_PROCESS;
  const now = (): number => options.checks?.now?.() ?? Date.now();
  const minutes = options.minutes ?? MUTE_LEASE_MINUTES;
  const failed = (message: string): never => {
    throw new MuteRefusedError({ code: 'MUTE_FAILED', message });
  };

  const identity = await org
    .identity()
    .catch((err: unknown) =>
      failed(`The target would not say who the run writes as (${extractErrorMessage(err)}).`),
    );
  const ids = { organizationId: identity.organization_id, userId: identity.user_id };
  const file = muteJournalFileOf(
    options.dir ?? defaultMuteLeasesDir(),
    ids.organizationId,
    ids.userId,
  );
  const names = plan.assign.map((a) => a.permissionSet);
  const setIds = await permissionSetIds(org, names).catch((err: unknown) =>
    failed(`The permission sets to assign could not be read (${extractErrorMessage(err)}).`),
  );
  const missingSets = names.filter((name) => !setIds.has(name));
  if (missingSets.length > 0) {
    failed(`The target holds no permission set ${missingSets.join(', ')}: nothing was assigned.`);
  }
  const needs = names.map((name) => setIds.get(name)!);
  const nameOf = new Map(names.map((name) => [setIds.get(name)!, name]));
  const live = (lease: Lease): boolean => isLive(lease, file, self, options.checks);
  const acquiredAt = new Date(now()).toISOString();
  const key = heldKey(file, runId, acquiredAt);

  const taken = await withJournal(file, ids, options, async (journal, save) => {
    await releaseStale(org, journal, live);
    const held = await assignmentsOf(org, ids.userId, needs);
    const missing = needs.filter((id) => !held.has(id));
    const lease: Lease = {
      runId,
      host: self.host,
      pid: self.pid,
      hostStartedAt: self.startedAt,
      acquiredAt,
      endsAt: new Date(now() + minutes * 60_000).toISOString(),
      needs,
      assigning: [...missing],
      created: [],
    };
    journal.leases.push(lease);
    heldHere.add(key);
    // Journaled before any assignment: a process that dies from here on
    // leaves a lease the next run releases.
    await save(journal);
    const undo = async (message: string): Promise<never> => {
      await releaseLease(org, journal, lease, live);
      heldHere.delete(key);
      await save(journal);
      return failed(`${message} What this run had assigned was taken back.`);
    };
    for (const setId of missing) {
      const answer = await org.createAssignment({ AssigneeId: ids.userId, PermissionSetId: setId });
      lease.assigning = lease.assigning.filter((id) => id !== setId);
      if (answer.success && answer.id) {
        lease.created.push({
          id: answer.id,
          permissionSetId: setId,
          permissionSet: nameOf.get(setId)!,
        });
        await save(journal);
        continue;
      }
      const error = answer.errors?.[0];
      // Assigned meanwhile by another run: held, and not this lease's to take back.
      if ((error?.statusCode ?? error?.errorCode) === 'DUPLICATE_VALUE') {
        await save(journal);
        continue;
      }
      return undo(
        `${nameOf.get(setId)} could not be assigned to the user the run writes as: ` +
          `${error?.message ?? error?.statusCode ?? 'the org refused it'}.`,
      );
    }
    const readBack = await assignmentsOf(org, ids.userId, needs).catch(
      () => new Map<string, string>(),
    );
    const notHeld = needs.filter((id) => !readBack.has(id));
    if (notHeld.length > 0) {
      return undo(
        `Read back, the user the run writes as does not hold ${notHeld.map((id) => nameOf.get(id)).join(', ')}.`,
      );
    }
    const created = new Set(lease.created.map((c) => c.permissionSetId));
    return {
      endsAt: lease.endsAt,
      assigned: lease.created.map((c) => c.permissionSet),
      held: needs.filter((id) => !created.has(id)).map((id) => nameOf.get(id)!),
    };
  });

  const outcome: MutedAutomation = {
    ...plannedOf(plan, 'muted'),
    assigned: taken.assigned,
    held: taken.held,
    leaseEndsAt: taken.endsAt,
  };
  const renewEvery = options.renewEveryMs ?? MUTE_RENEW_EVERY_MS;
  // While the run goes on, its lease's end is pushed back: a run of whole
  // tables lasts longer than a lease, and the next run would release it.
  const renewal =
    renewEvery > 0
      ? setInterval(() => {
          void withJournal(file, ids, options, async (journal, save) => {
            const lease = journal.leases.find(
              (l) => l.runId === runId && l.acquiredAt === acquiredAt,
            );
            if (!lease || !heldHere.has(key)) return;
            lease.endsAt = new Date(now() + minutes * 60_000).toISOString();
            outcome.leaseEndsAt = lease.endsAt;
            await save(journal);
          }).catch(() => undefined);
        }, renewEvery)
      : undefined;
  renewal?.unref?.();

  let released: Promise<MutedAutomation> | undefined;
  return {
    outcome,
    release: () => {
      released ??= (async (): Promise<MutedAutomation> => {
        if (renewal) clearInterval(renewal);
        try {
          const done = await withJournal(file, ids, options, async (journal, save) => {
            const lease = journal.leases.find(
              (l) => l.runId === runId && l.acquiredAt === acquiredAt,
            );
            heldHere.delete(key);
            if (!lease) return undefined;
            const result = await releaseLease(org, journal, lease, live);
            await save(journal);
            return result;
          });
          const left = done?.left ?? [];
          return {
            ...outcome,
            released: left.length === 0,
            ...(left.length > 0
              ? {
                  reason:
                    `${left.map((l) => `${l.permissionSet} (${l.why})`).join(', ')} could not be ` +
                    `taken back: the lease ends at ${outcome.leaseEndsAt}, and the next run that ` +
                    'mutes this org releases it',
                }
              : {}),
          };
        } catch (err: unknown) {
          heldHere.delete(key);
          return {
            ...outcome,
            released: false,
            reason:
              `the assignments could not be taken back (${extractErrorMessage(err)}): the lease ` +
              `ends at ${outcome.leaseEndsAt}, and the next run that mutes this org releases it`,
          };
        }
      })();
      return released;
    },
  };
}

// ─── What a run does with it ─────────────────────────────────────────────────

/** What a run says of a mute it could not plan: the target's automation was not read. */
export function nothingMuted(reason: string): MutedAutomation {
  return {
    state: 'nothing',
    assigned: [],
    held: [],
    permissions: [],
    silenced: [],
    stillRan: [],
    reason: `nothing can be muted: ${reason}; the run goes on as without the option`,
  };
}

/** A run's mute, once its gate has read the target. */
export interface RunMute {
  /** The read as the gate takes it: what the mute keeps quiet held quiet; the read itself otherwise. */
  automation: ForgeTargetAutomation | undefined;
  /** What to hold while the run writes ({@link whileMuted}); undefined when nothing can be muted. */
  prepared?: MutePrepared;
  /** What the run says of its mute before it writes: planned, or nothing to mute. */
  muted: MutedAutomation;
  /** The plan it was made from: the sets to assign, what they silence, leave running and lift beside. */
  plan?: MutePlan;
}

/**
 * What a dry run's `--json` summary says of its mute, as its lines say it:
 * what a real run would assign, what that silences, what still runs and what
 * the sets lift beside. Its summary held none of it, while its lines named
 * the sets and what they silenced.
 */
export function dryRunMuteOf(mute: Pick<RunMute, 'muted' | 'plan'> | undefined): {
  mutedAutomation?: MutedAutomation;
  mutePlan?: MutePlan;
} {
  if (!mute) return {};
  return { mutedAutomation: mute.muted, ...(mute.plan ? { mutePlan: mute.plan } : {}) };
}

/**
 * The mute of a run that asked for one, prepared once its gate has read the
 * target's automation ({@link prepareMute}). A read that failed leaves
 * nothing to plan from: the run goes on as without the option, and says so.
 *
 * @throws MuteRefusedError on a production org, or for a user who cannot
 *   assign permission sets: nothing assigned, and the run writes nothing.
 */
export async function muteForRun(
  org: () => Promise<MuteOrg>,
  read: ForgeTargetAutomation | { unread: string },
  options: PrepareMuteOptions = {},
): Promise<RunMute> {
  // A read that failed is told by its reason: a read that succeeded lists
  // what it could not take under `unread` too, as an array.
  if (typeof read.unread === 'string') {
    return {
      automation: undefined,
      muted: nothingMuted(`the target's automation could not be read (${read.unread})`),
    };
  }
  const prepared = await prepareMute(await org(), read as ForgeTargetAutomation, options);
  if ('refused' in prepared) throw new MuteRefusedError(prepared.refused);
  return {
    automation: prepared.automation,
    ...(prepared.plan.assign.length > 0 ? { prepared } : {}),
    muted: prepared.planned,
    plan: prepared.plan,
  };
}

/**
 * Run `write` under the lease: taken before it, released after it — a
 * success, a failure, a Stop or a thrown error alike. Without a mute, `write`
 * alone.
 *
 * @returns What `write` answered, and what the run muted once released.
 */
export async function whileMuted<T>(
  prepared: MutePrepared | undefined,
  runId: string,
  write: () => Promise<T>,
): Promise<{ result: T; muted?: MutedAutomation }> {
  if (!prepared) return { result: await write() };
  const held = await prepared.acquire(runId);
  let result: T;
  try {
    result = await write();
  } catch (err: unknown) {
    const muted = await held.release();
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      mutedAutomation: muted,
    });
  }
  return { result, muted: await held.release() };
}

/** What a run's error carries of its mute, when it was thrown under one ({@link whileMuted}). */
export function mutedOfError(err: unknown): MutedAutomation | undefined {
  const muted = (err as { mutedAutomation?: unknown } | undefined)?.mutedAutomation;
  return muted !== null && typeof muted === 'object' ? (muted as MutedAutomation) : undefined;
}

/**
 * What a command line says of a run's mute: what is or would be assigned,
 * what that silences, what still runs and why, and, once the run ended,
 * whether the assignments were taken back.
 */
export function muteLines(muted: MutedAutomation, target: string): string[] {
  const lines: string[] = [];
  if (muted.state === 'nothing') {
    lines.push(`mute: ${muted.reason ?? NOTHING_TO_MUTE}`);
  } else if (muted.state === 'planned') {
    lines.push(
      `mute: a real run would assign ${muted.permissions.length > 0 ? `the permission set(s) holding ${muted.permissions.join(', ')}` : 'nothing'} ` +
        `to the user it writes as in ${target}, for the run alone; this dry run assigns nothing`,
    );
  } else {
    lines.push(
      `mute: ${muted.assigned.length > 0 ? `assigned ${muted.assigned.join(', ')}` : 'assigned nothing'}` +
        `${muted.held.length > 0 ? `; ${muted.held.join(', ')} held already` : ''} ` +
        `to the user the run writes as in ${target}, for the run alone`,
    );
  }
  for (const entry of muted.silenced) {
    lines.push(`  silenced: ${mutedEntryWords(entry)} (bypass ${entry.permission})`);
  }
  for (const entry of muted.stillRan) {
    lines.push(`  still runs: ${mutedEntryWords(entry)} (${stillRunsWords(entry.why)})`);
  }
  for (const entry of muted.alsoLifted ?? []) {
    lines.push(`  also lifts: ${alsoLiftedWords(entry)}`);
  }
  // A sentence of its own: what of the sets' grants or the rules was not read.
  for (const unread of muted.liftsUnread ?? []) lines.push(`  ${liftsUnreadWords(unread)}`);
  if (muted.released === true && muted.assigned.length > 0) {
    lines.push(`  taken back: ${muted.assigned.join(', ')}, as the run ended`);
  } else if (muted.released === false) {
    lines.push(`  not taken back: ${muted.reason ?? 'the assignments stay until the lease ends'}`);
  }
  return lines;
}
