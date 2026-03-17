import { logger } from '../../logger.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import type {
  ForgeConfig,
  ForgeGraph,
  ForgeExecutionResult,
  ForgeTemplate,
  ComplianceFrameworkType,
} from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import type { ForgeHistoryStore } from '../../modules/forge/ForgeHistoryStore.js';

/** Message types handled by ForgeHandler. */
export type ForgeMessageType =
  | 'forge:discover'
  | 'forge:execute'
  | 'forge:pause'
  | 'forge:resume'
  | 'forge:abort'
  | 'forge:templates:list'
  | 'forge:templates:save'
  | 'forge:templates:delete'
  | 'forge:history:list'
  | 'forge:plan:request'
  | 'forge:compliance:request'
  | 'forge:metadata-diff:request';

/** Dependencies for ForgeHandler. */
export interface ForgeHandlerDeps {
  /** The Forge orchestrator that performs discovery and execution. */
  orchestrator: ForgeOrchestrator;
  /** Sends a message back to the webview. */
  postMessage: (message: unknown) => void;
  /** Optional plan generator for wave-based planning. */
  planGenerator?: ForgePlanGenerator;
  /** Optional compliance service for PII reports. */
  complianceService?: ForgeComplianceService;
  /** Optional metadata diff service for schema comparison. */
  metadataDiff?: ForgeMetadataDiff;
  /** Optional persistent template store. */
  templateStore?: ForgeTemplateStore;
  /** Optional persistent history store. */
  historyStore?: ForgeHistoryStore;
}

/** Payload shape for forge:discover messages. */
interface DiscoverPayload {
  config: ForgeConfig;
}

/** Payload shape for forge:execute messages. */
interface ExecutePayload {
  graph: ForgeGraph;
  config: ForgeConfig;
}

/** Payload shape for forge:templates:save messages. */
interface SaveTemplatePayload {
  template: ForgeTemplate;
}

/** Payload shape for forge:templates:delete messages. */
interface DeleteTemplatePayload {
  templateId: string;
}

/** Payload shape for forge:plan:request messages. */
interface PlanRequestPayload {
  graph: ForgeGraph;
  config: ForgeConfig;
}

/** Payload shape for forge:compliance:request messages. */
interface ComplianceRequestPayload {
  framework: string;
  graph: ForgeGraph;
  config: ForgeConfig;
}

/** Payload shape for forge:metadata-diff:request messages. */
interface MetadataDiffRequestPayload {
  sourceOrgId: string;
  targetOrgId: string;
  objectApiNames: string[];
}

/**
 * Domain handler for forge-related webview-to-extension messages.
 *
 * Routes forge:* message types to the ForgeOrchestrator and manages
 * templates, execution history, and abort/pause/resume lifecycle.
 */
export class ForgeHandler {
  private discoverAbortController: AbortController | null = null;
  private abortController: AbortController | null = null;
  private isPaused = false;
  private templates: ForgeTemplate[] = [];
  private history: ForgeExecutionResult[] = [];

  /** Tracks DML operations to prevent duplicate forge executions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** Maximum number of history entries to retain. */
  private static readonly MAX_HISTORY = 20;

  /** @param deps - Injected orchestrator and postMessage dependencies. */
  constructor(private readonly deps: ForgeHandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param type - The message type string.
   * @param payload - The message payload.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(type: string, payload: unknown): Promise<boolean> {
    switch (type) {
      case 'forge:discover':
        return this.handleDiscover(payload as DiscoverPayload);
      case 'forge:execute':
        return this.handleExecute(payload as ExecutePayload);
      case 'forge:pause':
        return this.handlePause();
      case 'forge:resume':
        return this.handleResume();
      case 'forge:abort':
        return this.handleAbort();
      case 'forge:templates:list':
        return this.handleTemplatesList();
      case 'forge:templates:save':
        return this.handleSaveTemplate(payload as SaveTemplatePayload);
      case 'forge:templates:delete':
        return this.handleDeleteTemplate(payload as DeleteTemplatePayload);
      case 'forge:history:list':
        return this.handleHistoryList();
      case 'forge:plan:request':
        return this.handlePlanRequest(payload as PlanRequestPayload);
      case 'forge:compliance:request':
        return this.handleComplianceRequest(payload as ComplianceRequestPayload);
      case 'forge:metadata-diff:request':
        return this.handleMetadataDiffRequest(payload as MetadataDiffRequestPayload);
      default:
        return false;
    }
  }

  /** Whether the handler is currently in paused state. */
  get paused(): boolean {
    return this.isPaused;
  }

  private async handleDiscover(payload: DiscoverPayload): Promise<boolean> {
    this.discoverAbortController = new AbortController();
    try {
      logger.info('Forge discover started');
      const graph = await this.deps.orchestrator.discover(payload.config, {
        signal: this.discoverAbortController.signal,
        onProgress: (event) => {
          this.deps.postMessage({ type: 'forge:discover:progress', payload: event });
        },
      });
      this.deps.postMessage({ type: 'forge:discover:response', payload: { graph } });
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      logger.error('Forge discover failed', { error: message });
      this.deps.postMessage({
        type: 'forge:discover:error',
        payload: { message },
      });
    }
    this.discoverAbortController = null;
    return true;
  }

  private async handleExecute(payload: ExecutePayload): Promise<boolean> {
    // Build a deterministic ID from payload content to detect genuine duplicates
    const configKey = `${payload.config.sourceOrgId}:${payload.config.targetOrgId}:${payload.config.recordId ?? ''}`;
    const objectKeys = payload.graph.nodes?.map((n) => n.objectApiName).join(',') ?? '';
    const forgeOpId = `forge:${configKey}:${objectKeys}:${payload.graph.totalRecords ?? 0}`;
    if (this.dmlTracker.isDuplicate(forgeOpId)) {
      logger.warn('Duplicate forge execution detected', { operationId: forgeOpId });
      this.deps.postMessage({
        type: 'forge:execute:error',
        payload: { message: `Duplicate forge operation: ${forgeOpId}` },
      });
      return true;
    }
    const totalRecords = payload.graph.totalRecords ?? 0;
    this.dmlTracker.register(forgeOpId, 'forge', 'upsert', totalRecords);

    this.abortController = new AbortController();
    const unsubProgress = this.deps.orchestrator.on('forge:progress', (event) => {
      this.deps.postMessage({ type: 'forge:progress', payload: event });
    });
    try {
      logger.info('Forge execute started');

      const result = await this.deps.orchestrator.execute(payload.graph, payload.config);

      this.history = [result, ...this.history].slice(0, ForgeHandler.MAX_HISTORY);
      this.deps.postMessage({ type: 'forge:execute:response', payload: { result } });
      this.dmlTracker.markCompleted(forgeOpId);
    } catch (error: unknown) {
      this.dmlTracker.markFailed(forgeOpId);
      const message = extractErrorMessage(error);
      logger.error('Forge execute failed', { error: message });
      this.deps.postMessage({
        type: 'forge:execute:error',
        payload: { message },
      });
    } finally {
      unsubProgress();
      this.abortController = null;
    }
    return true;
  }

  private handlePause(): boolean {
    this.isPaused = true;
    logger.info('Forge paused');
    return true;
  }

  private handleResume(): boolean {
    this.isPaused = false;
    logger.info('Forge resumed');
    return true;
  }

  private handleAbort(): boolean {
    this.discoverAbortController?.abort();
    this.abortController?.abort();
    logger.info('Forge aborted');
    return true;
  }

  private handleTemplatesList(): boolean {
    this.deps.postMessage({
      type: 'forge:templates:list:response',
      payload: this.templates,
    });
    return true;
  }

  private handleSaveTemplate(payload: SaveTemplatePayload): boolean {
    this.templates = [
      payload.template,
      ...this.templates.filter((t) => t.id !== payload.template.id),
    ];
    this.deps.postMessage({
      type: 'forge:templates:save:response',
      payload: { success: true },
    });
    return true;
  }

  private handleDeleteTemplate(payload: DeleteTemplatePayload): boolean {
    this.templates = this.templates.filter((t) => t.id !== payload.templateId);
    this.deps.postMessage({
      type: 'forge:templates:delete:response',
      payload: { success: true },
    });
    return true;
  }

  private handleHistoryList(): boolean {
    this.deps.postMessage({
      type: 'forge:history:list:response',
      payload: this.history,
    });
    return true;
  }

  /** Generate a forge execution plan from a graph. */
  private async handlePlanRequest(payload: PlanRequestPayload): Promise<boolean> {
    if (!this.deps.planGenerator) {
      this.deps.postMessage({
        type: 'forge:plan:error',
        payload: { message: 'Plan generator not configured' },
      });
      return true;
    }
    try {
      logger.info('Forge plan generation started');
      const plan = this.deps.planGenerator.generate(payload.graph);
      this.deps.postMessage({ type: 'forge:plan:response', payload: { plan } });
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      logger.error('Forge plan generation failed', { error: message });
      this.deps.postMessage({
        type: 'forge:plan:error',
        payload: { message },
      });
    }
    return true;
  }

  /** Generate a compliance report for a graph and framework. */
  private async handleComplianceRequest(payload: ComplianceRequestPayload): Promise<boolean> {
    if (!this.deps.complianceService) {
      this.deps.postMessage({
        type: 'forge:compliance:error',
        payload: { message: 'Compliance service not configured' },
      });
      return true;
    }
    try {
      logger.info('Forge compliance report generation started');
      const report = this.deps.complianceService.generate(
        payload.framework as ComplianceFrameworkType,
        payload.graph,
        payload.config.sourceOrgId,
        payload.config.targetOrgId,
      );
      this.deps.postMessage({ type: 'forge:compliance:response', payload: { report } });
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      logger.error('Forge compliance report failed', { error: message });
      this.deps.postMessage({
        type: 'forge:compliance:error',
        payload: { message },
      });
    }
    return true;
  }

  /** Compare metadata schemas between source and target orgs. */
  private async handleMetadataDiffRequest(payload: MetadataDiffRequestPayload): Promise<boolean> {
    if (!this.deps.metadataDiff) {
      this.deps.postMessage({
        type: 'forge:metadata-diff:error',
        payload: { message: 'Metadata diff service not configured' },
      });
      return true;
    }
    try {
      logger.info('Forge metadata diff started');
      const diffs = await this.deps.metadataDiff.compare(
        payload.sourceOrgId,
        payload.targetOrgId,
        payload.objectApiNames,
      );
      this.deps.postMessage({ type: 'forge:metadata-diff:response', payload: { diffs } });
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      logger.error('Forge metadata diff failed', { error: message });
      this.deps.postMessage({
        type: 'forge:metadata-diff:error',
        payload: { message },
      });
    }
    return true;
  }
}
