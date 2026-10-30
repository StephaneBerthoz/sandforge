import type { PipelineStep } from '@sandforge/shared';
import { pipelineRewindStepConfigSchema, rewindGrantDigest } from '@sandforge/shared';
import * as z from 'zod';

import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/**
 * The confirmations of pipelines' Rewind steps kept on this machine: what a
 * person gave by typing the org's alias below the step's preview, which
 * stands, at each run of the pipeline, for the alias a rewind from the
 * Checkpoints page asks for.
 *
 * Kept in this machine's ConfigStore, under a category of its own, and never
 * in the pipeline's definition: a pipeline that came in a profile, from the
 * Marketplace or from the AI arrives with no confirmation, since nothing it
 * carries can be one. Each is bound to its step's configuration as saved
 * (`rewindGrantDigest`): a save that changes what the step does to the org
 * takes it back for good, and saving the old configuration again does not
 * bring it back. A profile import and a Marketplace install take back the
 * confirmations of the pipelines they write; a pipeline no longer saved, or a
 * checkpoint no longer kept, leaves its confirmations void, and they are
 * taken back once seen so.
 */

/** The ConfigStore category the confirmations are kept under: no profile export reads it. */
export const REWIND_GRANTS_CATEGORY = 'pipeline-rewind-grants';

/** The key of each confirmation: the pipeline's id, then the step's. */
const KEY_PREFIX = 'pipeline:rewind-grant:';

/** The key a saved pipeline is kept under, which a confirmation of its steps needs. */
const SAVED_PIPELINE_PREFIX = 'pipeline:saved:';

/**
 * A Rewind step's confirmation, as kept.
 * - `organizationId` is the Organization Id of the checkpoint's org, which
 *   the rewind is held to;
 * - `digest` is `rewindGrantDigest` of the step's configuration as saved when
 *   it was confirmed;
 * - `grantedBy` is the account VS Code ran under, as the audit trail names a
 *   user: a short hash, never the account's name.
 */
export interface RewindGrant {
  pipelineId: string;
  stepId: string;
  organizationId: string;
  checkpointId: string;
  digest: string;
  grantedAt: string;
  grantedBy?: string;
}

const rewindGrantSchema = z
  .object({
    pipelineId: z.string().min(1).max(200),
    stepId: z.string().min(1).max(200),
    organizationId: z.string().min(1).max(18),
    checkpointId: z.string().min(1).max(200),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    grantedAt: z.iso.datetime(),
    grantedBy: z.string().max(80).optional(),
  })
  .strict();

/** The confirmation a run holds a Rewind step to, once found given for the configuration it runs. */
export interface VerifiedGrant {
  organizationId: string;
  checkpointId: string;
  digest: string;
  grantedAt: string;
}

/**
 * Why a Rewind step may not run: it was never confirmed — no confirmation is
 * kept, its pipeline is not saved, its configuration does not read — or it
 * was, for a configuration other than the one it runs.
 */
export type GrantRefusal = 'never' | 'changed';

/**
 * The words a Rewind step is refused with for want of a confirmation: those
 * of the rewind's own refusal (`notConfirmedRefusal`), which a run that went
 * past the check would meet, so that the history reads the same either way.
 */
export function grantRefusalWords(stepName: string, refusal: GrantRefusal): string {
  return (
    `Rewind step "${stepName}" has ` +
    (refusal === 'changed' ? 'not been confirmed since it was changed' : 'never been confirmed') +
    ": open it and type the org's alias. No record was written."
  );
}

function keyOf(pipelineId: string, stepId: string): string {
  return `${KEY_PREFIX}${pipelineId}:${stepId}`;
}

/** The confirmations of pipelines' Rewind steps, in a machine's ConfigStore. */
export class RewindGrants {
  constructor(private readonly store: ConfigStore) {}

  /** Every confirmation kept that reads; one that does not is no confirmation. */
  all(): RewindGrant[] {
    return Object.values(this.store.getByCategory(REWIND_GRANTS_CATEGORY)).flatMap((value) => {
      const read = rewindGrantSchema.safeParse(value);
      return read.success ? [read.data] : [];
    });
  }

  /** The confirmation kept for a step, if one is and it reads. */
  get(pipelineId: string, stepId: string): RewindGrant | undefined {
    const read = rewindGrantSchema.safeParse(this.store.get<unknown>(keyOf(pipelineId, stepId)));
    return read.success ? read.data : undefined;
  }

  /** Keep `grant`, in place of any kept for its step. */
  write(grant: RewindGrant): void {
    this.store.set(
      keyOf(grant.pipelineId, grant.stepId),
      rewindGrantSchema.parse(grant),
      REWIND_GRANTS_CATEGORY,
    );
  }

  /** Take back the confirmation of a step; whether one was kept. */
  revoke(pipelineId: string, stepId: string): boolean {
    return this.store.delete(keyOf(pipelineId, stepId));
  }

  /** Take back every confirmation of a pipeline's steps; the ids of the steps that had one. */
  revokePipeline(pipelineId: string): string[] {
    const prefix = `${KEY_PREFIX}${pipelineId}:`;
    const revoked: string[] = [];
    for (const key of this.store.getKeysByPrefix(prefix)) {
      if (this.store.delete(key)) revoked.push(key.slice(prefix.length));
    }
    return revoked;
  }

  /**
   * Take back each confirmation of `pipelineId` that its steps as saved now
   * no longer bear out: a step gone, of another type, whose configuration no
   * longer reads, or whose digest changed. A configuration changed back is
   * never confirmed again by this: what was taken back stays so.
   * @returns The ids of the steps whose confirmation was taken back.
   */
  revokeChanged(pipelineId: string, steps: readonly Partial<PipelineStep>[]): string[] {
    const revoked: string[] = [];
    for (const grant of this.all().filter((kept) => kept.pipelineId === pipelineId)) {
      const step = steps.find((candidate) => candidate.id === grant.stepId);
      if (step?.type === 'rewind' && digestOf(step.config) === grant.digest) continue;
      if (this.revoke(grant.pipelineId, grant.stepId)) revoked.push(grant.stepId);
    }
    return revoked;
  }

  /**
   * Take back the confirmations whose pipeline is no longer saved, or whose
   * checkpoint `kept` says is no longer kept. The ConfigStore is read for the
   * pipelines; `kept` is asked once per checkpoint.
   * @returns The confirmations taken back.
   */
  async revokeVoid(kept?: (checkpointId: string) => Promise<boolean>): Promise<RewindGrant[]> {
    const revoked: RewindGrant[] = [];
    const keptAnswers = new Map<string, Promise<boolean>>();
    for (const grant of this.all()) {
      const saved = this.store.has(`${SAVED_PIPELINE_PREFIX}${grant.pipelineId}`);
      let gone = !saved;
      if (!gone && kept) {
        let answer = keptAnswers.get(grant.checkpointId);
        if (!answer) {
          answer = kept(grant.checkpointId);
          keptAnswers.set(grant.checkpointId, answer);
        }
        gone = !(await answer);
      }
      if (gone && this.revoke(grant.pipelineId, grant.stepId)) revoked.push(grant);
    }
    return revoked;
  }

  /**
   * The confirmation a run of `step`, a step of the pipeline `pipelineId`,
   * is held to: kept, its pipeline saved, and given for the configuration the
   * step runs with. Otherwise why not.
   */
  verify(
    pipelineId: string,
    step: Pick<PipelineStep, 'id' | 'config'>,
  ): { grant: VerifiedGrant } | { refusal: GrantRefusal } {
    const grant = this.get(pipelineId, step.id);
    if (!grant || !this.store.has(`${SAVED_PIPELINE_PREFIX}${pipelineId}`)) {
      return { refusal: 'never' };
    }
    if (digestOf(step.config) !== grant.digest) return { refusal: 'changed' };
    return {
      grant: {
        organizationId: grant.organizationId,
        checkpointId: grant.checkpointId,
        digest: grant.digest,
        grantedAt: grant.grantedAt,
      },
    };
  }
}

/** The digest of a Rewind step's configuration, or undefined when it does not read as one. */
export function digestOf(config: unknown): string | undefined {
  const read = pipelineRewindStepConfigSchema.safeParse(config ?? {});
  return read.success ? rewindGrantDigest(read.data) : undefined;
}

/**
 * Take back the confirmations of the pipeline `pipelineId`, for what writes
 * a pipeline from outside this machine's own saves: a profile import.
 * @returns The ids of the steps that had one.
 */
export function revokeRewindGrantsOf(store: ConfigStore, pipelineId: string): string[] {
  return new RewindGrants(store).revokePipeline(pipelineId);
}
