/**
 * Where a sandbox stands after its refresh, step by step, deduced from what
 * SandForge keeps of it (`recoveryFacts.ts`): never ticked by hand. A person
 * skips a step, or marks done the two checks made by eye in Setup — the
 * deliverability and the endpoints —; every other step is done when what it
 * runs has run on the org the sandbox is now.
 *
 * Each step says why it stands where it does by a code the page translates,
 * in the order `sandforge env apply` takes them. A step a person skipped and
 * then ran is done; a step that does not apply to this sandbox stays so,
 * skipped or not.
 *
 * A sandbox marked Staging replays the checkpoint of before as any other:
 * its replay asks for the org's name typed under the simulation, and is
 * never refused for the mark (D7).
 */

import {
  recoveryProgressOf,
  type RecoveryAcks,
  type RecoveryPreparation,
  type RecoveryReason,
  type RecoveryStatus,
  type RecoveryStep,
  type RecoveryStepId,
  type RecoveryStepStatus,
} from '@sandforge/shared';

/** What SandForge keeps of a sandbox, read on this machine: what the steps are deduced from. */
export interface RecoveryFacts {
  /** The registered entry. */
  orgId: string;
  /** Its name, as the page names it. */
  alias: string;
  tier: RecoveryStatus['tier'];
  /** What kind of org it is, as the registry holds it. */
  kind: 'sandbox' | 'scratch' | 'developer';
  sandboxType?: NonNullable<RecoveryStatus['sandboxType']>;
  myDomainHost?: string;
  /** The Organization Id the sandbox is now; unknown while only production reported its refresh. */
  organizationId?: string;
  /** The refresh noticed last, as the page shows it. */
  refresh?: NonNullable<RecoveryStatus['refresh']>;
  /** What a person skipped, marked done, or finished, and when. */
  acks: RecoveryAcks;
  /** The newest checkpoint of the org before the refresh, taken to its end. */
  checkpointBefore?: NonNullable<RecoveryStatus['checkpointBefore']>;
  /** When a replay of a checkpoint of the org before last wrote into the org now. */
  replayedAt?: string;
  /** The checkpoints of the org now taken to their end, newest first. */
  checkpointsNow: ReadonlyArray<{ takenAt: string; keptUntilDeleted: boolean }>;
  /** The last users run of the org now that ended. */
  lastUsersRun?: NonNullable<RecoveryStatus['lastUsersRun']>;
  /**
   * Set when a removal of that run put back what it set up (`sandforge users
   * remove`): the users are no longer as the run left them.
   */
  lastUsersRunTakenBack?: true;
  /** How many users the last list read of the org now found to bring back. */
  usersToBringBack?: number;
  /** When a masking run of the sandbox since the refresh ended a success, the newest. */
  maskedAt?: string;
  /** The objects the last masking of the sandbox, else of this machine, addressed. */
  maskObjects?: NonNullable<RecoveryStatus['maskObjects']>;
  /** When a load of the frozen dataset into the sandbox since the refresh ended a success, the newest. */
  frozenLoadedAt?: string;
  frozenManifest?: NonNullable<RecoveryStatus['frozenManifest']>;
  /** The inventory of the jobs kept of the org before, of the sandbox's host. */
  inventoryBefore?: NonNullable<RecoveryStatus['inventoryBefore']>;
  /** When an inventory of the jobs of the org now was kept. */
  inventoryNowAt?: string;
  /** When a handoff note of the org now was written. */
  handoffAt?: string;
  /** When the testers to bring back were kept for the sandbox. */
  testersSavedAt?: string;
  /** Whether a saved pipeline starts on the sandbox's refresh. */
  refreshPipeline?: boolean;
}

/** One step, its status and the code of why, and when it was done. */
function stepOf(
  id: RecoveryStepId,
  status: RecoveryStepStatus,
  reason: RecoveryReason,
  at?: string,
): RecoveryStep {
  return { id, status, reason, ...(at !== undefined ? { at } : {}) };
}

/** A step done by what ran, else skipped, else to do. */
function ranOrSkipped(id: RecoveryStepId, facts: RecoveryFacts, ranAt?: string): RecoveryStep {
  if (ranAt !== undefined) return stepOf(id, 'done', 'ranAfterRefresh', ranAt);
  if (facts.acks.steps[id as keyof RecoveryAcks['steps']] === 'skipped') {
    return stepOf(id, 'skipped', 'skipped');
  }
  return stepOf(id, 'todo', 'toDo');
}

/** A check made by eye: marked done, skipped, or to do. */
function markedOrSkipped(id: 'deliverability' | 'endpoints', facts: RecoveryFacts): RecoveryStep {
  const mark = facts.acks.steps[id];
  if (mark === 'done') return stepOf(id, 'done', 'markedDone');
  if (mark === 'skipped') return stepOf(id, 'skipped', 'skipped');
  return stepOf(id, 'todo', 'toDo');
}

/** Whether nothing of production was copied into the org: nothing to mask. */
function nothingCopied(facts: RecoveryFacts): boolean {
  if (facts.kind !== 'sandbox') return true;
  return facts.sandboxType === 'Developer' || facts.sandboxType === 'DeveloperPro';
}

/** The steps, in the order the page lists them. */
function stepsOf(facts: RecoveryFacts): RecoveryStep[] {
  const testersStart = facts.checkpointsNow.at(-1);
  return [
    facts.refresh !== undefined
      ? stepOf('refresh', 'done', 'refreshDetected', facts.refresh.detectedAt)
      : stepOf('refresh', 'notApplicable', 'noRefreshDetected'),
    facts.lastUsersRun?.status !== 'success' && facts.usersToBringBack === 0
      ? stepOf('users', 'notApplicable', 'noUserToBringBack')
      : ranOrSkipped(
          'users',
          facts,
          facts.lastUsersRun?.status === 'success' && facts.lastUsersRunTakenBack !== true
            ? facts.lastUsersRun.at
            : undefined,
        ),
    nothingCopied(facts)
      ? stepOf('masking', 'notApplicable', 'nothingCopied')
      : ranOrSkipped('masking', facts, facts.maskedAt),
    facts.checkpointBefore === undefined
      ? stepOf('replay', 'notApplicable', 'noCheckpointBefore')
      : ranOrSkipped('replay', facts, facts.replayedAt),
    facts.frozenManifest === undefined
      ? stepOf('frozen', 'notApplicable', 'noManifest')
      : ranOrSkipped('frozen', facts, facts.frozenLoadedAt),
    ranOrSkipped('testersCheckpoint', facts, testersStart?.takenAt),
    markedOrSkipped('deliverability', facts),
    facts.inventoryBefore === undefined
      ? stepOf('scheduledJobs', 'notApplicable', 'noInventoryBefore')
      : ranOrSkipped('scheduledJobs', facts, facts.inventoryNowAt),
    markedOrSkipped('endpoints', facts),
    ranOrSkipped('handoff', facts, facts.handoffAt),
  ];
}

/** One thing to keep before the next refresh: kept already, and when, or to do. */
function preparationOf(
  id: RecoveryPreparation['id'],
  done: boolean,
  at?: string,
): RecoveryPreparation {
  return done
    ? { id, status: 'done', reason: 'ready', ...(at !== undefined ? { at } : {}) }
    : { id, status: 'todo', reason: 'toDo' };
}

/** What to keep before the next refresh, in the order the page lists it. */
function preparationsOf(facts: RecoveryFacts): RecoveryPreparation[] {
  // The next recovery replays the newest checkpoint of the org now: kept
  // until deleted, it is still there whenever the refresh comes.
  const newest = facts.checkpointsNow[0];
  return [
    preparationOf('beforeRefreshCheckpoint', newest?.keptUntilDeleted === true, newest?.takenAt),
    preparationOf('jobsInventory', facts.inventoryNowAt !== undefined, facts.inventoryNowAt),
    preparationOf('testersList', facts.testersSavedAt !== undefined, facts.testersSavedAt),
    preparationOf('automation', facts.refreshPipeline === true),
  ];
}

/** Where the sandbox stands: see the module's comment. */
export function recoveryStatusOf(facts: RecoveryFacts): RecoveryStatus {
  const steps = stepsOf(facts);
  const { done, total } = recoveryProgressOf(steps);
  // The objects Masking opens with are offered while there is something to mask.
  const maskObjects = nothingCopied(facts) ? undefined : facts.maskObjects;
  return {
    orgId: facts.orgId,
    alias: facts.alias,
    tier: facts.tier,
    ...(facts.sandboxType !== undefined ? { sandboxType: facts.sandboxType } : {}),
    ...(facts.myDomainHost !== undefined ? { myDomainHost: facts.myDomainHost } : {}),
    ...(facts.organizationId !== undefined ? { organizationId: facts.organizationId } : {}),
    ...(facts.refresh !== undefined ? { refresh: facts.refresh } : {}),
    ...(facts.checkpointBefore !== undefined ? { checkpointBefore: facts.checkpointBefore } : {}),
    ...(facts.frozenManifest !== undefined ? { frozenManifest: facts.frozenManifest } : {}),
    ...(facts.inventoryBefore !== undefined ? { inventoryBefore: facts.inventoryBefore } : {}),
    ...(maskObjects !== undefined ? { maskObjects } : {}),
    // A note kept is opened again whether the step was skipped or not.
    ...(facts.handoffAt !== undefined ? { handoffNote: { writtenAt: facts.handoffAt } } : {}),
    ...(facts.acks.finishedAt !== undefined ? { finishedAt: facts.acks.finishedAt } : {}),
    ...(facts.lastUsersRun !== undefined ? { lastUsersRun: facts.lastUsersRun } : {}),
    steps,
    beforeNextRefresh: preparationsOf(facts),
    done,
    total,
  };
}
