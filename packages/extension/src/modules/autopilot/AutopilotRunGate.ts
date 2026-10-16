/**
 * What an Autopilot run is held to before it writes: the records its plan
 * counts, against `sandforge.safety.confirmAboveRecords` and the data storage
 * the target has left — Forge's write gate (`ForgeRunGate`), on the plan.
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

import type { ExecutionPlan } from '@sandforge/shared';
import type {
  RunConfirmationAnswer,
  SafetyTier,
  WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { largeVolumeThreshold } from '../../core/precheck/ProductionGuard.js';
import {
  confirmationStorageOf,
  storageCheckOf,
  storageRefusal,
  writePlanOf,
  type DataStorage,
  type StorageCheck,
  type WritePlan,
} from '../forge/ForgeRunGate.js';

/**
 * The records a plan writes, per object, and the data storage they take: the
 * plan's counts, as a run of whole tables counts before it reads anything.
 *
 * @param plan - The plan, whose waves name the objects it writes.
 * @param recordCounts - The records of each, as the scan counted them.
 */
export function autopilotWritePlan(
  plan: Pick<ExecutionPlan, 'waves'>,
  recordCounts: ReadonlyMap<string, number>,
): WritePlan {
  return writePlanOf(
    plan.waves
      .flatMap((wave) => wave.objects)
      .map((objectApiName) => ({
        objectApiName,
        rows: [],
        counted: { rows: recordCounts.get(objectApiName) ?? 0 },
      })),
  );
}

/** Why a run's gate stopped it: Forge's codes for the same stops. */
export type AutopilotGateCode = 'STORAGE_EXCEEDED' | 'WRITE_DECLINED' | 'CONFIRMATION_UNAVAILABLE';

/** What the gate came to: the run goes on, or it stops before its first write, and why. */
export type AutopilotGateOutcome =
  | { go: true; check: StorageCheck; asked: boolean }
  | { go: false; code: AutopilotGateCode; message: string; check: StorageCheck };

/**
 * Hold a plan to the gate, as the panel holds it: refused past the storage
 * the target has left; asked about past `confirmAboveRecords` records, near
 * that storage, or when the target would not say what it has left; let
 * through otherwise.
 *
 * @param input.plan - The records the plan writes ({@link autopilotWritePlan}).
 * @param input.storage - What the target said of its storage, or why it said nothing.
 * @param input.confirmAboveRecords - The volume past which the run asks; 0 never asks.
 * @param input.confirm - Puts the question (`ProductionGuard.confirmRun`).
 */
export async function gateAutopilotWrite(input: {
  plan: WritePlan;
  storage: DataStorage | { unread: string };
  confirmAboveRecords: number;
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
  const threshold = input.confirmAboveRecords;
  const aboveRecords = threshold > 0 && plan.totalRows > threshold ? threshold : undefined;
  if (aboveRecords === undefined && check.verdict === 'fits') {
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
