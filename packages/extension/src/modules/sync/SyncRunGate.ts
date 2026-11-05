/**
 * What a Sync run is held to before it writes: the records it writes, counted
 * object by object under each filter before anything is read, against
 * `sandforge.safety.confirmAboveRecords`, the data storage the target has
 * left, the daily emails the target's automation sends as they go in, and
 * whether the target delivers them — Forge's write gate (`ForgeRunGate`), as
 * Seed and Autopilot hold their runs.
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
  CheckpointRefusal,
  ForgeAutomationWrite,
  ForgeEmailLimit,
  ForgeTargetAutomation,
  MutedAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
  StillRunning,
  SyncOperation,
  SyncUnwritableReason,
  SyncWriteCheck,
} from '@sandforge/shared';
import { emailSendersOf, stillRunningOf } from '@sandforge/shared';
import type { BeforeRunTake } from '../checkpoint/beforeRunCheckpoint.js';
import { beforeRunFailedWords } from '../checkpoint/beforeRunCheckpoint.js';
import type { ForgeWriteGateAnswer } from '../forge/ForgeExecutor.js';
import type { RUN_CANCELLED } from '../forge/forgeAudit.js';
import {
  isMuteRefusedError,
  type HeldMute,
  type MuteRefusalCode,
  type RunMute,
} from '../forge/AutomationMuteLease.js';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  API_BUDGET_EXCEEDED,
  CHECKPOINT_REFUSED,
  apiBudgetCheckOf,
  apiBudgetRefusal,
  checkpointPartOf,
  checkpointScopeStop,
  confirmationApiOf,
  confirmationStorageOf,
  countedTargetEmails,
  deliverabilityAfterLeaseStop,
  deliverabilityPartOf,
  emailRefusal,
  formatMB,
  overEmailOf,
  runRequestsEstimate,
  storageCheckOf,
  takeCheckpointFirst,
  unreadEmailOf,
  writePlanOf,
  type ApiBudget,
  type ApiBudgetCheck,
  type DataStorage,
  type EmailCheck,
  type EMAILS_NOT_ACCEPTED,
  type EmailLimit,
  type StorageCheck,
  type WritePlan,
} from '../forge/ForgeRunGate.js';
import { emailsRefusalWords, runEmailsSaidOf, type RunEmailsSaid } from '../forge/runEmailsSaid.js';
import type { SyncHeldBackObject } from './syncHeldBack.js';
import {
  heldPlanOf,
  runEmailsOf,
  type DeliverabilityRead,
  type RunEmails,
  type RunEmailsInput,
} from '../forge/targetDeliverability.js';

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
  /** Of `notAKey`: the field the upsert matches on. */
  key?: string;
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
  /**
   * The rows of the objects written after one of `unwritable` that the run
   * holds back, a lookup of theirs naming a record left out, or a row held
   * back in turn (`heldBackOf`): counted apart from `objects`, whose rows
   * leave them out. Absent when none.
   */
  heldBack?: SyncHeldBackObject[];
  /**
   * The requests the run sends once its writes are through to read back the
   * record type the target gave the records it created without one: the
   * `readBack` part of its API requests, at most. Absent when there is none
   * to read.
   */
  readBack?: number;
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
  /** The data storage the target has, as its `/limits` say, and its daily API requests with it. */
  readStorage: () => Promise<DataStorage>;
  /** The daily API requests the target has, as its `/limits` say: read when the storage could not be. */
  readApiBudget: () => Promise<ApiBudget>;
  /** What the target runs on the given objects, as Forge reads it. */
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /** The target's daily email limits, as its `/limits` say them. */
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
  /**
   * Whether the target delivers the emails its automation sends
   * (`readEmailDeliverability`): read only when something that still runs may
   * send one, as the user the run writes as.
   */
  readDeliverability: () => Promise<DeliverabilityRead>;
  /**
   * Who the gate on its emails names, and what answers for them: `accepted`
   * is the accord of a run nobody is asked about, `--accept-emails` or the
   * Approval before a pipeline's step, for which nothing else stands.
   */
  emails: Pick<RunEmailsInput, 'target' | 'accepted' | 'keepsAddresses' | 'mayMute'>;
  /** `sandforge.safety.confirmAboveRecords`: the volume past which a run asks; 0 never asks. */
  confirmAboveRecords: number;
  /** The checkpoint the run takes of what it writes before its first write; absent when not asked. */
  checkpointFirst?: SyncCheckpointFirst;
}

/**
 * The checkpoint a run is asked to take of what it writes before its first
 * write (`Checkpoint first`), as its gate holds it: the port of the
 * checkpoints (`BeforeRunCheckpoints`) bound to the run, whose own mark does
 * not refuse the take.
 */
export interface SyncCheckpointFirst {
  /**
   * What it would hold and cost, at the gate, reading no record: the objects
   * the run writes, every operation together — a rewind deletes what was
   * created since, gives back what was changed and brings back what was
   * deleted — and what still runs as it writes them once the mute's plan
   * holds, whose creations it holds too.
   */
  scope(
    written: readonly string[],
    running: Pick<StillRunning<unknown>, 'firing'>,
  ): Promise<RunCheckpointEstimate>;
  /** The take, once the question is answered and before the mute's lease, held to what the gate said it takes. */
  take(planned: RunCheckpointEstimate): Promise<BeforeRunTake>;
}

/** A run's write, measured against the target before its first write. */
export interface MeasuredSyncWrite {
  /** What the page shows of it, and what the run comes to when asked from the page. */
  check: SyncWriteCheck;
  /** The records it creates and their storage. */
  plan: WritePlan;
  storage: StorageCheck;
  emails: EmailCheck[];
  /** Its calls against the daily API requests the target has left, the checkpoint's among them. */
  api: ApiBudgetCheck;
  /**
   * What the checkpoint it takes first would hold and cost, and the refusal a
   * real run would meet. Absent when not asked, or for a run that writes nothing.
   */
  checkpoint?: RunCheckpointEstimate;
  /** Why the checkpoint's scope could not be read, in the run's words: the run is refused. */
  checkpointFailed?: string;
  /** What its emails came to at the gate: absent for a run that writes nothing. */
  runEmails?: RunEmails;
  /** Whether it came with the accord for them ({@link SyncWriteMeasures.emails}). */
  emailsAccepted: boolean;
}

/**
 * What a run's writes fire, object by object, as its operations make them:
 * an insert, an update, both for an upsert, a delete as a mirror deletes.
 * An object it only updates fires nothing that runs on an insert of it, and
 * what that would create is no part of what a rewind takes back.
 */
export function syncWritesOf(
  counted: Pick<SyncCountedWrite, 'objects'>,
): (objectApiName: string, write: ForgeAutomationWrite) => boolean {
  const writes = new Map<string, Set<ForgeAutomationWrite>>();
  for (const { objectApiName, operation } of counted.objects) {
    const of = writes.get(objectApiName) ?? new Set<ForgeAutomationWrite>();
    if (operation === 'insert' || operation === 'upsert') of.add('insert');
    if (operation === 'update' || operation === 'upsert') of.add('update');
    if (operation === 'delete') of.add('delete');
    writes.set(objectApiName, of);
  }
  return (objectApiName, write) => writes.get(objectApiName)?.has(write) === true;
}

/** What the target runs on `objects`, of a read that holds them and maybe more. */
function automationOn(
  read: ForgeTargetAutomation,
  objects: readonly string[],
): ForgeTargetAutomation {
  const wanted = new Set(objects);
  return {
    ...read,
    objectsRead: read.objectsRead.filter((name) => wanted.has(name)),
    objects: read.objects.filter((object) => wanted.has(object.objectApiName)),
  };
}

/**
 * The target's automation read once for a run's gate: what still runs is read
 * on every object the run writes, and the emails it counts on those it
 * creates, which that read holds already.
 */
function readOnce(read: SyncWriteMeasures['readAutomation']): SyncWriteMeasures['readAutomation'] {
  let first: { objects: readonly string[]; answer: Promise<ForgeTargetAutomation> } | undefined;
  return (objects) => {
    if (first && objects.every((name) => first?.objects.includes(name))) {
      return first.answer.then((answer) => automationOn(answer, objects));
    }
    const answer = read(objects);
    first ??= { objects: [...objects], answer };
    return answer;
  };
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
  // What still runs as the run writes — what the mute keeps quiet held quiet,
  // when the run mutes — read once: the checkpoint it takes first is scoped
  // from it, and what may send an email is found in it, before its requests
  // are counted: both are among them. An object it only updates or deletes
  // sends all the same.
  const readAutomation = total > 0 ? readOnce(measures.readAutomation) : measures.readAutomation;
  let checkpoint: RunCheckpointEstimate | undefined;
  let checkpointFailed: string | undefined;
  let runEmails: RunEmails | undefined;
  const writes = syncWritesOf(counted);
  let read: RunEmailsInput['read'] | undefined;
  if (total > 0) {
    const written = counted.objects
      .filter((object) => object.rows > 0)
      .map((object) => object.objectApiName);
    read = await readAutomation(written).catch((err: unknown) => ({
      unread: err instanceof Error ? err.message : String(err),
    }));
    if (measures.checkpointFirst) {
      // What could not be read creates nothing the scope can name: the
      // checkpoint then holds the objects the run writes, and the question
      // says what it cannot know.
      const running = 'objects' in read ? stillRunningOf(read, undefined, writes) : { firing: [] };
      try {
        checkpoint = await measures.checkpointFirst.scope(written, running);
      } catch (err: unknown) {
        checkpointFailed = beforeRunFailedWords(err);
      }
    }
  }
  // The calls of its writes to the target, against its daily requests, read
  // with the storage: its reads are of the source, whose own budget they take.
  let budget: ApiBudget | { unread: string } | undefined = { unread: 'not read' };
  if (total > 0) {
    const limits = await measures.readStorage().catch((err: unknown) => ({
      unread: err instanceof Error ? err.message : String(err),
    }));
    // Read on their own when the storage could not be, as Forge reads them: a
    // Standard User's `/limits` list the daily requests and not the storage,
    // and the run said neither could be read.
    budget =
      'unread' in limits
        ? await measures.readApiBudget().catch((err: unknown) => ({
            unread: err instanceof Error ? err.message : String(err),
          }))
        : limits.dailyApiRequests;
    if (plan.totalRows > 0) storage = storageCheckOf(plan, limits);
  }
  if (plan.totalRows > 0) {
    const said = await countedTargetEmails({
      plan,
      objects: plan.objects.map((object) => object.objectApiName),
      readAutomation,
      readLimits: measures.readLimits,
    });
    emails = said.checks;
    emailsUnread = said.unread;
  }
  // Whether the target delivers the emails of what still runs, read last
  // before the question, and only when something may send one: a run with
  // nothing left to send sends no request for it.
  if (read !== undefined) {
    runEmails = await runEmailsOf({
      ...measures.emails,
      read,
      writes,
      readDeliverability: measures.readDeliverability,
      run: 'sync',
    });
  }
  // The checkpoint's reads, the read-backs of the record types given and the
  // read of the deliverability are the target's, and are counted beside the
  // run's own.
  const api: ApiBudgetCheck = apiBudgetCheckOf(
    {
      run: runRequestsEstimate(objects),
      ...checkpointPartOf(checkpoint),
      ...(counted.readBack !== undefined && counted.readBack > 0
        ? { readBack: counted.readBack }
        : {}),
      ...deliverabilityPartOf(runEmails?.ofRun),
    },
    budget,
  );
  const threshold = measures.confirmAboveRecords;
  const aboveRecords = threshold > 0 && total > threshold ? threshold : undefined;
  const unwritable = (counted.unwritable ?? []).map(({ objectApiName, rows, why, key }) => ({
    ...(key !== undefined ? { key } : {}),
    objectApiName,
    rows,
    why,
  }));
  const heldBack = (counted.heldBack ?? []).map(
    ({ objectApiName, rows, parent, field, parents }) => ({
      objectApiName,
      rows,
      parent,
      field,
      ...(parents !== undefined ? { parents: parents.map((one) => ({ ...one })) } : {}),
    }),
  );
  // Emails the target would not say it has room for are asked about, as
  // storage it would not say is, and so is an automation that could not be
  // read, whose emails were not counted at all: the page said both and the
  // run went on without a word to the user who started it.
  // A checkpoint asked first is asked about: it reads whole tables of the
  // target, not the run's rows, and the question says its cost before
  // anything is taken. Refused at its scope, it refuses the run.
  // Emails the target delivers, or would not say it withholds, are asked
  // about whoever answers: what stands for the answer is the gate's to take.
  const emailsGate = runEmails?.gate;
  const verdict: SyncWriteCheck['verdict'] =
    total === 0
      ? unwritable.length > 0
        ? 'refused'
        : 'writes'
      : storage.verdict === 'exceeds' ||
          api.verdict === 'exceeds' ||
          checkpointFailed !== undefined ||
          checkpoint?.refusal !== undefined
        ? 'refused'
        : aboveRecords !== undefined ||
            unwritable.length > 0 ||
            (plan.totalRows > 0 && storage.verdict !== 'fits') ||
            emails.some((check) => check.verdict !== 'fits') ||
            emailsUnread !== undefined ||
            checkpoint !== undefined ||
            emailsGate?.verdict === 'asks'
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
    ...(emailsGate?.deliverability ? { deliverability: emailsGate.deliverability } : {}),
    ...(unwritable.length > 0 ? { unwritable } : {}),
    ...(heldBack.length > 0 ? { heldBack } : {}),
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
    ...(checkpointFailed !== undefined ? { checkpointUnread: checkpointFailed } : {}),
  };
  return {
    check,
    plan,
    storage,
    emails,
    api,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(checkpointFailed !== undefined ? { checkpointFailed } : {}),
    ...(runEmails !== undefined ? { runEmails } : {}),
    emailsAccepted: measures.emails.accepted,
  };
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
  | typeof EMAILS_NOT_ACCEPTED
  | 'SYNC_WRITE_DECLINED'
  | 'SYNC_CONFIRMATION_UNAVAILABLE'
  | typeof CHECKPOINT_REFUSED
  | typeof RUN_CANCELLED
  | MuteRefusalCode;

/**
 * Who answers for a run before it writes:
 * - `ask`: a run from the page, a re-run or a Quick Sync, whose user is
 *   asked past the setting's volume, near the storage, when the storage could
 *   not be read, past a daily email limit, when what is left of one, or the
 *   target's automation, could not be read, or when the target would deliver
 *   the emails of what still runs: the answer then sends them;
 * - `unattended`: a schedule's or a pipeline's run, which nobody watches: it
 *   is refused past a daily email limit, where every record past it would be
 *   refused by the flow that sends, and where the target would deliver the
 *   emails of what still runs unless an Approval answered for them; it goes
 *   on otherwise, as it was set up;
 * - `refuse`: the command line, refused past either limit, as a clone is, and
 *   for those emails without `--accept-emails`.
 *
 * Past the storage the target has left, every one of them is refused.
 */
export type SyncGatePolicy = 'ask' | 'unattended' | 'refuse';

/**
 * What the gate came to: the run goes on, or it stops before its first
 * write, and why. `checkpoint` is the checkpoint it took first: the run's to
 * point at once it has written, and to delete when it stops before writing
 * — its lease refused after the take — as it then wrote nothing.
 * `refusal` is the take's own refusal of one stopped for its checkpoint.
 * `emails` is what became of its emails: what the check after the lease and
 * the audit entry read. Absent when there is nothing to say of them.
 */
export type SyncGateAnswer =
  | { go: true; asked: boolean; checkpoint?: RunCheckpointTaken; emails?: RunEmailsSaid }
  | {
      go: false;
      code: SyncGateCode;
      message: string;
      refusal?: CheckpointRefusal;
      checkpoint?: RunCheckpointTaken;
      emails?: RunEmailsSaid;
    };

/** A reason the gate stops a run before its first write, as its answer carries it. */
export type SyncGateStop = Omit<Extract<SyncGateAnswer, { go: false }>, 'go'>;

/**
 * Every reason the gate stops a measured run for before any question is put,
 * in the order it meets them: an object the target takes none of, the
 * checkpoint asked first, the data storage, the API requests, and, for a run
 * nobody answers for, the emails past a daily limit and those the target
 * delivers. {@link gateSyncWrite} stops the run with the first; the command
 * line names each other one beside it. Stopped for the first alone, a run of
 * the command line said one code, and a CI job that answered it was refused
 * again for the next.
 */
export function syncGateStops(
  measured: MeasuredSyncWrite,
  input: { policy: SyncGatePolicy; org: string; emailsLiftedBy?: string },
): SyncGateStop[] {
  const { check, storage, emails, plan, api } = measured;
  const stops: SyncGateStop[] = [];
  // An object the target takes none of stops the run unless the user, asked,
  // leaves it out: nobody watches a scheduled run or the command line, and a
  // run with nothing else to write has nothing to go on with.
  const unwritable = check.unwritable ?? [];
  if (unwritable.length > 0 && (input.policy !== 'ask' || check.total === 0)) {
    stops.push({
      code: 'SYNC_TARGET_UNWRITABLE',
      message: unwritableRefusal(unwritable, input.org, check.heldBack),
    });
  }
  if (check.total === 0) return stops;
  // The checkpoint asked first, refused at its scope or unread: the run is
  // refused before its question, whoever answers for it, as the option
  // promised a rewind the run could not then have.
  if (measured.checkpointFailed !== undefined) {
    stops.push({ code: CHECKPOINT_REFUSED, message: measured.checkpointFailed });
  } else {
    const refused = checkpointScopeStop(measured.checkpoint);
    if (refused) stops.push(refused);
  }
  if (plan.totalRows > 0 && storage.verdict === 'exceeds') {
    stops.push({
      code: 'SYNC_STORAGE_EXCEEDED',
      message:
        `The records to write take about ${formatMB(storage.estimateMB)} MB of data storage, ` +
        `and ${input.org} has ${storage.remainingMB} MB left of ${storage.maxMB} MB: leave ` +
        `objects out, narrow their filters, or free data storage in ${input.org}. Nothing was ` +
        'written.',
    });
  }
  // Past the requests the target has left today, whoever answers for it: it
  // would stop part way through, its records refused with REQUEST_LIMIT_EXCEEDED.
  const overBudget = apiBudgetRefusal(api, input.org);
  if (overBudget) stops.push({ code: API_BUDGET_EXCEEDED, message: overBudget });
  if (input.policy !== 'ask') {
    const over = emailRefusal(emails, input.org);
    if (over) {
      stops.push({ code: 'SYNC_EMAILS_EXCEEDED', message: `${over} Nothing was written.` });
    }
    // Past the limits no accord helps: said first, as what no flag lifts.
    const emailsGate = measured.runEmails?.gate;
    const stop = emailsGate?.stop;
    if (stop) {
      stops.push({
        code: stop.code,
        message: emailsRefusalWords(stop.message, 'sync', input.emailsLiftedBy),
        ...runEmailsSaidOf(emailsGate, false),
      });
    }
  }
  return stops;
}

/**
 * Hold a measured run to its policy: see {@link SyncGatePolicy}.
 *
 * @param input.org - The target, as the user knows it.
 * @param input.confirm - Puts the question (`ProductionGuard.confirmRun`); only the `ask` policy puts one.
 * @param input.emailsLiftedBy - What lifts the refusal for the emails where
 *   the run runs, where it is no flag (`emailsRefusalWords`).
 */
export async function gateSyncWrite(
  measured: MeasuredSyncWrite,
  input: {
    policy: SyncGatePolicy;
    org: string;
    orgTier: SafetyTier;
    confirm?: (question: WriteConfirmation) => Promise<RunConfirmationAnswer>;
    emailsLiftedBy?: string;
  },
): Promise<SyncGateAnswer> {
  const { check, storage, emails, api } = measured;
  const [stop] = syncGateStops(measured, input);
  if (stop) return { go: false, ...stop };
  if (check.total === 0) return { go: true, asked: false };
  const emailsGate = measured.runEmails?.gate;
  if (input.policy !== 'ask') {
    return { go: true, asked: false, ...runEmailsSaidOf(emailsGate, measured.emailsAccepted) };
  }
  const unwritable = check.unwritable ?? [];
  if (check.verdict === 'writes') {
    return { go: true, asked: false, ...runEmailsSaidOf(emailsGate, false) };
  }
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
        // Left out of `objects`, and written none of: the question that
        // leaves their parent out says them, as its refusal does.
        ...(check.heldBack !== undefined && check.heldBack.length > 0
          ? { heldBack: check.heldBack }
          : {}),
        ...confirmationApiOf(api),
        ...(measured.checkpoint !== undefined ? { checkpoint: measured.checkpoint } : {}),
        ...emailsGate?.confirmation,
      })
    : 'unavailable';
  if (answer === 'confirmed') {
    // The question said them: its answer is the accord, and only then.
    return {
      go: true,
      asked: true,
      ...runEmailsSaidOf(emailsGate, emailsGate?.verdict === 'asks'),
    };
  }
  const unsent = runEmailsSaidOf(emailsGate, false);
  return answer === 'declined'
    ? {
        go: false,
        code: 'SYNC_WRITE_DECLINED',
        message: 'The sync was cancelled before it wrote anything. Nothing was written.',
        ...unsent,
      }
    : {
        go: false,
        code: 'SYNC_CONFIRMATION_UNAVAILABLE',
        message:
          'The sync needed a confirmation before it wrote, and there was no one to ask. ' +
          'Nothing was written.',
        ...unsent,
      };
}

/** Why the target takes none of an object's records, in a sentence of the refusal. */
const UNWRITABLE_WHY: Record<SyncUnwritableReason, (org: string, key?: string) => string> = {
  notInTarget: (org) => `${org} has no such object, or the user the run writes as cannot see it`,
  notCreateable: (org) => `the user the run writes as may not create its records in ${org}`,
  notUpdateable: (org) => `the user the run writes as may not edit its records in ${org}`,
  unread: (org) => `${org} did not describe it, so what it takes could not be told`,
  notAKey: (org, key) =>
    `its upsert matches on ${key ?? 'a field'}, neither an External ID nor an idLookup field in ${org}`,
};

/**
 * The refusal of a run some of whose objects the target takes none of: each
 * named, with why and its records, the rows of the objects after them it
 * would hold back, and what to do. A run went on to write the objects before
 * them, then had every record of theirs refused.
 *
 * @param heldBack - The rows the objects left out would hold back: refused
 *   with no word of them, a run named the account it could not write and not
 *   the contacts it would write none of.
 */
export function unwritableRefusal(
  unwritable: ReadonlyArray<{
    objectApiName: string;
    rows: number;
    why: SyncUnwritableReason;
    key?: string;
  }>,
  org: string,
  heldBack: ReadonlyArray<{
    objectApiName: string;
    rows: number;
    parent: string;
    field: string;
    parents?: ReadonlyArray<{ parent: string; field: string; rows: number }>;
  }> = [],
): string {
  const named = unwritable
    .map(
      ({ objectApiName, rows, why, key }) =>
        `${objectApiName} (${rows} record${rows === 1 ? '' : 's'}): ${UNWRITABLE_WHY[why](org, key)}`,
    )
    .join('; ');
  const pronoun = unwritable.length === 1 ? 'it' : 'them';
  // No access lifts a key the target does not match on. Where both kinds
  // stand, each way names the objects it lifts: one sentence of access for
  // all of them sent the user to give access that left the key refused.
  const keyed = unwritable.filter(({ why }) => why === 'notAKey');
  const closed = unwritable.filter(({ why }) => why !== 'notAKey');
  const mixed = keyed.length > 0 && closed.length > 0;
  const namesOf = (objects: typeof unwritable): string =>
    objects.map(({ objectApiName }) => objectApiName).join(' and ');
  const access = `give the user SandForge writes as access to ${mixed ? namesOf(closed) : pronoun} in ${org}`;
  const key = `match ${mixed ? `${namesOf(keyed)} ` : ''}on an External ID field of ${org}`;
  const way = mixed ? `${access}, or ${key}` : keyed.length > 0 ? `or ${key}` : `or ${access}`;
  const leftOut = new Set(unwritable.map(({ objectApiName }) => objectApiName));
  const whose = ({ parent, field }: { parent: string; field: string }): string =>
    `whose ${field} names ${/^[aeiou]/i.test(parent) ? 'an' : 'a'} ${parent} record ` +
    (leftOut.has(parent) ? 'left out' : 'held back');
  // Each object and lookup with its rows: named by the first alone, the
  // refusal said 13 prices held back by Pricebook2Id where 9 were by Product2Id.
  const held = heldBack
    .flatMap(({ objectApiName, rows, parent, field, parents }) =>
      (parents ?? [{ parent, field, rows }]).map(
        (one) => `${one.rows} ${objectApiName} record${one.rows === 1 ? '' : 's'}, ${whose(one)}`,
      ),
    )
    .join('; ');
  return (
    `${org} would take no record of ${unwritable.length === 1 ? 'one object' : `${unwritable.length} objects`} ` +
    `the sync writes — ${named}.` +
    (held !== '' ? ` Left out, ${pronoun === 'it' ? 'it holds' : 'they hold'} back ${held}.` : '') +
    ` Leave ${pronoun} out of the run, ${way}. Nothing was written.`
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
      const answer = await gateSyncWrite(measured, decide);
      return {
        check: measured.check,
        answer: await takeSyncCheckpoint(measured, answer, measures.checkpointFirst),
      };
    },
  };
}

/**
 * The take of the checkpoint a run asked for first, once its gate let it
 * write: after its question, so that nothing others change while a person
 * reads it is held as the run's T0, and before the mute's lease, which a run
 * that takes it after its gate (`mutingSyncWriteGate`) takes last. Refused,
 * failed, or stopped by the run's Stop, it stops the run with nothing
 * written and nothing assigned; a run that writes nothing takes none.
 */
export async function takeSyncCheckpoint(
  measured: Pick<MeasuredSyncWrite, 'checkpoint'>,
  answer: SyncGateAnswer,
  checkpointFirst: Pick<SyncCheckpointFirst, 'take'> | undefined,
): Promise<SyncGateAnswer> {
  const planned = measured.checkpoint;
  if (!answer.go || planned === undefined || checkpointFirst === undefined) return answer;
  const took = await takeCheckpointFirst(() => checkpointFirst.take(planned));
  return 'stop' in took ? { go: false, ...took.stop } : { ...answer, checkpoint: took.checkpoint };
}

/** What a run writes of each object it writes: it inserts, upserts, updates — and deletes, mirroring. */
export function syncRunWrites(_objectApiName: string, write: ForgeAutomationWrite): boolean {
  return write === 'insert' || write === 'update' || write === 'delete';
}

/** A Sync run's gate that mutes the target's automation, and how its lease is given back. */
export interface MutingSyncWriteGate {
  gate: SyncWriteGate;
  /**
   * Give the lease back once the run ends, whatever it ended on: what the
   * run muted, or undefined when it never reached its gate.
   */
  release(): Promise<MutedAutomation | undefined>;
  /**
   * The lease the gate took as it let the run write, as Forge's write gate
   * answers it: how many permission sets it assigned the user the run writes
   * as, and how to give it back — right after the last write, before the run
   * reads back the record types the target gave, so that the bypass is held
   * no longer than the writes. Undefined until the gate took one, and for a
   * run with nothing to mute. Given back so, the lease is not given back
   * twice: `release` then answers what it gave back.
   */
  lease(): ForgeWriteGateAnswer['lease'];
}

/**
 * The gate of a run asked to mute the target's automation. As the gate holds
 * the run, before its first write, the mute is planned from what the target
 * runs on the objects it writes (`plan`), and the gate measures the run on
 * that read with what the mute keeps quiet held quiet: what still runs is
 * what it counts the emails of, and what the checkpoint it takes first holds
 * the creations of. Once the gate lets the run write and the checkpoint is
 * taken, the lease is: the shortest window the bypass is held, and none at
 * all for a run whose checkpoint is refused. Refused — a production org, a
 * user who cannot assign, a set that cannot be assigned — the run stops at
 * its gate, nothing written, and its answer names the checkpoint taken
 * before the lease was refused, for the run to delete. Read back, a lease
 * that does not hold a set it was to assign may leave running a sender no
 * one was asked about: the run stops the same way.
 *
 * @param build - The run's gate, over the reader of the target's automation it is given.
 * @param plan - The mute of a run writing the objects read; throws `MuteRefusedError` when refused.
 * @param emails.target - The org, as the refusal for the emails names it.
 * @param emails.liftedBy - What lifts that refusal where the run runs, where it is no flag.
 */
export function mutingSyncWriteGate(
  build: (readAutomation: SyncWriteMeasures['readAutomation']) => SyncWriteGate,
  readAutomation: SyncWriteMeasures['readAutomation'],
  plan: (read: RunEmailsInput['read']) => Promise<RunMute>,
  runId: string,
  emails: { target: string; liftedBy?: string },
): MutingSyncWriteGate {
  let mute: RunMute | undefined;
  let held: HeldMute | undefined;
  let muted: MutedAutomation | undefined;
  /** What the target runs on the objects the run writes, before the mute holds it. */
  let automation: RunEmailsInput['read'] | undefined;
  const gate = build(async (objects) => {
    const view = mute?.automation;
    if (view && objects.every((name) => view.objectsRead.includes(name))) {
      return automationOn(view, objects);
    }
    return readAutomation(objects);
  });
  const refusedBy = (err: unknown): SyncGateAnswer => {
    if (!isMuteRefusedError(err)) throw err;
    return { go: false, code: err.code, message: err.message };
  };
  return {
    gate: {
      measure: (counted) => gate.measure(counted),
      hold: async (counted) => {
        const objects = counted.objects
          .filter((object) => object.rows > 0)
          .map((object) => object.objectApiName);
        if (!mute && objects.length > 0) {
          automation = await readAutomation(objects).catch((err: unknown) => ({
            unread: err instanceof Error ? err.message : String(err),
          }));
          try {
            mute = await plan(automation);
            muted = mute.muted;
          } catch (err: unknown) {
            return { check: await gate.measure(counted), answer: refusedBy(err) };
          }
        }
        const answer = await gate.hold(counted);
        if (answer.answer.go && mute?.prepared && !held) {
          try {
            held = await mute.prepared.acquire(runId);
            muted = held.outcome;
          } catch (err: unknown) {
            const { checkpoint } = answer.answer;
            return {
              check: answer.check,
              answer: { ...refusedBy(err), ...(checkpoint ? { checkpoint } : {}) },
            };
          }
          // The lease read back against its plan, before the first write.
          const { checkpoint, emails: said } = answer.answer;
          const { deliverability } = answer.check;
          const writes = syncWritesOf(counted);
          const relit =
            mute.plan && automation && 'objects' in automation
              ? deliverabilityAfterLeaseStop({
                  planned: deliverability?.senders ?? [],
                  held: emailSendersOf(
                    stillRunningOf(automation, heldPlanOf(mute.plan, held.outcome), writes),
                    { writes },
                  ),
                  ...(deliverability ? { reading: deliverability.reading } : {}),
                  accepted: said?.accepted === true,
                  target: emails.target,
                  run: 'sync',
                })
              : undefined;
          if (relit) {
            return {
              check: answer.check,
              answer: {
                go: false,
                code: relit.code,
                message: emailsRefusalWords(relit.message, 'sync', emails.liftedBy),
                ...(checkpoint ? { checkpoint } : {}),
                ...(said ? { emails: said } : {}),
              },
            };
          }
        }
        return answer;
      },
    },
    release: async () => {
      if (held) muted = await held.release();
      return muted;
    },
    lease: () => {
      const taken = held;
      if (!taken) return undefined;
      return {
        assigned: taken.outcome.assigned.length,
        giveBack: async () => {
          muted = await taken.release();
          return muted;
        },
      };
    },
  };
}
