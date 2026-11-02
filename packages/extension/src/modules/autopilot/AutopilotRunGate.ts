/**
 * What an Autopilot run is held to before it writes: the records its plan
 * counts, against `sandforge.safety.confirmAboveRecords`, the data storage
 * the target has left, the daily emails its flows would send for them and
 * whether the target delivers them — Forge's write gate (`ForgeRunGate`), on
 * the plan.
 *
 * Autopilot consulted the Production Guard and nothing else. Run for real
 * with plan only, a plan of 2.6 million records for a target with 22 MB of
 * data storage left would have gone straight to "executing… (REAL)": nothing
 * looked at either figure, where a Forge clone is asked about past the
 * setting and refused past the storage.
 *
 * Kept apart from the executor, so the bridge and the command line read it
 * without loading it.
 */

import type {
  CheckpointRefusal,
  ExecutionPlan,
  ForgeEmailLimit,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import type { BeforeRunTake } from '../checkpoint/beforeRunCheckpoint.js';
import type { RUN_CANCELLED } from '../forge/forgeAudit.js';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  apiBudgetCheckOf,
  apiBudgetRefusal,
  checkpointPartOf,
  checkpointScopeStop,
  confirmationApiOf,
  confirmationStorageOf,
  countedTargetEmails,
  deliverabilityPartOf,
  overEmailOf,
  runRequestsEstimate,
  type RunRequestParts,
  storageCheckOf,
  storageRefusal,
  takeCheckpointFirst,
  writePlanOf,
  type ApiBudget,
  type ApiBudgetCheck,
  type DataStorage,
  type EmailCheck,
  type EmailLimit,
  type StorageCheck,
  type CHECKPOINT_REFUSED,
  type TargetEmails,
  type WritePlan,
} from '../forge/ForgeRunGate.js';
import { runEmailsSaidOf, type RunEmailsSaid } from '../forge/runEmailsSaid.js';
import type { RunEmails } from '../forge/targetDeliverability.js';

/**
 * The records a plan writes, per object, and the data storage they take: the
 * plan's counts, as a run of whole tables counts before it reads anything,
 * sized as Forge sizes them (`countedStorageBytes`) — a person account at
 * 4 KB, being an account and a contact, and its contact at nothing of its
 * own, the platform writing it with the account.
 *
 * Every record went at 2 KB: a plan of person accounts said half the storage
 * they take.
 *
 * @param plan - The plan, whose waves name the objects it writes.
 * @param recordCounts - The records of each, as the scan counted them.
 * @param personAccounts - Of the accounts and contacts, how many are person
 *   accounts or their contacts, as the scan counted them.
 */
export function autopilotWritePlan(
  plan: Pick<ExecutionPlan, 'waves'>,
  recordCounts: ReadonlyMap<string, number>,
  personAccounts: ReadonlyMap<string, number> = new Map(),
): WritePlan {
  return writePlanOf(
    plan.waves
      .flatMap((wave) => wave.objects)
      .map((objectApiName) => {
        const persons = personAccounts.get(objectApiName);
        return {
          objectApiName,
          rows: [],
          counted: {
            rows: recordCounts.get(objectApiName) ?? 0,
            ...(persons !== undefined ? { personAccounts: persons } : {}),
          },
        };
      }),
  );
}

/** The objects a plan writes, each once, in the order of its waves. */
export function objectsThePlanWrites(plan: Pick<ExecutionPlan, 'waves'>): string[] {
  return [...new Set(plan.waves.flatMap((wave) => wave.objects.map(String)))];
}

/** The emails a plan makes the target send, per daily limit, or why they could not be said. */
export type AutopilotEmails = TargetEmails;

/**
 * The emails the target's automation sends as a plan inserts its records,
 * against the daily limits the target has left: Forge's email check, on the
 * plan's counts (`countedTargetEmails`). What runs on the objects the plan
 * writes is read as Forge reads it, through the target automation reader,
 * and the limits only when something sends.
 *
 * Autopilot read none of the target's automation: a plan of contacts into a
 * Developer Edition, whose contact flow sends two emails a record, would have
 * taken it past its fifteen single emails a day, and every contact past them
 * would have been refused by its flow (`CANNOT_EXECUTE_FLOW_TRIGGER`), with
 * nothing said before the run.
 *
 * @param input.readAutomation - What the target runs on the given objects.
 * @param input.readLimits - The target's daily email limits, as `/limits` say them.
 */
export async function autopilotEmails(input: {
  plan: WritePlan;
  objects: readonly string[];
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
}): Promise<AutopilotEmails> {
  return countedTargetEmails(input);
}

/** The limits a plan's emails go past, as a run's question names them. */
function overEmailsOf(checks: readonly EmailCheck[]): NonNullable<WriteConfirmation['emails']> {
  return checks.filter((check) => check.verdict === 'exceeds').map(overEmailOf);
}

/** The limits a plan's emails are counted against that the target did not say it has left of. */
function unreadEmailsOf(
  checks: readonly EmailCheck[],
): NonNullable<WriteConfirmation['emailsUnread']> {
  return checks
    .filter((check) => check.verdict === 'unread')
    .map((check) => ({ limit: check.limit, emails: check.emails, unread: check.unread ?? '' }));
}

/**
 * The requests a run sends once its writes are through to read back the
 * record type the target gave the records it created without one: one an
 * object, at most, of those the plan writes records of — the `readBack` part
 * of its API requests. A run read them back, up to one an object, and none of
 * them was counted.
 */
export function autopilotReadBackOf(plan: Pick<WritePlan, 'objects'>): number {
  return plan.objects.filter(({ rows }) => rows > 0).length;
}

/**
 * The plan's calls against the daily API requests the target has left, read
 * from the same `/limits` as its storage, or on their own when the storage
 * could not be, as Sync reads them: a Standard User's `/limits` list the
 * daily requests and not the storage, and the run took both for unread. The
 * checkpoint the run takes first reads the target too, and so do the reads
 * back of the record types given and the read of whether the target delivers
 * its emails: their requests are counted beside the plan's.
 *
 * @param readApiBudget - The target's daily API requests, read on their own.
 * @param checkpoint - What the checkpoint taken first would cost; absent when not asked.
 * @param parts - The reads back ({@link autopilotReadBackOf}) and the read of
 *   the deliverability (`deliverabilityPartOf`); absent or 0 when there are none.
 */
export async function autopilotApiCheck(
  plan: Pick<WritePlan, 'objects'>,
  storage: DataStorage | { unread: string },
  readApiBudget: () => Promise<ApiBudget>,
  checkpoint?: Pick<RunCheckpointEstimate, 'estimate'>,
  parts: Pick<RunRequestParts, 'readBack' | 'deliverability'> = {},
): Promise<ApiBudgetCheck> {
  const budget =
    'unread' in storage
      ? await readApiBudget().catch((err: unknown) => ({
          unread: err instanceof Error ? err.message : String(err),
        }))
      : storage.dailyApiRequests;
  const { readBack = 0, deliverability = 0 } = parts;
  return apiBudgetCheckOf(
    {
      run: runRequestsEstimate(plan.objects.map(({ rows }) => ({ rows }))),
      ...checkpointPartOf(checkpoint),
      ...(readBack > 0 ? { readBack } : {}),
      ...(deliverability > 0 ? { deliverability } : {}),
    },
    budget,
  );
}

/** Why a run's gate stopped it: Forge's codes for the same stops. */
export type AutopilotGateCode =
  'STORAGE_EXCEEDED' | 'API_BUDGET_EXCEEDED' | 'WRITE_DECLINED' | 'CONFIRMATION_UNAVAILABLE';

/**
 * Why the gate of a plan that takes a checkpoint first stopped it for that
 * checkpoint: refused at its scope or at its take, or the take failed
 * (`CHECKPOINT_REFUSED`); the run's Stop while the take read (`RUN_CANCELLED`).
 */
export type AutopilotCheckpointCode = typeof CHECKPOINT_REFUSED | typeof RUN_CANCELLED;

/**
 * What the gate came to: the run goes on, or it stops before its first
 * write, and why. A run that goes on names the checkpoint it took first.
 * `emails` is what became of its emails: what the check after the lease and
 * the audit entry read; absent when there is nothing to say of them.
 */
export type AutopilotGateOutcome =
  | {
      go: true;
      check: StorageCheck;
      asked: boolean;
      checkpoint?: RunCheckpointTaken;
      emails?: RunEmailsSaid;
    }
  | {
      go: false;
      code: AutopilotGateCode;
      message: string;
      check: StorageCheck;
      emails?: RunEmailsSaid;
    };

/**
 * What the gate of a plan that takes a checkpoint first came to: as
 * {@link AutopilotGateOutcome}, or stopped for its checkpoint, with the
 * take's own refusal when it refused. Typed apart, so that a host that asks
 * for no checkpoint has no stop of one to word.
 */
export type AutopilotCheckpointGateOutcome =
  | AutopilotGateOutcome
  | {
      go: false;
      code: AutopilotCheckpointCode;
      message: string;
      check: StorageCheck;
      refusal?: CheckpointRefusal;
      emails?: RunEmailsSaid;
    };

/**
 * The checkpoint a plan is asked to take of what it writes before its first
 * write (`Checkpoint first`), as its gate holds it: what its scope said at
 * the gate, through the port of the checkpoints bound to the run, and the
 * take, which the gate makes once the question is answered.
 */
export interface AutopilotCheckpointFirst {
  /**
   * What it would hold and cost: the objects the plan writes, and those the
   * flows that still run create as it inserts and updates them.
   */
  estimate: RunCheckpointEstimate;
  /** The take, held to what the gate said it takes; the mute's lease comes after it. */
  take(planned: RunCheckpointEstimate): Promise<BeforeRunTake>;
}

/** What a plan is held to at its gate: see {@link gateAutopilotWrite}. */
export interface AutopilotGateInput {
  plan: WritePlan;
  storage: DataStorage | { unread: string };
  readApiBudget: () => Promise<ApiBudget>;
  confirmAboveRecords: number;
  emails?: readonly EmailCheck[];
  emailsUncounted?: string;
  org: string;
  orgTier: SafetyTier;
  confirm: (question: WriteConfirmation) => Promise<RunConfirmationAnswer>;
  checkpointFirst?: AutopilotCheckpointFirst;
  /**
   * The requests the run sends to read back the record types the target
   * gave ({@link autopilotReadBackOf}); absent or 0 when there are none.
   */
  readBack?: number;
  /**
   * What the plan's emails came to at their gate: what still runs that may
   * send one once the mute's plan holds, and whether the target delivers
   * them, read only when something may (`runEmailsOf`). Absent when nothing
   * was read.
   */
  runEmails?: RunEmails;
}

/**
 * Hold a plan to the gate, as the panel holds it: refused past the storage
 * the target has left; asked about past `confirmAboveRecords` records, near
 * that storage, when the target would not say what it has left, past a
 * daily email limit the target's flows would send against, as Forge's gate
 * asks, or when what the target runs could not be read, as Sync's asks; let
 * through otherwise.
 *
 * Asked to take a checkpoint first, the plan is refused before its question
 * when the checkpoint's scope was refused, its requests are counted with the
 * plan's, and it is always asked: the checkpoint reads whole tables of the
 * target, not the plan's records, and the question says its cost before
 * anything is taken. Once the question is answered, the gate takes it —
 * before the mute's lease, which its caller takes on a plan let through —
 * and a take refused, failed or stopped stops the plan with nothing written.
 *
 * @param input.plan - The records the plan writes ({@link autopilotWritePlan}).
 * @param input.storage - What the target said of its storage, or why it said nothing.
 * @param input.readApiBudget - The daily API requests the target has, as its
 *   `/limits` say: read when the storage could not be.
 * @param input.confirmAboveRecords - The volume past which the run asks; 0 never asks.
 * @param input.emails - The emails the plan makes the target send ({@link autopilotEmails}).
 * @param input.emailsUncounted - Why some of them were not counted: what of
 *   the target's automation could not be read (`AutopilotEmails.unread`).
 * @param input.confirm - Puts the question (`ProductionGuard.confirmRun`).
 * @param input.checkpointFirst - The checkpoint the plan takes first; absent when not asked.
 * @param input.runEmails - What its emails are judged on: where the target
 *   delivers them, or would not say, the plan is asked about them first, and
 *   the answer sends them ("Execute and send the emails").
 */
export function gateAutopilotWrite(
  input: AutopilotGateInput & { checkpointFirst?: undefined },
): Promise<AutopilotGateOutcome>;
export function gateAutopilotWrite(
  input: AutopilotGateInput,
): Promise<AutopilotCheckpointGateOutcome>;
export async function gateAutopilotWrite(
  input: AutopilotGateInput,
): Promise<AutopilotCheckpointGateOutcome> {
  const { plan } = input;
  const check = storageCheckOf(plan, input.storage);
  if (plan.totalRows === 0) return { go: true, check, asked: false };
  const checkpoint = input.checkpointFirst?.estimate;
  const refused = checkpointScopeStop(checkpoint);
  if (refused) return { go: false, ...refused, check };
  const refusal = storageRefusal(check, input.org);
  if (refusal) {
    return {
      go: false,
      code: 'STORAGE_EXCEEDED',
      message: `${refusal} Nothing was written.`,
      check,
    };
  }
  // Refused past the daily API requests the target has left, as the run
  // would stop part way through: the checkpoint's among them, the reads back
  // of the record types given and the read of the deliverability.
  const api = await autopilotApiCheck(plan, input.storage, input.readApiBudget, checkpoint, {
    ...(input.readBack !== undefined ? { readBack: input.readBack } : {}),
    ...deliverabilityPartOf(input.runEmails?.ofRun),
  });
  const overBudget = apiBudgetRefusal(api, input.org);
  if (overBudget) return { go: false, code: 'API_BUDGET_EXCEEDED', message: overBudget, check };
  const threshold = input.confirmAboveRecords;
  const aboveRecords = threshold > 0 && plan.totalRows > threshold ? threshold : undefined;
  const overEmails = overEmailsOf(input.emails ?? []);
  // A limit the target would not say what it has left of is asked about, as
  // storage it would not say is: said only in the log, nobody saw it.
  const unreadEmails = unreadEmailsOf(input.emails ?? []);
  // And so is an automation that could not be read, whose emails were not
  // counted at all, as a Sync run asks: Autopilot logged it and wrote.
  const uncounted = input.emailsUncounted;
  // And so are the emails of what still runs, where the target delivers
  // them or would not say: the answer to the question sends them.
  const emailsGate = input.runEmails?.gate;
  const delivered = emailsGate?.verdict === 'asks';
  // The checkpoint asked first is taken once the plan may write: after its
  // question, before the lease its caller takes.
  const go = async (asked: boolean): Promise<AutopilotCheckpointGateOutcome> => {
    const emails = runEmailsSaidOf(emailsGate, asked && delivered);
    const first = input.checkpointFirst;
    if (first === undefined) return { go: true, check, asked, ...emails };
    const took = await takeCheckpointFirst(() => first.take(first.estimate));
    return 'stop' in took
      ? { go: false, ...took.stop, check, ...emails }
      : { go: true, check, asked, checkpoint: took.checkpoint, ...emails };
  };
  if (
    aboveRecords === undefined &&
    check.verdict === 'fits' &&
    overEmails.length === 0 &&
    unreadEmails.length === 0 &&
    uncounted === undefined &&
    checkpoint === undefined &&
    !delivered
  ) {
    return go(false);
  }
  const line = largeVolumeThreshold(input.orgTier);
  const answer = await input.confirm({
    stage: 'write',
    module: 'autopilot',
    org: input.org,
    orgTier: input.orgTier,
    objects: plan.objects.map(({ objectApiName, rows }) => ({ objectApiName, rows })),
    total: plan.totalRows,
    ...(aboveRecords !== undefined ? { aboveRecords } : {}),
    ...(line !== undefined && plan.totalRows > line ? { largeVolume: line } : {}),
    storage: confirmationStorageOf(check),
    counted: true,
    ...(overEmails.length > 0 ? { emails: overEmails } : {}),
    ...(unreadEmails.length > 0 ? { emailsUnread: unreadEmails } : {}),
    ...(uncounted !== undefined ? { emailsUncounted: uncounted } : {}),
    ...confirmationApiOf(api),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...emailsGate?.confirmation,
  });
  if (answer === 'confirmed') return go(true);
  const unsent = runEmailsSaidOf(emailsGate, false);
  return answer === 'declined'
    ? {
        go: false,
        code: 'WRITE_DECLINED',
        message: 'The Autopilot run was cancelled before it wrote anything. Nothing was written.',
        check,
        ...unsent,
      }
    : {
        go: false,
        code: 'CONFIRMATION_UNAVAILABLE',
        message:
          'The Autopilot run needed a confirmation before it wrote, and there was no one to ' +
          'ask. Nothing was written.',
        check,
        ...unsent,
      };
}
