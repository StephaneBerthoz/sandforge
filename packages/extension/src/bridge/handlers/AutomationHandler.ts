import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse, sendNotification, sendOperationStarted, sendOperationProgress,
  sendOperationCompleted, sendOperationFailed,
} from './HandlerTypes.js';
import type { PipelineOrchestrator } from '../../modules/automation/PipelineOrchestrator.js';
import type { PipelineMarketplace } from '../../modules/automation/PipelineMarketplace.js';
import type { MarketplaceListRequest, MarketplaceInstallRequest } from '@sandforge/shared';
import { PIPELINE_TEMPLATES } from '../templates/pipelineTemplates.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { sendHandlerError } from './HandlerTypes.js';

/** Message types handled by AutomationHandler. */
const AUTOMATION_TYPES = new Set([
  'pipeline:run',
  'pipeline:execute',
  'pipeline:templates',
  'pipeline:list',
  'pipeline:history',
  'pipeline:save',
  'operation:cancel',
  'operation:pause',
  'operation:resume',
  'marketplace:list',
  'marketplace:install',
]);

/**
 * Domain handler for automation and pipeline-related webview-to-extension messages.
 *
 * Manages pipeline execution (run/cancel/pause/resume), predefined templates,
 * and the pipeline marketplace.
 */
export class AutomationHandler implements DomainHandler {
  private activeOrchestrators: Map<string, PipelineOrchestrator> = new Map();
  private activeOperationIds: Map<string, string> = new Map();
  private pipelineMarketplace?: PipelineMarketplace;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject pipeline marketplace service. */
  setPipelineMarketplace(marketplace: PipelineMarketplace): void {
    this.pipelineMarketplace = marketplace;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AUTOMATION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'pipeline:run':
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
      case 'operation:cancel':
        this.handleOperationCancel(msg);
        return true;
      case 'operation:pause':
        this.handleOperationPause(msg);
        return true;
      case 'operation:resume':
        this.handleOperationResume(msg);
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

  private async handlePipelineRun(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { pipeline: Record<string, unknown>; variables?: Record<string, string> } }).payload;
    const operationId = crypto.randomUUID();

    try {
      const { PipelineBuilder } = await import('../../modules/automation/PipelineBuilder.js');
      const { TriggerEngine } = await import('../../modules/automation/TriggerEngine.js');
      const { SchedulerService } = await import('../../modules/automation/SchedulerService.js');
      const { StepLibrary } = await import('../../modules/automation/StepLibrary.js');
      const { StepExecutor } = await import('../../modules/automation/StepExecutor.js');
      const { ConditionalRouter } = await import('../../modules/automation/ConditionalRouter.js');
      const { PipelineHistory } = await import('../../modules/automation/PipelineHistory.js');
      const { PipelineOrchestrator: PipelineOrchestratorClass } = await import('../../modules/automation/PipelineOrchestrator.js');

      const builder = new PipelineBuilder();
      const triggerEngine = new TriggerEngine();
      const scheduler = new SchedulerService({ triggerEngine });
      const stepLibrary = new StepLibrary();
      const stepExecutor = new StepExecutor();
      const conditionalRouter = new ConditionalRouter();
      const history = new PipelineHistory();

      const orchestrator = new PipelineOrchestratorClass({
        builder,
        triggerEngine,
        scheduler,
        stepLibrary,
        stepExecutor,
        conditionalRouter,
        history,
      });

      const pipeline = payload.pipeline as unknown as import('@sandforge/shared').PipelineDefinition;
      const variables = payload.variables ?? {};

      this.activeOrchestrators.set(operationId, orchestrator);
      this.deps.infraServices?.performanceTracker?.start(operationId, 'automation');
      sendOperationStarted(this.deps, operationId, 'automation', `Pipeline: ${pipeline.name}`);

      orchestrator.on('stepCompleted', (_event, data) => {
        const stepData = data as { runId: string; stepResult: { stepName: string; status: string } };
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
      });

      const result = await orchestrator.execute(pipeline, variables, 'manual');

      this.activeOperationIds.set(operationId, result.id);
      this.activeOrchestrators.delete(operationId);
      this.activeOperationIds.delete(operationId);
      this.deps.infraServices?.performanceTracker?.complete(operationId);

      if (result.status === 'failed') {
        sendOperationFailed(this.deps, operationId, result.error ?? 'Pipeline failed', false);
      } else {
        sendOperationCompleted(this.deps, operationId, { status: result.status, stepResults: result.stepResults.length });
      }

      const response = buildResponse(this.deps, msg, 'pipeline:run:response', result as unknown as Record<string, unknown>);
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      this.activeOrchestrators.delete(operationId);
      this.activeOperationIds.delete(operationId);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), false);
      sendHandlerError(this.deps, 'pipeline:run', 'pipeline:error', err);
    }
  }

  private handlePipelineTemplates(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const response = buildResponse(this.deps, msg, 'pipeline:templates:response', { templates: PIPELINE_TEMPLATES });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] pipeline:templates:response`);
  }

  private handleOperationCancel(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { operationId: string } }).payload;

    const orchestrator = this.activeOrchestrators.get(payload.operationId);
    if (orchestrator) {
      const runId = this.activeOperationIds.get(payload.operationId);
      if (runId) {
        orchestrator.cancel(runId);
        sendNotification(this.deps, 'info', 'Operation', 'Operation cancelled.');
      } else {
        for (const run of orchestrator.getActiveRuns()) {
          orchestrator.cancel(run.id);
        }
        sendNotification(this.deps, 'info', 'Operation', 'Operation cancelled.');
      }
    } else {
      sendNotification(this.deps, 'warning', 'Operation', 'No active operation found to cancel.');
    }
  }

  private handleOperationPause(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { operationId: string } }).payload;

    const orchestrator = this.activeOrchestrators.get(payload.operationId);
    if (orchestrator) {
      const runId = this.activeOperationIds.get(payload.operationId);
      if (runId) {
        orchestrator.pause(runId);
        sendNotification(this.deps, 'info', 'Operation', 'Operation paused.');
      } else {
        for (const run of orchestrator.getActiveRuns()) {
          orchestrator.pause(run.id);
        }
        sendNotification(this.deps, 'info', 'Operation', 'Operation paused.');
      }
    } else {
      sendNotification(this.deps, 'warning', 'Operation', 'No active operation found to pause.');
    }
  }

  private handleOperationResume(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { operationId: string } }).payload;

    const orchestrator = this.activeOrchestrators.get(payload.operationId);
    if (orchestrator) {
      const runId = this.activeOperationIds.get(payload.operationId);
      if (runId) {
        orchestrator.resume(runId);
        sendNotification(this.deps, 'info', 'Operation', 'Operation resumed.');
      } else {
        for (const run of orchestrator.getActiveRuns()) {
          orchestrator.resume(run.id);
        }
        sendNotification(this.deps, 'info', 'Operation', 'Operation resumed.');
      }
    } else {
      sendNotification(this.deps, 'warning', 'Operation', 'No active operation found to resume.');
    }
  }

  /**
   * Handle pipeline:list -- load saved pipelines from ConfigStore.
   * Retrieves all entries in the 'pipelines' category.
   */
  private handlePipelineList(msg: BaseMessage): void {
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
      sendHandlerError(this.deps, 'pipeline:list', 'pipeline:error', err);
    }
  }

  /**
   * Handle pipeline:history -- load execution history from ConfigStore.
   * Retrieves all entries in the 'pipeline-history' category, sorted by timestamp descending.
   */
  private handlePipelineHistory(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const historyEntries = this.deps.configStore.getByCategory('pipeline-history');
      const rawHistory: Array<Record<string, unknown>> = Object.entries(historyEntries)
        .map(([key, value]) => {
          const entry = value as Record<string, unknown>;
          return { key, ...entry };
        });
      const history = rawHistory.sort((a, b) => {
        const tsA = typeof a['timestamp'] === 'number' ? a['timestamp'] : 0;
        const tsB = typeof b['timestamp'] === 'number' ? b['timestamp'] : 0;
        return (tsB as number) - (tsA as number);
      });
      const response = buildResponse(this.deps, msg, 'pipeline:history:response', { history });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] pipeline:history:response (${history.length} entries)`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'pipeline:history', 'pipeline:error', err);
    }
  }

  /**
   * Handle pipeline:save -- persist a pipeline configuration to ConfigStore.
   * Stores under 'pipeline:saved:{id}' with 'pipelines' category.
   */
  private handlePipelineSave(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { id: string; config: Record<string, unknown> } }).payload;
      const pipelineId = payload.id || crypto.randomUUID();
      const storageKey = `pipeline:saved:${pipelineId}`;
      this.deps.configStore.set(storageKey, {
        ...payload.config,
        id: pipelineId,
        savedAt: new Date().toISOString(),
      }, 'pipelines');
      const response = buildResponse(this.deps, msg, 'pipeline:save:response', { success: true, id: pipelineId });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] pipeline:save:response id=${pipelineId}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'pipeline:save', 'pipeline:error', err);
    }
  }

  private handleMarketplaceList(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      if (!this.pipelineMarketplace) {
        throw new Error('Pipeline Marketplace not available.');
      }
      const payload = (msg as MarketplaceListRequest).payload;
      let templates;
      if (payload?.query) {
        templates = this.pipelineMarketplace.search(payload.query);
      } else if (payload?.category) {
        templates = this.pipelineMarketplace.getByCategory(payload.category);
      } else {
        templates = this.pipelineMarketplace.getTemplates();
      }
      const response = buildResponse(this.deps, msg, 'marketplace:list:response', {
        success: true,
        templates: templates.map((t: { id: string; name: string; description: string; category: string }) => ({
          id: t.id, name: t.name, description: t.description, category: t.category, author: 'SandForge',
        })),
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] marketplace:list: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'marketplace:list:response', { success: false, error: extractErrorMessage(err) });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private handleMarketplaceInstall(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { templateId } = (msg as MarketplaceInstallRequest).payload;
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
      const response = buildResponse(this.deps, msg, 'marketplace:install:response', { success: true, pipeline });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] marketplace:install: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'marketplace:install:response', { success: false, error: extractErrorMessage(err) });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
