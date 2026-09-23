import type {
  BaseMessage,
  PipelineDefinition,
  PipelineHistoryStep,
  PipelineRun,
  PipelineStepResult,
  PipelineStepUpdate,
} from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  type OperationFailureContext,
} from './HandlerTypes.js';
import type { PipelineMarketplace } from '../../modules/automation/PipelineMarketplace.js';
import {
  validatePayload,
  pipelineRunPayloadSchema,
  pipelineSavePayloadSchema,
  marketplaceListPayloadSchema,
  marketplaceInstallPayloadSchema,
} from '../validatePayload.js';
import { PIPELINE_TEMPLATES } from '../templates/pipelineTemplates.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { sendHandlerError } from './HandlerTypes.js';
import { registerPipelineSteps } from './pipelineSteps.js';
import type { PipelineStepRunners } from './pipelineSteps.js';

/**
 * How many runs the history keeps. Each entry carries the definition that ran,
 * so an unbounded log would grow the workspace state file on every run.
 */
const HISTORY_LIMIT = 50;

/**
 * One step of a run as the history keeps it: its name, type, status, how long
 * it ran and what it did or why it failed — not its output, which can be the
 * counts of a whole comparison.
 */
function historyStep(result: PipelineStepResult): PipelineHistoryStep {
  return {
    stepName: result.stepName,
    stepType: result.stepType,
    status: result.status,
    ...(result.duration !== undefined ? { duration: result.duration } : {}),
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** Message types handled by AutomationHandler. */
const AUTOMATION_TYPES = new Set([
  'pipeline:execute',
  'pipeline:templates',
  'pipeline:list',
  'pipeline:history',
  'pipeline:save',
  'marketplace:list',
  'marketplace:install',
]);

/**
 * Domain handler for automation and pipeline-related webview-to-extension messages.
 *
 * Manages pipeline execution, predefined templates, and the pipeline marketplace.
 */
export class AutomationHandler implements DomainHandler {
  private pipelineMarketplace?: PipelineMarketplace;
  /** The module flows the Backup, Compare, Pre-check and Notification steps run on. */
  private stepRunners?: PipelineStepRunners;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject pipeline marketplace service. */
  setPipelineMarketplace(marketplace: PipelineMarketplace): void {
    this.pipelineMarketplace = marketplace;
  }

  /**
   * Inject the module flows the org steps run on. Without them — a host that
   * builds this handler alone — those steps have no handler and are refused
   * before the run, as they were before they could run at all.
   */
  setStepRunners(runners: PipelineStepRunners): void {
    this.stepRunners = runners;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!AUTOMATION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'pipeline:execute':
        await this.handlePipelineRun(msg);
        return true;
      case 'pipeline:templates':
        this.handlePipelineTemplates(msg);
        return true;
      case 'pipeline:list':
        this.handlePipelineList(msg);
        return true;
      case 'pipeline:history':
        this.handlePipelineHistory(msg);
        return true;
      case 'pipeline:save':
        this.handlePipelineSave(msg);
        return true;
      case 'marketplace:list':
        this.handleMarketplaceList(msg);
        return true;
      case 'marketplace:install':
        this.handleMarketplaceInstall(msg);
        return true;
      default:
        return false;
    }
  }

  private async handlePipelineRun(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(pipelineRunPayloadSchema, msg, 'pipeline:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    // The request's own id, as Seed and Sync use theirs: the page matches the
    // `pipeline:step` updates to its own run by it, and cancels the run by it
    // on `execution:abort`.
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'automation', operation: msg.type };

    try {
      const { PipelineBuilder } = await import('../../modules/automation/PipelineBuilder.js');
      const { TriggerEngine } = await import('../../modules/automation/TriggerEngine.js');
      const { StepLibrary } = await import('../../modules/automation/StepLibrary.js');
      const { StepExecutor } = await import('../../modules/automation/StepExecutor.js');
      const { ConditionalRouter } = await import('../../modules/automation/ConditionalRouter.js');
      const { PipelineHistory } = await import('../../modules/automation/PipelineHistory.js');

      const builder = new PipelineBuilder();
      const triggerEngine = new TriggerEngine();
      const stepLibrary = new StepLibrary();
      const stepExecutor = new StepExecutor();
      if (this.stepRunners) {
        registerPipelineSteps(stepExecutor, this.stepRunners);
      }
      const conditionalRouter = new ConditionalRouter();
      const history = new PipelineHistory();

      if (!this.deps.services) {
        throw new Error(
          'AutomationHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      const orchestrator = this.deps.services.automationOrchestrator({
        builder,
        triggerEngine,
        stepLibrary,
        stepExecutor,
        conditionalRouter,
        history,
        services: this.deps.services,
      });

      const pipeline = payload.pipeline as unknown as PipelineDefinition;
      const variables = payload.variables ?? {};

      this.deps.infraServices?.performanceTracker?.start(operationId, 'automation');
      const description = `Pipeline: ${pipeline.name}`;
      sendOperationStarted(this.deps, operationId, 'automation', description);

      const stepCompletedListener = (_event: unknown, data: unknown): void => {
        const stepData = data as {
          runId: string;
          stepResult: { stepName: string; status: string };
        };
        const activeRuns = orchestrator.getActiveRuns();
        const totalSteps = pipeline.steps.length;
        const completedSteps = activeRuns[0]?.stepResults.length ?? 0;
        sendOperationProgress(
          this.deps,
          operationId,
          Math.round((completedSteps / totalSteps) * 100),
          completedSteps,
          totalSteps,
          `Step: ${stepData.stepResult.stepName} (${stepData.stepResult.status})`,
        );
      };
      // Each step as it starts and as it ends, for the page's execution view,
      // which otherwise showed every step pending until the run was over.
      const stepStartedListener = (_event: unknown, data: unknown): void => {
        const { stepId } = data as { stepId: string };
        this.postStepUpdate({ operationId, stepId, status: 'running' });
      };
      const stepEndedListener = (_event: unknown, data: unknown): void => {
        const { stepResult } = data as { stepResult: PipelineStepResult };
        this.postStepUpdate({
          operationId,
          stepId: stepResult.stepId,
          status:
            stepResult.status === 'failed'
              ? 'failed'
              : stepResult.status === 'skipped'
                ? 'skipped'
                : 'completed',
          ...(stepResult.duration !== undefined ? { duration: stepResult.duration } : {}),
          ...(stepResult.summary !== undefined ? { summary: stepResult.summary } : {}),
          ...(stepResult.error !== undefined ? { error: stepResult.error } : {}),
        });
      };
      orchestrator.on('stepCompleted', stepCompletedListener);
      orchestrator.on('stepStarted', stepStartedListener);
      orchestrator.on('stepCompleted', stepEndedListener);
      orchestrator.on('stepSkipped', stepEndedListener);

      // `sandforge.pipeline.timeout` (manifest default 300 000 ms) bounds the
      // wall-clock duration of a pipeline run. When the budget is spent its
      // signal stops the run where it is — the step in progress included, and
      // no step after it starts — and the run comes back to be answered and
      // recorded like any other. It used to be dropped instead: the handler
      // gave up on it with a TimeoutError, so the run reached neither History
      // nor the page, which went on waiting for an answer until its own limit.
      //
      // The same signal is the one a cancel aborts: the run is registered with
      // it, so `execution:abort` from the page, or Cancel in Live Operations,
      // stops the run through the orchestrator's abort path.
      const pipelineTimeout =
        this.deps.services?.getSandforgeSetting?.('pipeline.timeout', 300_000) ?? 300_000;
      const stop = new AbortController();
      let outOfTime = false;
      const timer = setTimeout(() => {
        outOfTime = true;
        stop.abort();
      }, pipelineTimeout);
      let settleRegistered: (error?: Error) => void = () => {};
      this.deps.infraServices?.backgroundRegistry?.register(
        operationId,
        'automation',
        description,
        new Promise<void>((resolve, reject) => {
          settleRegistered = (error) => (error ? reject(error) : resolve());
        }),
        stop,
      );
      let run: PipelineRun;
      try {
        run = await orchestrator.execute(pipeline, variables, 'manual', stop.signal);
      } catch (err: unknown) {
        // Live Operations would otherwise list the run as running for good.
        settleRegistered(new Error(extractErrorMessage(err)));
        throw err;
      } finally {
        clearTimeout(timer);
        // Release the event-emitter listeners so the closures don't pin the
        // orchestrator + pipeline graph in memory after execution.
        orchestrator.off?.('stepCompleted', stepCompletedListener);
        orchestrator.off?.('stepStarted', stepStartedListener);
        orchestrator.off?.('stepCompleted', stepEndedListener);
        orchestrator.off?.('stepSkipped', stepEndedListener);
      }
      // The orchestrator reports a run its signal stopped as cancelled. One the
      // budget stopped did not finish in the time it was given, which is a
      // failure the reader has to see; one a cancel stopped is cancelled. A
      // run that ended as the budget ran out keeps its own status.
      const ranOutOfTime = outOfTime && run.status === 'cancelled';
      const result: PipelineRun = ranOutOfTime
        ? {
            ...run,
            status: 'failed',
            error: `Pipeline ran out of time: sandforge.pipeline.timeout stopped it after ${pipelineTimeout} ms.`,
          }
        : run;
      settleRegistered(
        result.status === 'failed' ? new Error(result.error ?? 'Pipeline failed') : undefined,
      );

      this.deps.infraServices?.performanceTracker?.complete(operationId);
      this.recordRun(result, pipeline);

      if (result.status === 'failed') {
        sendOperationFailed(
          this.deps,
          operationId,
          result.error ?? 'Pipeline failed',
          ranOutOfTime,
          { context: failure },
        );
      } else {
        sendOperationCompleted(this.deps, operationId, {
          status: result.status,
          stepResults: result.stepResults.length,
        });
      }

      const response = buildResponse(
        this.deps,
        msg,
        'pipeline:run:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      // The page waits on this request, and `operation:failed` does not answer
      // it: it reaches every panel, correlated to no request. Without the
      // correlated `pipeline:error` the page held Run in its running state
      // until a deadline of its own.
      sendHandlerError(this.deps, 'pipeline:execute', 'pipeline:error', msg, err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), false, {
        context: failure,
      });
    }
  }

  /** Post one step's status to the page (see {@link PipelineStepUpdate}). */
  private postStepUpdate(payload: PipelineStepUpdate['payload']): void {
    const update: BaseMessage & { payload: PipelineStepUpdate['payload'] } = {
      id: this.deps.nextId(),
      type: 'pipeline:step',
      timestamp: Date.now(),
      payload,
    };
    this.deps.broker.postToWebview(update);
  }

  /**
   * Write a finished run to the 'pipeline-history' category `pipeline:history`
   * reads, with the definition that ran: a save overwrites a pipeline under its
   * own id, so the snapshot is the only record of what the run walked.
   *
   * A storage failure is logged rather than raised: the run is over, and its
   * result is on its way to the webview.
   *
   * The `PipelineHistory` module the orchestrator records into is built per
   * request and keeps its entries in memory, so it is gone with the handler
   * call: this is the only place a run outlives the run itself.
   *
   * @param run - The run as the orchestrator resolved it.
   * @param pipeline - The definition the run walked.
   */
  private recordRun(run: PipelineRun, pipeline: PipelineDefinition): void {
    try {
      const startedAt = new Date(run.startTime).getTime();
      this.deps.configStore.set(
        `pipeline:history:${run.id}`,
        {
          runId: run.id,
          pipelineId: run.pipelineId,
          pipelineName: run.pipelineName,
          status: run.status,
          triggeredBy: run.triggeredBy,
          startTime: run.startTime,
          duration: run.duration ?? 0,
          // The steps that ran. A step the run passed over — its condition did
          // not hold, a route jumped it, a Condition held it back — has a
          // result too, and the History tab says how many steps ran.
          stepCount: run.stepResults.filter((step) => step.status !== 'skipped').length,
          errorCount: run.stepResults.filter((step) => step.status === 'failed').length,
          // What each step did, or why it failed, in the order the run took
          // them: a backup's records, a comparison's differences, a refusal.
          steps: run.stepResults.map(historyStep),
          // `pipeline:history` sorts on this; `startTime` is an ISO string.
          timestamp: Number.isNaN(startedAt) ? Date.now() : startedAt,
          pipeline,
        },
        'pipeline-history',
      );
      this.trimHistory();
    } catch (err: unknown) {
      this.deps.log(`[ERR] pipeline history write: ${extractErrorMessage(err)}`);
    }
  }

  /** Delete the oldest entries above {@link HISTORY_LIMIT}. */
  private trimHistory(): void {
    const entries = Object.entries(this.deps.configStore.getByCategory('pipeline-history'));
    if (entries.length <= HISTORY_LIMIT) return;

    const oldestFirst = entries
      .map(([key, value]) => {
        const stamp = (value as Record<string, unknown>)['timestamp'];
        return { key, timestamp: typeof stamp === 'number' ? stamp : 0 };
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const { key } of oldestFirst.slice(0, entries.length - HISTORY_LIMIT)) {
      this.deps.configStore.delete(key);
    }
  }

  private handlePipelineTemplates(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const response = buildResponse(this.deps, msg, 'pipeline:templates:response', {
      templates: PIPELINE_TEMPLATES,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] pipeline:templates:response`);
  }

  /**
   * Handle pipeline:list -- load saved pipelines from ConfigStore.
   * Retrieves all entries in the 'pipelines' category.
   */
  private handlePipelineList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const savedEntries = this.deps.configStore.getByCategory('pipelines');
      const pipelines = Object.entries(savedEntries).map(([key, value]) => ({
        key,
        ...(value as Record<string, unknown>),
      }));
      const response = buildResponse(this.deps, msg, 'pipeline:list:response', { pipelines });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] pipeline:list:response (${pipelines.length} pipelines)`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'pipeline:list', 'pipeline:error', msg, err);
    }
  }

  /**
   * Handle pipeline:history -- load execution history from ConfigStore.
   * Retrieves all entries in the 'pipeline-history' category, sorted by timestamp descending.
   */
  private handlePipelineHistory(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const historyEntries = this.deps.configStore.getByCategory('pipeline-history');
      // A stored entry also carries the definition the run walked. Nothing in
      // the History tab reads it, and a pipeline variable can hold a secret
      // default value, so the snapshot stays in extension storage rather than
      // crossing the bridge on every visit to the tab.
      const rawHistory: Array<Record<string, unknown>> = Object.values(historyEntries).map(
        (value) => {
          const entry = { ...(value as Record<string, unknown>) };
          delete entry['pipeline'];
          return entry;
        },
      );
      const history = rawHistory.sort((a, b) => {
        const tsA = typeof a['timestamp'] === 'number' ? a['timestamp'] : 0;
        const tsB = typeof b['timestamp'] === 'number' ? b['timestamp'] : 0;
        return (tsB as number) - (tsA as number);
      });
      const response = buildResponse(this.deps, msg, 'pipeline:history:response', { history });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] pipeline:history:response (${history.length} entries)`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'pipeline:history', 'pipeline:error', msg, err);
    }
  }

  /**
   * Handle pipeline:save -- persist a pipeline configuration to ConfigStore.
   * Stores under 'pipeline:saved:{id}' with 'pipelines' category.
   */
  private handlePipelineSave(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const parsed = validatePayload(pipelineSavePayloadSchema, msg, 'pipeline:error', this.deps);
      if (!parsed) return;
      const payload = parsed;
      const pipelineId = payload.id || crypto.randomUUID();
      const storageKey = `pipeline:saved:${pipelineId}`;
      this.deps.configStore.set(
        storageKey,
        {
          ...payload.config,
          id: pipelineId,
          savedAt: new Date().toISOString(),
        },
        'pipelines',
      );
      const response = buildResponse(this.deps, msg, 'pipeline:save:response', {
        success: true,
        id: pipelineId,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] pipeline:save:response id=${pipelineId}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'pipeline:save', 'pipeline:error', msg, err);
    }
  }

  private handleMarketplaceList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      if (!this.pipelineMarketplace) {
        throw new Error('Pipeline Marketplace not available.');
      }
      const payload = validatePayload(
        marketplaceListPayloadSchema,
        msg,
        'pipeline:error',
        this.deps,
      );
      if (payload === null) return;
      let templates;
      if (payload?.query) {
        templates = this.pipelineMarketplace.search(payload.query);
      } else if (payload?.category) {
        templates = this.pipelineMarketplace.getByCategory(payload.category);
      } else {
        templates = this.pipelineMarketplace.getTemplates();
      }
      // The step types travel with each card so the page can say, before
      // Install, which templates hold a step that cannot run in a pipeline yet.
      const response = buildResponse(this.deps, msg, 'marketplace:list:response', {
        success: true,
        templates: templates.map(
          (t: {
            id: string;
            name: string;
            description: string;
            category: string;
            steps: ReadonlyArray<{ type: string }>;
          }) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            category: t.category,
            author: 'SandForge',
            stepTypes: t.steps.map((step) => step.type),
          }),
        ),
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] marketplace:list: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'marketplace:list:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private handleMarketplaceInstall(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      marketplaceInstallPayloadSchema,
      msg,
      'pipeline:error',
      this.deps,
    );
    if (!parsed) return;
    const { templateId } = parsed;
    try {
      if (!this.pipelineMarketplace) {
        throw new Error('Pipeline Marketplace not available.');
      }
      const template = this.pipelineMarketplace.getById(templateId);
      if (!template) {
        throw new Error(`Template "${templateId}" not found.`);
      }
      const exported = this.pipelineMarketplace.exportTemplate(templateId);
      let pipeline: Record<string, unknown>;
      try {
        pipeline = JSON.parse(exported) as Record<string, unknown>;
      } catch {
        throw new Error(`Template "${templateId}" contains invalid JSON.`);
      }
      const response = buildResponse(this.deps, msg, 'marketplace:install:response', {
        success: true,
        pipeline,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] marketplace:install: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'marketplace:install:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
