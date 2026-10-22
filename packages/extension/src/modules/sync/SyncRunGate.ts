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
  SyncWriteCheck,
} from '@sandforge/shared';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  confirmationStorageOf,
  countedTargetEmails,
  emailRefusal,
  formatMB,
  overEmailOf,
  storageCheckOf,
  writePlanOf,
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

/** What a run writes, as counted before its first write. */
export interface SyncCountedWrite {
  objects: SyncCountedObject[];
  /** Records an earlier run of the configuration copied, left as they are and not counted. */
  alreadyCopied: number;
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
  if (plan.totalRows > 0) {
    storage = storageCheckOf(
      plan,
      await measures.readStorage().catch((err: unknown) => ({
        unread: err instanceof Error ? err.message : String(err),
      })),
    );
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
  const verdict: SyncWriteCheck['verdict'] =
    total === 0
      ? 'writes'
      : storage.verdict === 'exceeds'
        ? 'refused'
        : aboveRecords !== undefined ||
            (plan.totalRows > 0 && storage.verdict !== 'fits') ||
            emails.some((check) => check.verdict === 'exceeds')
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
    verdict,
  };
  return { check, plan, storage, emails };
}

/**
 * Why a run's gate stopped it before its first write: the code it is stopped
 * with on the error channel, each worded by the page in the interface
 * language (`error-hints.ts`) — Forge's gate codes, under Sync's name.
 */
export type SyncGateCode =
  | 'SYNC_STORAGE_EXCEEDED'
  | 'SYNC_EMAILS_EXCEEDED'
  | 'SYNC_WRITE_DECLINED'
  | 'SYNC_CONFIRMATION_UNAVAILABLE';

/**
 * Who answers for a run before it writes:
 * - `ask`: a run from the page, a re-run or a Quick Sync, whose user is
 *   asked past the setting's volume, near the storage, when the storage could
 *   not be read, or past a daily email limit;
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
  const { check, storage, emails, plan } = measured;
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
  if (input.policy !== 'ask') {
    const over = emailRefusal(emails, input.org);
    return over
      ? { go: false, code: 'SYNC_EMAILS_EXCEEDED', message: `${over} Nothing was written.` }
      : { go: true, asked: false };
  }
  if (check.verdict === 'writes') return { go: true, asked: false };
  const line = largeVolumeThreshold(input.orgTier);
  const overEmails = emails.filter((email) => email.verdict === 'exceeds').map(overEmailOf);
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
        ...(check.alreadyCopied > 0 ? { alreadyCopied: check.alreadyCopied } : {}),
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
