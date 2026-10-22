/**
 * What an Autopilot run is held to before it writes: the records its plan
 * counts, against `sandforge.safety.confirmAboveRecords`, the data storage
 * the target has left and the daily emails its flows would send for them —
 * Forge's write gate (`ForgeRunGate`), on the plan.
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

import type { ExecutionPlan, ForgeEmailLimit, ForgeTargetAutomation } from '@sandforge/shared';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  apiBudgetCheckOf,
  apiBudgetRefusal,
  confirmationApiOf,
  confirmationStorageOf,
  countedTargetEmails,
  overEmailOf,
  runRequestsEstimate,
  storageCheckOf,
  storageRefusal,
  writePlanOf,
  type DataStorage,
  type EmailCheck,
  type EmailLimit,
  type StorageCheck,
  type TargetEmails,
  type WritePlan,
} from '../forge/ForgeRunGate.js';

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

/** Why a run's gate stopped it: Forge's codes for the same stops. */
export type AutopilotGateCode =
  'STORAGE_EXCEEDED' | 'API_BUDGET_EXCEEDED' | 'WRITE_DECLINED' | 'CONFIRMATION_UNAVAILABLE';

/** What the gate came to: the run goes on, or it stops before its first write, and why. */
export type AutopilotGateOutcome =
  | { go: true; check: StorageCheck; asked: boolean }
  | { go: false; code: AutopilotGateCode; message: string; check: StorageCheck };

/**
 * Hold a plan to the gate, as the panel holds it: refused past the storage
 * the target has left; asked about past `confirmAboveRecords` records, near
 * that storage, when the target would not say what it has left, or past a
 * daily email limit the target's flows would send against, as Forge's gate
 * asks; let through otherwise.
 *
 * @param input.plan - The records the plan writes ({@link autopilotWritePlan}).
 * @param input.storage - What the target said of its storage, or why it said nothing.
 * @param input.confirmAboveRecords - The volume past which the run asks; 0 never asks.
 * @param input.emails - The emails the plan makes the target send ({@link autopilotEmails}).
 * @param input.confirm - Puts the question (`ProductionGuard.confirmRun`).
 */
export async function gateAutopilotWrite(input: {
  plan: WritePlan;
  storage: DataStorage | { unread: string };
  confirmAboveRecords: number;
  emails?: readonly EmailCheck[];
  org: string;
  orgTier: SafetyTier;
  confirm: (question: WriteConfirmation) => Promise<RunConfirmationAnswer>;
}): Promise<AutopilotGateOutcome> {
  const { plan } = input;
  const check = storageCheckOf(plan, input.storage);
  if (plan.totalRows === 0) return { go: true, check, asked: false };
  const refusal = storageRefusal(check, input.org);
  if (refusal) {
    return {
      go: false,
      code: 'STORAGE_EXCEEDED',
      message: `${refusal} Nothing was written.`,
      check,
    };
  }
  // Its calls against the daily API requests the target has left, read
  // from the same `/limits` as its storage: refused past them, as the run
  // would stop part way through.
  const api = apiBudgetCheckOf(
    runRequestsEstimate(plan.objects.map(({ rows }) => ({ rows }))),
    'unread' in input.storage ? input.storage : input.storage.dailyApiRequests,
  );
  const overBudget = apiBudgetRefusal(api, input.org);
  if (overBudget) return { go: false, code: 'API_BUDGET_EXCEEDED', message: overBudget, check };
  const threshold = input.confirmAboveRecords;
  const aboveRecords = threshold > 0 && plan.totalRows > threshold ? threshold : undefined;
  const overEmails = overEmailsOf(input.emails ?? []);
  // A limit the target would not say what it has left of is asked about, as
  // storage it would not say is: said only in the log, nobody saw it.
  const unreadEmails = unreadEmailsOf(input.emails ?? []);
  if (
    aboveRecords === undefined &&
    check.verdict === 'fits' &&
    overEmails.length === 0 &&
    unreadEmails.length === 0
  ) {
    return { go: true, check, asked: false };
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
    ...confirmationApiOf(api),
  });
  if (answer === 'confirmed') return { go: true, check, asked: true };
  return answer === 'declined'
    ? {
        go: false,
        code: 'WRITE_DECLINED',
        message: 'The Autopilot run was cancelled before it wrote anything. Nothing was written.',
        check,
      }
    : {
        go: false,
        code: 'CONFIRMATION_UNAVAILABLE',
        message:
          'The Autopilot run needed a confirmation before it wrote, and there was no one to ' +
          'ask. Nothing was written.',
        check,
      };
}
