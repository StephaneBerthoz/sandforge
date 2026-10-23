/**
 * What a Sync run is held to before it writes: the records it writes, counted
 * object by object under each filter before anything is read, against
 * `sandforge.safety.confirmAboveRecords`, the data storage the target has
 * left, and the daily emails the target's automation sends as they go in —
 * Forge's write gate (`ForgeRunGate`), as Seed and Autopilot hold their runs.
 *
 * Sync was the one path between two orgs that checked nothing before it
 * wrote: Production Guard was judged on an unknown count, and a Developer
 * Edition — a development org, which the guard never asks about — is not
 * one it refuses. A Quick Sync of 3 000 contacts into one, with 5 MB of data
 * storage and fifteen single emails a day, met both limits part way through,
 * its records refused one by one after a partial write; Forge, Seed and
 * Autopilot would have refused it before writing anything.
 *
 * Kept apart from the orchestrator, so the bridge and the command line read
 * it without loading the sync engine.
 */

import type {
  ForgeEmailLimit,
  ForgeTargetAutomation,
  SyncOperation,
  SyncUnwritableReason,
  SyncWriteCheck,
} from '@sandforge/shared';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  API_BUDGET_EXCEEDED,
  apiBudgetCheckOf,
  apiBudgetRefusal,
  confirmationApiOf,
  confirmationStorageOf,
  countedTargetEmails,
  emailRefusal,
  formatMB,
  overEmailOf,
  runRequestsEstimate,
  storageCheckOf,
  unreadEmailOf,
  writePlanOf,
  type ApiBudgetCheck,
  type DataStorage,
  type EmailCheck,
  type EmailLimit,
  type StorageCheck,
  type WritePlan,
} from '../forge/ForgeRunGate.js';

/** One object of a run, as counted before its first write. */
export interface SyncCountedObject {
  objectApiName: string;
  operation: SyncOperation;
  /** The records the run writes of it: those its filter reads, less those it leaves as they are. */
  rows: number;
  /** Of an account's or a contact's rows, those of person accounts: sized as Salesforce counts them. */
  personAccounts?: number;
}

/** An object of a run the target will take no record of as the run writes it, and why. */
export interface SyncUnwritableObject extends SyncCountedObject {
  why: SyncUnwritableReason;
}

/** What a run writes, as counted before its first write. */
export interface SyncCountedWrite {
  objects: SyncCountedObject[];
  /** Records an earlier run of the configuration copied, left as they are and not counted. */
  alreadyCopied: number;
  /**
   * The objects the target will take none of — it has not the object, or the
   * user the run writes as may not see, create or edit it — counted apart
   * from `objects`. Absent when none.
   */
  unwritable?: SyncUnwritableObject[];
}

/** Whether an object's write creates records: an insert, or an upsert that may. */
function creates(operation: SyncOperation): boolean {
  return operation === 'insert' || operation === 'upsert';
}

/**
 * Whether an object's write may write over records the target holds: an
 * update, every record it writes; an upsert, every one whose key it holds.
 */
function writesOver(operation: SyncOperation): boolean {
  return operation === 'update' || operation === 'upsert';
}

/**
 * The records a run creates, per object, and the data storage they take, as
 * Forge sizes them (`writePlanOf`): a person account at 4 KB, being an
 * account and a contact, its contact at nothing of its own. Every upsert is
 * counted as creating its records, which says too much rather than too
 * little; an update or a delete takes no storage.
 */
export function syncWritePlan(counted: SyncCountedWrite): WritePlan {
  return writePlanOf(
    counted.objects
      .filter((object) => creates(object.operation))
      .map(({ objectApiName, rows, personAccounts }) => ({
        objectApiName,
        rows: [],
        counted: { rows, ...(personAccounts !== undefined ? { personAccounts } : {}) },
      })),
  );
}

/** What a run's checks read of the target. */
export interface SyncWriteMeasures {
  /** The data storage the target has, as its `/limits` say. */
  readStorage: () => Promise<DataStorage>;
  /** What the target runs on the given objects, as Forge reads it. */
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /** The target's daily email limits, as its `/limits` say them. */
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
  /** `sandforge.safety.confirmAboveRecords`: the volume past which a run asks; 0 never asks. */
  confirmAboveRecords: number;
}

/** A run's write, measured against the target before its first write. */
export interface MeasuredSyncWrite {
  /** What the page shows of it, and what the run comes to when asked from the page. */
  check: SyncWriteCheck;
  /** The records it creates and their storage. */
  plan: WritePlan;
  storage: StorageCheck;
  emails: EmailCheck[];
  /** Its calls against the daily API requests the target has left. */
  api: ApiBudgetCheck;
}

/**
 * The records a run writes, measured: the records it creates against the
 * storage the target has left, and the emails its automation sends for them
 * against what it has left today. Nothing is read of the target for a run
 * that writes nothing.
 */
export async function measureSyncWrite(
  counted: SyncCountedWrite,
  measures: SyncWriteMeasures,
): Promise<MeasuredSyncWrite> {
  const plan = syncWritePlan(counted);
  const objects = counted.objects
    .filter((object) => object.rows > 0)
    .map(({ objectApiName, rows }) => ({ objectApiName, rows }))
    .sort((a, b) => b.rows - a.rows || a.objectApiName.localeCompare(b.objectApiName));
  const total = objects.reduce((sum, object) => sum + object.rows, 0);
  // Of them, what may write over a record the target holds: counted with the
  // rest against the setting's volume, and said apart, its values kept first.
  const overwrites = counted.objects
    .filter((object) => writesOver(object.operation))
    .reduce((sum, object) => sum + object.rows, 0);
  let storage: StorageCheck = storageCheckOf(plan, { maxMB: 0, remainingMB: 0 });
  let emails: EmailCheck[] = [];
  let emailsUnread: string | undefined;
  // The calls of its writes to the target, from the same `/limits` the
  // storage is read from: its reads are of the source, whose own budget they take.
  const estimate = runRequestsEstimate(objects);
  let api: ApiBudgetCheck = apiBudgetCheckOf(estimate, { unread: 'not read' });
  if (total > 0) {
    const limits = await measures.readStorage().catch((err: unknown) => ({
      unread: err instanceof Error ? err.message : String(err),
    }));
    api = apiBudgetCheckOf(estimate, 'unread' in limits ? limits : limits.dailyApiRequests);
    if (plan.totalRows > 0) storage = storageCheckOf(plan, limits);
  }
  if (plan.totalRows > 0) {
    const said = await countedTargetEmails({
      plan,
      objects: plan.objects.map((object) => object.objectApiName),
      readAutomation: measures.readAutomation,
      readLimits: measures.readLimits,
    });
    emails = said.checks;
    emailsUnread = said.unread;
  }
  const threshold = measures.confirmAboveRecords;
  const aboveRecords = threshold > 0 && total > threshold ? threshold : undefined;
  const unwritable = (counted.unwritable ?? []).map(({ objectApiName, rows, why }) => ({
    objectApiName,
    rows,
    why,
  }));
  // Emails the target would not say it has room for are asked about, as
  // storage it would not say is, and so is an automation that could not be
  // read, whose emails were not counted at all: the page said both and the
  // run went on without a word to the user who started it.
  const verdict: SyncWriteCheck['verdict'] =
    total === 0
      ? unwritable.length > 0
        ? 'refused'
        : 'writes'
      : storage.verdict === 'exceeds' || api.verdict === 'exceeds'
        ? 'refused'
        : aboveRecords !== undefined ||
            unwritable.length > 0 ||
            (plan.totalRows > 0 && storage.verdict !== 'fits') ||
            emails.some((check) => check.verdict !== 'fits') ||
            emailsUnread !== undefined
          ? 'asks'
          : 'writes';
  const check: SyncWriteCheck = {
    objects,
    total,
    alreadyCopied: counted.alreadyCopied,
    ...(overwrites > 0 ? { overwrites } : {}),
    ...(aboveRecords !== undefined ? { aboveRecords } : {}),
    storage:
      storage.verdict === 'unread'
        ? { verdict: 'unread', estimateMB: storage.estimateMB, unread: storage.unread }
        : plan.totalRows === 0
          ? { verdict: 'fits', estimateMB: 0 }
          : {
              verdict: storage.verdict,
              estimateMB: storage.estimateMB,
              maxMB: storage.maxMB,
              remainingMB: storage.remainingMB,
            },
    emails: emails.map((email) => ({
      limit: email.limit,
      emails: email.emails,
      verdict: email.verdict,
      ...(email.remaining !== undefined ? { remaining: email.remaining } : {}),
      ...(email.max !== undefined ? { max: email.max } : {}),
      ...(email.alertsCounted ? { alertsCounted: true as const } : {}),
      objects: email.objects.map(({ objectApiName, perRecord }) => ({ objectApiName, perRecord })),
      ...(email.unread !== undefined ? { unread: email.unread } : {}),
    })),
    ...(emailsUnread !== undefined ? { emailsUnread } : {}),
    ...(unwritable.length > 0 ? { unwritable } : {}),
    ...(total > 0
      ? {
          apiRequests:
            api.verdict === 'unread'
              ? { verdict: 'unread' as const, estimate: api.estimate, unread: api.unread }
              : {
                  verdict: api.verdict,
                  estimate: api.estimate,
                  remaining: api.remaining,
                  max: api.max,
                },
        }
      : {}),
    verdict,
  };
  return { check, plan, storage, emails, api };
}

/**
 * Why a run's gate stopped it before its first write: the code it is stopped
 * with on the error channel, each worded by the page in the interface
 * language (`error-hints.ts`) — Forge's gate codes, under Sync's name.
 */
export type SyncGateCode =
  | 'SYNC_STORAGE_EXCEEDED'
  | typeof API_BUDGET_EXCEEDED
  | 'SYNC_TARGET_UNWRITABLE'
  | 'SYNC_EMAILS_EXCEEDED'
  | 'SYNC_WRITE_DECLINED'
  | 'SYNC_CONFIRMATION_UNAVAILABLE';

/**
 * Who answers for a run before it writes:
 * - `ask`: a run from the page, a re-run or a Quick Sync, whose user is
 *   asked past the setting's volume, near the storage, when the storage could
 *   not be read, past a daily email limit, or when what is left of one, or
 *   the target's automation, could not be read;
 * - `unattended`: a schedule's or a pipeline's run, which nobody watches: it
 *   is refused past a daily email limit, where every record past it would be
 *   refused by the flow that sends, and goes on otherwise, as it was set up;
 * - `refuse`: the command line, refused past either limit, as a clone is.
 *
 * Past the storage the target has left, every one of them is refused.
 */
export type SyncGatePolicy = 'ask' | 'unattended' | 'refuse';

/** What the gate came to: the run goes on, or it stops before its first write, and why. */
export type SyncGateAnswer =
  { go: true; asked: boolean } | { go: false; code: SyncGateCode; message: string };

/**
 * Hold a measured run to its policy: see {@link SyncGatePolicy}.
 *
 * @param input.org - The target, as the user knows it.
 * @param input.confirm - Puts the question (`ProductionGuard.confirmRun`); only the `ask` policy puts one.
 */
export async function gateSyncWrite(
  measured: MeasuredSyncWrite,
  input: {
    policy: SyncGatePolicy;
    org: string;
    orgTier: SafetyTier;
    confirm?: (question: WriteConfirmation) => Promise<RunConfirmationAnswer>;
  },
): Promise<SyncGateAnswer> {
  const { check, storage, emails, plan, api } = measured;
  // An object the target takes none of stops the run unless the user, asked,
  // leaves it out: nobody watches a scheduled run or the command line, and a
  // run with nothing else to write has nothing to go on with.
  const unwritable = check.unwritable ?? [];
  if (unwritable.length > 0 && (input.policy !== 'ask' || check.total === 0)) {
    return {
      go: false,
      code: 'SYNC_TARGET_UNWRITABLE',
      message: unwritableRefusal(unwritable, input.org),
    };
  }
  if (check.total === 0) return { go: true, asked: false };
  if (plan.totalRows > 0 && storage.verdict === 'exceeds') {
    return {
      go: false,
      code: 'SYNC_STORAGE_EXCEEDED',
      message:
        `The records to write take about ${formatMB(storage.estimateMB)} MB of data storage, ` +
        `and ${input.org} has ${storage.remainingMB} MB left of ${storage.maxMB} MB: leave ` +
        `objects out, narrow their filters, or free data storage in ${input.org}. Nothing was ` +
        'written.',
    };
  }
  // Past the requests the target has left today, whoever answers for it: it
  // would stop part way through, its records refused with REQUEST_LIMIT_EXCEEDED.
  const overBudget = apiBudgetRefusal(api, input.org);
  if (overBudget) return { go: false, code: API_BUDGET_EXCEEDED, message: overBudget };
  if (input.policy !== 'ask') {
    const over = emailRefusal(emails, input.org);
    return over
      ? { go: false, code: 'SYNC_EMAILS_EXCEEDED', message: `${over} Nothing was written.` }
      : { go: true, asked: false };
  }
  if (check.verdict === 'writes') return { go: true, asked: false };
  const line = largeVolumeThreshold(input.orgTier);
  const overEmails = emails.filter((email) => email.verdict === 'exceeds').map(overEmailOf);
  const unreadEmails = emails.filter((email) => email.verdict === 'unread').map(unreadEmailOf);
  const answer = input.confirm
    ? await input.confirm({
        stage: 'write',
        module: 'sync',
        org: input.org,
        orgTier: input.orgTier,
        objects: check.objects,
        total: check.total,
        ...(check.aboveRecords !== undefined ? { aboveRecords: check.aboveRecords } : {}),
        ...(line !== undefined && check.total > line ? { largeVolume: line } : {}),
        storage: confirmationStorageOf(storage),
        counted: true,
        ...(check.overwrites !== undefined ? { overwrites: check.overwrites } : {}),
        ...(overEmails.length > 0 ? { emails: overEmails } : {}),
        ...(unreadEmails.length > 0 ? { emailsUnread: unreadEmails } : {}),
        ...(check.emailsUnread !== undefined ? { emailsUncounted: check.emailsUnread } : {}),
        ...(check.alreadyCopied > 0 ? { alreadyCopied: check.alreadyCopied } : {}),
        ...(unwritable.length > 0 ? { unwritable } : {}),
        ...confirmationApiOf(api),
      })
    : 'unavailable';
  if (answer === 'confirmed') return { go: true, asked: true };
  return answer === 'declined'
    ? {
        go: false,
        code: 'SYNC_WRITE_DECLINED',
        message: 'The sync was cancelled before it wrote anything. Nothing was written.',
      }
    : {
        go: false,
        code: 'SYNC_CONFIRMATION_UNAVAILABLE',
        message:
          'The sync needed a confirmation before it wrote, and there was no one to ask. ' +
          'Nothing was written.',
      };
}

/** Why the target takes none of an object's records, in a sentence of the refusal. */
const UNWRITABLE_WHY: Record<SyncUnwritableReason, (org: string) => string> = {
  notInTarget: (org) => `${org} has no such object, or the user the run writes as cannot see it`,
  notCreateable: (org) => `the user the run writes as may not create its records in ${org}`,
  notUpdateable: (org) => `the user the run writes as may not edit its records in ${org}`,
  unread: (org) => `${org} did not describe it, so what it takes could not be told`,
};

/**
 * The refusal of a run some of whose objects the target takes none of: each
 * named, with why and its records, and what to do. A run went on to write
 * the objects before them, then had every record of theirs refused.
 */
export function unwritableRefusal(
  unwritable: ReadonlyArray<{ objectApiName: string; rows: number; why: SyncUnwritableReason }>,
  org: string,
): string {
  const named = unwritable
    .map(
      ({ objectApiName, rows, why }) =>
        `${objectApiName} (${rows} records): ${UNWRITABLE_WHY[why](org)}`,
    )
    .join('; ');
  return (
    `${org} would take no record of ${unwritable.length === 1 ? 'one object' : `${unwritable.length} objects`} ` +
    `the sync writes — ${named}. Leave ${unwritable.length === 1 ? 'it' : 'them'} out of the run, or give ` +
    `the user SandForge writes as access to ${unwritable.length === 1 ? 'it' : 'them'} in ${org}. Nothing was written.`
  );
}

/**
 * What a run's checks are, as the orchestrator holds a run to them before
 * its first write (`SyncOrchestratorDeps.writeGate`), and measures a
 * simulation by them.
 */
export interface SyncWriteGate {
  /** Measure the records a simulation counted, asking nobody. */
  measure(counted: SyncCountedWrite): Promise<SyncWriteCheck>;
  /** Measure the records a run counted, and say whether it writes. */
  hold(counted: SyncCountedWrite): Promise<{ check: SyncWriteCheck; answer: SyncGateAnswer }>;
}

/**
 * A run's checks against one target, under one policy.
 *
 * @param measures - What is read of the target ({@link SyncWriteMeasures}).
 * @param decide - Who answers for the run ({@link gateSyncWrite}).
 */
export function syncWriteGate(
  measures: SyncWriteMeasures,
  decide: Parameters<typeof gateSyncWrite>[1],
): SyncWriteGate {
  return {
    measure: async (counted) => (await measureSyncWrite(counted, measures)).check,
    hold: async (counted) => {
      const measured = await measureSyncWrite(counted, measures);
      return { check: measured.check, answer: await gateSyncWrite(measured, decide) };
    },
  };
}
