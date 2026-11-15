import type {
  PipelineStep,
  PipelineStepResult,
  SyncObjectSimulation,
  SyncSimulationResult,
} from '@sandforge/shared';
import {
  pipelineAnonymizeStepConfigSchema,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
  pipelineSeedStepConfigSchema,
} from '@sandforge/shared';
import type { CheckpointEstimate } from '@sandforge/shared';
import { CheckpointStepRefused } from '../../bridge/handlers/CheckpointHandler.js';
import {
  acceptancesOf,
  readSavedSync,
  type PipelineStepRunners,
} from '../../bridge/handlers/pipelineSteps.js';
import { pipelineSeedAsked } from '../../bridge/handlers/seedPipeline.js';
import type { PipelineSeedPreview } from '../../bridge/handlers/seedPipeline.js';
import { dataOpsBackupPayloadSchema } from '../../bridge/validatePayload.js';
import type { ApiBudgetCheck, StorageCheck } from '../forge/ForgeRunGate.js';
import { seedStorageWords } from '../seed/seedStorage.js';
import { grantRefusalWords } from './RewindGrants.js';
import {
  StepCancelledError,
  delayMs,
  type StepContext,
  type StepExecutor,
} from './StepExecutor.js';

/**
 * A pipeline's dry run: every step goes through its own check, as a run's
 * does, and the route goes where the run would go, but nothing is written to
 * an org, and nothing waits or asks.
 *
 * Each step that writes is given, in place of its work, its module's own
 * reading of what it would do — the same handlers, the same refusals:
 * - Sync, the simulation of the Sync page (`sync:simulate`), which reads both
 *   orgs and the configuration's watermarks and writes nothing, and asks no
 *   guard;
 * - Anonymize, what its run reads before Production Guard is asked: the rows
 *   counted, the fields masked, and every refusal on the way;
 * - Checkpoint, the scope of its take and its estimate, no record read;
 * - Rewind, its own preview held to its bounds, its confirmation checked;
 * - Seed, what its run meets before it writes: the data storage and the
 *   daily API requests the org has left, the emails its records make it
 *   send, and every refusal on the way, the guard not asked;
 * - Backup, the objects it would take a snapshot of.
 *
 * Compare and Pre-check only read: they run, so a Condition after them tests
 * what the org holds, as in the run. A Delay does not wait, an Approval is
 * not asked — the route goes on as if it were approved, and the step says
 * so —, and a Notification is neither shown nor printed.
 *
 * A step that would be refused fails, with the words its run would be
 * refused with: the route after it is the run's. Every result says it is a
 * dry run's (`output.dryRun`), and its summary says what the step would do.
 * The run's history and audit trail are not written: that is the caller's.
 */

/** The result of a step whose dry run went through. */
function wouldDo(
  step: PipelineStep,
  startTime: string,
  output: Record<string, unknown>,
  summary: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'completed',
    output: { ...output, dryRun: true },
    summary,
    startTime,
    endTime,
    duration: new Date(endTime).getTime() - new Date(startTime).getTime(),
  };
}

/** The result of a step its run would be refused for, or would not complete. */
function wouldFail(
  step: PipelineStep,
  startTime: string,
  output: Record<string, unknown>,
  error: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'failed',
    output: { ...output, dryRun: true },
    error,
    startTime,
    endTime,
    duration: new Date(endTime).getTime() - new Date(startTime).getTime(),
  };
}

/** `count` and `noun`, the noun in the plural unless the count is one. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A step's configuration read as text, an empty one as none: the page clears a field to ''. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** How the pipeline a step runs in is named, to the module its step reads with. */
function pipelineNameOf(context: StepContext): string {
  return context.pipelineName ?? context.pipelineId;
}

/** A refusal before a step wrote, carried as an error with a `code`: its code, or undefined. */
function refusalCode(err: unknown): string | undefined {
  if (err instanceof StepCancelledError) return undefined;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** What a dry run of a step that cannot read what it would do says: nothing is tried in its place. */
function cannotPreview(who: string): Error {
  return new Error(
    `${who} cannot be dry-run here: nothing can read what it would do. Nothing was written.`,
  );
}

/** How long a wait is, as a person reads it. */
function waitWords(ms: number): string {
  if (ms < 60_000) return `${ms / 1000} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** About how many API requests, of how many the org had left today, and how long. */
function costWords(estimate: CheckpointEstimate): string {
  return (
    `about ${counted(estimate.apiRequests, 'API request')} of the ${estimate.apiRequestsLeft} ` +
    `the org has left today, about ${estimate.seconds} s`
  );
}

/** What a simulated object would have the target do, as a clause. */
function simulatedWords(objects: readonly SyncObjectSimulation[]): string {
  const sum = (count: (o: SyncObjectSimulation) => number): number =>
    objects.reduce((total, o) => total + count(o), 0);
  return (
    `${sum((o) => o.insert)} to create, ${sum((o) => o.update)} to update, ` +
    `${sum((o) => o.delete)} to delete, ${sum((o) => o.skipped)} skipped and ` +
    `${sum((o) => o.refused)} refused of ${sum((o) => o.read)} read`
  );
}

/**
 * What the simulation says of how the run reads its objects beside the
 * counts: those it reads whole for want of a watermark in this store — on a
 * machine, or a command line's store, that never ran the configuration — and
 * those the read bound cut.
 */
function readingWords(result: SyncSimulationResult): string {
  const notes: string[] = [];
  const firstRun = result.objects
    .filter((o) => o.delta?.read === 'full' && o.delta.reason === 'first_run')
    .map((o) => o.objectApiName);
  if (firstRun.length > 0) {
    notes.push(
      `first run from this store for ${firstRun.join(', ')}: no watermark yet, every record is read`,
    );
  }
  const fromWatermark = result.objects.filter((o) => o.delta?.read === 'delta');
  if (fromWatermark.length > 0) {
    notes.push(
      `${fromWatermark.map((o) => o.objectApiName).join(', ')} read from the last run's watermark`,
    );
  }
  if (result.cutAtReadCap && result.cutAtReadCap.length > 0) {
    notes.push(
      `${result.cutAtReadCap.join(', ')} read only up to ${result.readCap ?? 'the bound of'} ` +
        'records (sync.maxRecordsPerObject): the run copies part of each',
    );
  }
  return notes.length > 0 ? `; ${notes.join('; ')}` : '';
}

function dryDelay(step: PipelineStep): Promise<PipelineStepResult> {
  const startTime = new Date().toISOString();
  const ms = delayMs(step.config) ?? 0;
  return Promise.resolve(
    wouldDo(
      step,
      startTime,
      { wouldWait: ms },
      `Would wait ${waitWords(ms)}: a dry run does not wait.`,
    ),
  );
}

function dryApproval(step: PipelineStep): Promise<PipelineStepResult> {
  const startTime = new Date().toISOString();
  return Promise.resolve(
    wouldDo(
      step,
      startTime,
      { asked: false },
      'Not asked in a dry run: the route goes on as if it were approved.',
    ),
  );
}

function dryNotification(runners: PipelineStepRunners) {
  return (step: PipelineStep): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const message = text(step.config['message']) ?? '';
    const shown =
      runners.ranFrom === 'commandLine'
        ? 'Not printed in a dry run; the run would print'
        : 'Not shown in a dry run; the run would show in VS Code';
    return Promise.resolve(wouldDo(step, startTime, { message }, `${shown}: "${message}"`));
  };
}

function dryBackup(runners: PipelineStepRunners) {
  return (step: PipelineStep): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const { orgId, objects } = dataOpsBackupPayloadSchema.parse({
      orgId: step.config['orgId'],
      objects: step.config['objects'],
    });
    const org = runners.orgName(orgId) ?? orgId;
    return Promise.resolve(
      wouldDo(
        step,
        startTime,
        { orgId, objects },
        `Would take a snapshot of ${counted(objects.length, 'object')} of ${org} ` +
          `(${objects.join(', ')}): a dry run takes none.`,
      ),
    );
  };
}

function drySync(runners: PipelineStepRunners) {
  return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const who = `Sync step "${step.name}"`;
    const saved = readSavedSync(runners, step);
    if ('problem' in saved) throw new Error(saved.problem);
    if (!runners.simulateSync) throw cannotPreview(who);
    const { config, name } = saved;
    const target = runners.orgName(config.targetOrgId) ?? config.targetOrgId;
    let result: SyncSimulationResult;
    try {
      result = await runners.simulateSync(config, context.signal);
    } catch (err: unknown) {
      const code = refusalCode(err);
      if (code === undefined) throw err;
      return wouldFail(
        step,
        startTime,
        { configId: config.id, code },
        `${who} would be refused: ${(err as Error).message}`,
      );
    }
    if (result.cancelled) {
      throw new StepCancelledError(
        `${who} was stopped before its simulation read every object. Nothing was written.`,
      );
    }
    const output: Record<string, unknown> = {
      configId: config.id,
      configName: name,
      operationId: result.operationId,
      objects: result.objects.map((o) => ({
        objectApiName: o.objectApiName,
        operation: o.operation,
        read: o.read,
        insert: o.insert,
        update: o.update,
        delete: o.delete,
        skipped: o.skipped,
        refused: o.refused,
        ...(o.delta ? { delta: o.delta } : {}),
      })),
      ...(result.readCap !== undefined ? { readCap: result.readCap } : {}),
      ...(result.cutAtReadCap ? { cutAtReadCap: result.cutAtReadCap } : {}),
    };
    const counts = simulatedWords(result.objects);
    // A read the org refused stops a run at the same object; records the
    // target cannot take as sent fail a run, which then fails its step.
    if (result.error) {
      return wouldFail(
        step,
        startTime,
        output,
        `${who} would stop on ${result.failedObject ?? 'an object'}: ${result.error}`,
      );
    }
    const refused = result.objects.reduce((total, o) => total + o.refused, 0);
    if (refused > 0) {
      return wouldFail(
        step,
        startTime,
        output,
        `${who} would run "${name}" into ${target} and not complete: ${counts}` +
          `${readingWords(result)}. Nothing was written.`,
      );
    }
    return wouldDo(
      step,
      startTime,
      output,
      `Would sync "${name}" into ${target}: ${counts}${readingWords(result)}. Nothing was written.`,
    );
  };
}

/**
 * The answer the Approval before a step gives in a dry run: the route a dry
 * run follows is the approved one, so an Approval step before it approves;
 * with none before it, nobody does, as in the run.
 */
function dryAnswer(context: StepContext): { approved: boolean } {
  const approvals = context.previousResults.filter((result) => result.stepType === 'approval');
  return { approved: approvals[approvals.length - 1]?.status === 'completed' };
}

/** The data storage a seed takes against what its org has left, as `sandforge seed` says it. */
function storageWords(check: StorageCheck, org: string): string {
  return seedStorageWords(check, org);
}

/** The daily API requests a seed makes against what its org has left. */
function requestsWords(check: ApiBudgetCheck, org: string): string {
  const sent = `about ${counted(check.estimate, 'API request')}`;
  return check.verdict === 'unread'
    ? `${sent}; what ${org} has left today could not be read (${check.unread})`
    : `${sent} of the ${check.remaining} ${org} has left today`;
}

function drySeed(runners: PipelineStepRunners) {
  return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const who = `Seed step "${step.name}"`;
    const { orgId, templateId } = pipelineSeedStepConfigSchema.parse({
      orgId: step.config['orgId'],
      templateId: text(step.config['templateId']),
    });
    const org = runners.orgName(orgId) ?? orgId;
    const chosen = pipelineSeedAsked(orgId, templateId, (id) => runners.savedSeedTemplate?.(id));
    if ('refusal' in chosen) {
      return wouldFail(
        step,
        startTime,
        { orgId, templateId, code: chosen.refusal.code },
        `${who} would be refused: ${chosen.refusal.message}`,
      );
    }
    if (!runners.previewSeed) throw cannotPreview(who);
    const { template } = chosen.asked;
    // What its run meets before it writes, read as its run reads it: the
    // storage of a seed of 5.86 MB into an org with 5 MB left was seen by its
    // run alone, the dry run having read nothing.
    let preview: PipelineSeedPreview;
    try {
      preview = await runners.previewSeed(
        {
          orgId,
          templateId,
          pipeline: { name: pipelineNameOf(context) },
          answer: dryAnswer(context),
        },
        context.signal,
      );
    } catch (err: unknown) {
      const code = refusalCode(err);
      if (code === undefined) throw err;
      return wouldFail(
        step,
        startTime,
        { orgId, templateId, code },
        `${who} would be refused: ${(err as Error).message}`,
      );
    }
    return wouldDo(
      step,
      startTime,
      {
        orgId,
        templateId,
        records: preview.records,
        objects: preview.objects,
        storage: preview.storage,
        apiRequests: preview.apiRequests,
        ...(preview.automation.length > 0 ? { automation: preview.automation } : {}),
      },
      `Would seed "${template.name}" into ${org}: ${counted(preview.records, 'record')} of ` +
        `${counted(preview.objects, 'object')}, as its template asks; ` +
        `${storageWords(preview.storage, org)}; ${requestsWords(preview.apiRequests, org)}. ` +
        'Nothing was written.',
    );
  };
}

function dryAnonymize(runners: PipelineStepRunners) {
  return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const who = `Anonymize step "${step.name}"`;
    if (!runners.previewMasking) throw cannotPreview(who);
    const object = text(step.config['object']);
    const where = text(step.config['where']);
    const { orgId, templateId, acceptAutomation, acceptEmails, muteAutomation } =
      pipelineAnonymizeStepConfigSchema.parse({
        orgId: step.config['orgId'],
        templateId: text(step.config['templateId']),
        ...(object !== undefined ? { object } : {}),
        ...(where !== undefined ? { where } : {}),
        ...acceptancesOf(step.config),
      });
    const org = runners.orgName(orgId) ?? orgId;
    try {
      const preview = await runners.previewMasking(
        {
          orgId,
          templateId,
          ...(object !== undefined ? { object } : {}),
          ...(where !== undefined ? { where } : {}),
          ...(step.retries !== undefined ? { retries: step.retries } : {}),
          accord: { acceptAutomation, acceptEmails, muteAutomation },
          pipeline: { name: pipelineNameOf(context) },
          // The route a dry run follows is the approved one; the guard is
          // not asked by a preview anyway.
          answer: { approved: true },
        },
        context.signal,
      );
      const masked = preview.objects
        .filter((o) => o.records > 0)
        .map((o) => `${o.records} of ${o.objectApiName} (${o.fields.join(', ')})`);
      return wouldDo(
        step,
        startTime,
        { orgId, templateId, records: preview.records, objects: preview.objects },
        preview.records === 0
          ? `Would mask nothing in ${org}: no row of ${preview.objects.map((o) => o.objectApiName).join(', ')} holds anything to mask. Nothing was written.`
          : `Would mask ${counted(preview.records, 'record')} in ${org}: ${masked.join('; ')}, ` +
              'after a snapshot of them. Nothing was written.',
      );
    } catch (err: unknown) {
      const code = refusalCode(err);
      if (code === undefined) throw err;
      return wouldFail(
        step,
        startTime,
        { orgId, templateId, code },
        `${who} would be refused: ${(err as Error).message}`,
      );
    }
  };
}

function dryCheckpoint(runners: PipelineStepRunners) {
  return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const who = `Checkpoint step "${step.name}"`;
    if (!runners.estimateTake) throw cannotPreview(who);
    const config = pipelineCheckpointStepConfigSchema.parse(step.config);
    const org = runners.orgName(config.orgId) ?? config.orgId;
    try {
      const scope = await runners.estimateTake(
        {
          config,
          origin: {
            pipeline: pipelineNameOf(context),
            step: step.name,
            trigger: runners.trigger ?? 'manual',
          },
        },
        context.signal,
      );
      return wouldDo(
        step,
        startTime,
        {
          orgId: config.orgId,
          objects: scope.objects,
          records: scope.records,
          leftOut: scope.leftOut,
          estimate: scope.estimate,
        },
        `Would take a checkpoint of ${org}: ${counted(scope.records, 'record')} of ` +
          `${counted(scope.objects, 'object')} now, ${costWords(scope.estimate)}. Nothing was ` +
          'taken.',
      );
    } catch (err: unknown) {
      if (!(err instanceof CheckpointStepRefused)) throw err;
      return wouldFail(
        step,
        startTime,
        { orgId: config.orgId, code: err.code },
        `${who} would be refused: ${err.message}`,
      );
    }
  };
}

function dryRewind(runners: PipelineStepRunners) {
  return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    const who = `Rewind step "${step.name}"`;
    if (!runners.rewindGrant) throw cannotPreview(who);
    if (!runners.previewRewind) throw cannotPreview(who);
    const config = pipelineRewindStepConfigSchema.parse(step.config);
    // The confirmation the run reads first: a dry run of an unconfirmed
    // rewind fails where the run would.
    const granted = runners.rewindGrant(context.pipelineId, step);
    if ('refusal' in granted) {
      return wouldFail(
        step,
        startTime,
        { orgId: config.orgId, checkpointId: config.checkpointId, code: 'NOT_CONFIRMED' },
        grantRefusalWords(step.name, granted.refusal),
      );
    }
    const org = runners.orgName(config.orgId) ?? config.orgId;
    try {
      const preview = await runners.previewRewind(
        {
          config,
          grant: granted.grant,
          origin: {
            pipeline: pipelineNameOf(context),
            step: step.name,
            trigger: runners.trigger ?? 'manual',
          },
        },
        context.signal,
      );
      return wouldDo(
        step,
        startTime,
        {
          orgId: config.orgId,
          checkpointId: preview.checkpointId,
          toDelete: preview.toDelete,
          toGiveBack: preview.toGiveBack,
          toBringBack: preview.toBringBack,
          toRecreate: preview.toRecreate,
          estimate: preview.estimate,
        },
        `Would rewind ${org} to the checkpoint ${preview.checkpointId}: ${preview.toDelete} to ` +
          `delete, ${preview.toGiveBack} to give their values back, ${preview.toBringBack} to ` +
          'bring back from the recycle bin' +
          (preview.toRecreate > 0 ? `, ${preview.toRecreate} to make again with new Ids` : '') +
          `, ${costWords(preview.estimate)}. Nothing was written.`,
      );
    } catch (err: unknown) {
      if (!(err instanceof CheckpointStepRefused)) throw err;
      return wouldFail(
        step,
        startTime,
        {
          orgId: config.orgId,
          checkpointId: config.checkpointId,
          code: err.code,
          ...(err.alsoRefused.length > 0 ? { alsoRefused: [...err.alsoRefused] } : {}),
        },
        `${who} would be refused: ${err.message}`,
      );
    }
  };
}

/**
 * Turn `executor`'s run into a dry run: each step's check is kept, and the
 * work of every step that writes, waits, asks or tells is replaced by what
 * it would do (see above). Called once its steps are registered
 * (`registerPipelineSteps`), with the runners they were registered with; a
 * step type with no handler is left refused, as in the run.
 * @param executor - The step executor of one run
 * @param runners - The flows the steps run on, their previews among them
 */
export function applyDryRun(executor: StepExecutor, runners: PipelineStepRunners): void {
  executor.wrapHandler('delay', () => dryDelay);
  executor.wrapHandler('approval', () => dryApproval);
  executor.wrapHandler('notification', () => dryNotification(runners));
  executor.wrapHandler('backup', () => dryBackup(runners));
  executor.wrapHandler('sync', () => drySync(runners));
  executor.wrapHandler('seed', () => drySeed(runners));
  executor.wrapHandler('anonymize', () => dryAnonymize(runners));
  executor.wrapHandler('checkpoint', () => dryCheckpoint(runners));
  executor.wrapHandler('rewind', () => dryRewind(runners));
}
