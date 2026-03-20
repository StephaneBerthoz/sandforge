import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeExecutionResult, ForgeTemplate, ComplianceFrameworkType } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendOperationStarted, sendOperationCompleted, sendOperationFailed } from './HandlerTypes.js';
import { logger } from '../../logger.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import type { ForgeHistoryStore } from '../../modules/forge/ForgeHistoryStore.js';

/** Optional v2 services injected alongside the ForgeOrchestrator. */
export interface ForgeServices {
  /** Optional plan generator for wave-based planning. */
  planGenerator?: ForgePlanGenerator;
  /** Optional compliance service for PII reports. */
  complianceService?: ForgeComplianceService;
  /** Optional metadata diff service for schema comparison. */
  metadataDiff?: ForgeMetadataDiff;
  /** @deprecated Templates are now persisted via ConfigStore. Accepted for backward compatibility. */
  templateStore?: ForgeTemplateStore;
  /** @deprecated History is now persisted via ConfigStore. Accepted for backward compatibility. */
  historyStore?: ForgeHistoryStore;
}

/** Message types handled by ForgeHandler. */
const FORGE_TYPES = new Set([
  'forge:preview',
  'forge:discover',
  'forge:execute',
  'forge:pause',
  'forge:resume',
  'forge:abort',
  'forge:templates:list',
  'forge:templates:save',
  'forge:templates:delete',
  'forge:history:list',
  'forge:plan:request',
  'forge:compliance:request',
  'forge:metadata-diff:request',
]);

/** Payload shape for forge:preview messages. */
interface PreviewPayload {
  recordId: string;
  orgId: string;
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

/** Timeout for plan generation in milliseconds. */
const PLAN_TIMEOUT_MS = 30_000;

/** Timeout for compliance report generation in milliseconds. */
const COMPLIANCE_TIMEOUT_MS = 30_000;

/** Timeout for metadata diff comparison in milliseconds. */
const METADATA_DIFF_TIMEOUT_MS = 60_000;

/** ConfigStore key for persisted forge templates. */
const TEMPLATES_KEY = 'forge:templates';

/** ConfigStore key for persisted forge execution history. */
const HISTORY_KEY = 'forge:history';

/** ConfigStore category for all forge data. */
const FORGE_CATEGORY = 'forge';

/**
 * Domain handler for forge-related webview-to-extension messages.
 *
 * Routes forge:* message types to the ForgeOrchestrator and manages
 * templates, execution history, and abort/pause/resume lifecycle.
 * Templates and history are persisted to ConfigStore (survive extension reload).
 */
export class ForgeHandler implements DomainHandler {
  private discoverAbortController: AbortController | null = null;
  private abortController: AbortController | null = null;
  private orchestrator?: ForgeOrchestrator;
  private planGenerator?: ForgePlanGenerator;
  private complianceService?: ForgeComplianceService;
  private metadataDiff?: ForgeMetadataDiff;

  /** Tracks DML operations to prevent duplicate forge executions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** Maximum number of history entries to retain. */
  private static readonly MAX_HISTORY = 20;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject forge orchestrator and optional v2 services.
   *
   * @param orchestrator - The ForgeOrchestrator instance.
   * @param services - Optional additional Forge v2 services.
   */
  setForgeOrchestrator(
    orchestrator: ForgeOrchestrator,
    services?: ForgeServices,
  ): void {
    this.orchestrator = orchestrator;
    if (services) {
      this.planGenerator = services.planGenerator;
      this.complianceService = services.complianceService;
      this.metadataDiff = services.metadataDiff;
    }
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!FORGE_TYPES.has(msg.type)) return false;

    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    switch (msg.type) {
      case 'forge:preview':
        await this.handleForgePreview(msg);
        return true;
      case 'forge:discover':
        await this.handleDiscover(msg);
        return true;
      case 'forge:execute':
        await this.handleExecute(msg);
        return true;
      case 'forge:pause':
        this.handlePause(msg);
        return true;
      case 'forge:resume':
        this.handleResume(msg);
        return true;
      case 'forge:abort':
        this.handleAbort(msg);
        return true;
      case 'forge:templates:list':
        this.handleTemplatesList(msg);
        return true;
      case 'forge:templates:save':
        this.handleSaveTemplate(msg);
        return true;
      case 'forge:templates:delete':
        this.handleDeleteTemplate(msg);
        return true;
      case 'forge:history:list':
        this.handleHistoryList(msg);
        return true;
      case 'forge:plan:request':
        await this.handlePlanRequest(msg);
        return true;
      case 'forge:compliance:request':
        await this.handleComplianceRequest(msg);
        return true;
      case 'forge:metadata-diff:request':
        await this.handleMetadataDiffRequest(msg);
        return true;
      default:
        return false;
    }
  }

  /** Load templates from ConfigStore. */
  private loadTemplates(): ForgeTemplate[] {
    return this.deps.configStore.get<ForgeTemplate[]>(TEMPLATES_KEY) ?? [];
  }

  /** Save templates to ConfigStore. */
  private saveTemplates(templates: ForgeTemplate[]): void {
    this.deps.configStore.set(TEMPLATES_KEY, templates, FORGE_CATEGORY);
  }

  /** Load execution history from ConfigStore. */
  private loadHistory(): ForgeExecutionResult[] {
    return this.deps.configStore.get<ForgeExecutionResult[]>(HISTORY_KEY) ?? [];
  }

  /** Save execution history to ConfigStore. */
  private saveHistory(history: ForgeExecutionResult[]): void {
    this.deps.configStore.set(HISTORY_KEY, history, FORGE_CATEGORY);
  }

  /** Preview a single record by ID (resolve object type, fetch standard fields). */
  private async handleForgePreview(msg: BaseMessage): Promise<void> {
    const { recordId, orgId } = (msg as BaseMessage & { payload: PreviewPayload }).payload;

    try {
      if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(recordId)) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', { message: 'Invalid Record ID format' });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve object type from record ID key prefix
      const keyPrefix = recordId.substring(0, 3);
      const globalDesc = await conn.describeGlobal();
      checkApiLimits(conn.limitInfo, 'forge:preview describeGlobal');
      const sobjectInfo = globalDesc.sobjects.find(
        (s) => s.keyPrefix === keyPrefix,
      );

      if (!sobjectInfo) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Unknown object for key prefix "${keyPrefix}"`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      // Query the record with standard fields (with fallback for orgs not supporting FIELDS() syntax)
      const records = await queryWithFieldsFallback<Record<string, unknown>>(
        conn, sobjectInfo.name,
        `SELECT FIELDS(STANDARD) FROM ${sobjectInfo.name} WHERE Id = '${sanitizeSoqlValue(recordId)}' LIMIT 1`,
      );
      checkApiLimits(conn.limitInfo, `forge:preview query ${sobjectInfo.name}`);

      if (!records || records.length === 0) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Record not found: ${recordId}`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      const record = records[0];
      const skipKeys = new Set(['attributes', 'Id']);
      const fields = Object.entries(record)
        .filter(([key]) => !skipKeys.has(key))
        .filter(([, value]) => value != null && String(value) !== '')
        .slice(0, 8)
        .map(([key, value]) => ({ name: key, value: String(value) }));

      // Describe the object for total field count
      const objectDesc = await conn.describe(sobjectInfo.name);
      checkApiLimits(conn.limitInfo, `forge:preview describe ${sobjectInfo.name}`);
      const totalFieldCount = objectDesc.fields.length;

      // Count records in the object
      let estimatedRecordCount = 0;
      try {
        const countResult = await conn.query(`SELECT COUNT() FROM ${sobjectInfo.name}`);
        estimatedRecordCount = countResult.totalSize;
      } catch {
        // Some objects may not support COUNT() -- fall back to 0
      }

      // Compute estimated size using the same heuristic as GraphDiscoveryService
      const estimatedSize = estimatedRecordCount * 0.001; // MB_PER_RECORD

      const response = buildResponse(this.deps, msg, 'forge:preview:response', {
        objectApiName: sobjectInfo.name,
        objectLabel: sobjectInfo.label,
        recordId,
        fields,
        estimatedRecordCount,
        totalFieldCount,
        estimatedSize,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'forge:preview', 'forge:preview:error', err, 'PREVIEW_ERROR');
    }
  }

  private async handleDiscover(msg: BaseMessage): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', new Error('Forge module is not initialized'), 'NOT_INITIALIZED');
      return;
    }

    const { config } = (msg as BaseMessage & { payload: DiscoverPayload }).payload;
    this.discoverAbortController = new AbortController();
    const operationId = `forge-discover-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Discovering object graph');

    try {
      logger.info('Forge discover started');
      const graph = await this.orchestrator.discover(config, {
        signal: this.discoverAbortController.signal,
        onProgress: (event) => {
          const progressMsg = buildResponse(this.deps, msg, 'forge:discover:progress', event as unknown as Record<string, unknown>);
          this.deps.broker.postToWebview(progressMsg);
        },
      });
      const response = buildResponse(this.deps, msg, 'forge:discover:response', { graph });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { nodeCount: graph.nodes?.length ?? 0 });
    } catch (error: unknown) {
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', error, 'DISCOVER_ERROR', true);
      sendOperationFailed(this.deps, operationId, String(error), true);
    }
    this.discoverAbortController = null;
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', new Error('Forge module is not initialized'), 'NOT_INITIALIZED');
      return;
    }

    const { graph, config } = (msg as BaseMessage & { payload: ExecutePayload }).payload;

    // Build a deterministic ID from payload content to detect genuine duplicates
    const configKey = `${config.sourceOrgId}:${config.targetOrgId}:${config.recordId ?? ''}`;
    const objectKeys = graph.nodes?.map((n) => n.objectApiName).join(',') ?? '';
    const forgeOpId = `forge:${configKey}:${objectKeys}:${graph.totalRecords ?? 0}`;

    if (this.dmlTracker.isDuplicate(forgeOpId)) {
      logger.warn('Duplicate forge execution detected', { operationId: forgeOpId });
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', new Error(`Duplicate forge operation: ${forgeOpId}`), 'DUPLICATE');
      return;
    }

    const totalRecords = graph.totalRecords ?? 0;
    this.dmlTracker.register(forgeOpId, 'forge', 'upsert', totalRecords);

    this.abortController = new AbortController();
    const operationId = `forge-execute-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Executing forge operation');

    const unsubProgress = this.orchestrator.on('forge:progress', (event) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:progress', event as unknown as Record<string, unknown>);
      this.deps.broker.postToWebview(progressMsg);
    });

    try {
      logger.info('Forge execute started');
      const result = await this.orchestrator.execute(graph, config);

      // Persist to history via ConfigStore
      const history = [result, ...this.loadHistory()].slice(0, ForgeHandler.MAX_HISTORY);
      this.saveHistory(history);

      const response = buildResponse(this.deps, msg, 'forge:execute:response', { result, operationId });
      this.deps.broker.postToWebview(response);
      this.dmlTracker.markCompleted(forgeOpId);
      sendOperationCompleted(this.deps, operationId, { status: result.status });
    } catch (error: unknown) {
      this.dmlTracker.markFailed(forgeOpId);
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', error, 'EXECUTE_ERROR', true);
      sendOperationFailed(this.deps, operationId, String(error), true);
    } finally {
      unsubProgress();
      this.abortController = null;
    }
  }

  private handlePause(_msg: BaseMessage): void {
    this.orchestrator?.pause();
    logger.info('Forge paused');
  }

  private handleResume(_msg: BaseMessage): void {
    this.orchestrator?.resume();
    logger.info('Forge resumed');
  }

  private handleAbort(_msg: BaseMessage): void {
    this.discoverAbortController?.abort();
    this.abortController?.abort();
    this.orchestrator?.abort();
    logger.info('Forge aborted');
  }

  private handleTemplatesList(msg: BaseMessage): void {
    const templates = this.loadTemplates();
    const response = buildResponse(this.deps, msg, 'forge:templates:list:response', { templates });
    this.deps.broker.postToWebview(response);
  }

  private handleSaveTemplate(msg: BaseMessage): void {
    const { template } = (msg as BaseMessage & { payload: SaveTemplatePayload }).payload;
    const templates = [template, ...this.loadTemplates().filter((t) => t.id !== template.id)];
    this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:save:response', { success: true });
    this.deps.broker.postToWebview(response);
  }

  private handleDeleteTemplate(msg: BaseMessage): void {
    const { templateId } = (msg as BaseMessage & { payload: DeleteTemplatePayload }).payload;
    const templates = this.loadTemplates().filter((t) => t.id !== templateId);
    this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:delete:response', { success: true });
    this.deps.broker.postToWebview(response);
  }

  private handleHistoryList(msg: BaseMessage): void {
    const history = this.loadHistory();
    const response = buildResponse(this.deps, msg, 'forge:history:list:response', { history });
    this.deps.broker.postToWebview(response);
  }

  /** Generate a forge execution plan from a graph. */
  private async handlePlanRequest(msg: BaseMessage): Promise<void> {
    if (!this.planGenerator) {
      sendHandlerError(this.deps, 'forge:plan', 'forge:plan:error', new Error('Plan generator not configured'));
      return;
    }
    const { graph } = (msg as BaseMessage & { payload: PlanRequestPayload }).payload;
    try {
      logger.info('Forge plan generation started');
      const plan = this.planGenerator.generate(graph);
      const response = buildResponse(this.deps, msg, 'forge:plan:response', { plan });
      this.deps.broker.postToWebview(response);
    } catch (error: unknown) {
      sendHandlerError(this.deps, 'forge:plan', 'forge:plan:error', error);
    }
  }

  /** Generate a compliance report for a graph and framework. */
  private async handleComplianceRequest(msg: BaseMessage): Promise<void> {
    if (!this.complianceService) {
      sendHandlerError(this.deps, 'forge:compliance', 'forge:compliance:error', new Error('Compliance service not configured'));
      return;
    }
    const { framework, graph, config } = (msg as BaseMessage & { payload: ComplianceRequestPayload }).payload;
    try {
      logger.info('Forge compliance report generation started');
      const report = this.complianceService.generate(
        framework as ComplianceFrameworkType,
        graph,
        config.sourceOrgId,
        config.targetOrgId,
      );
      const response = buildResponse(this.deps, msg, 'forge:compliance:response', { report });
      this.deps.broker.postToWebview(response);
    } catch (error: unknown) {
      sendHandlerError(this.deps, 'forge:compliance', 'forge:compliance:error', error);
    }
  }

  /** Compare metadata schemas between source and target orgs. */
  private async handleMetadataDiffRequest(msg: BaseMessage): Promise<void> {
    if (!this.metadataDiff) {
      sendHandlerError(this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', new Error('Metadata diff service not configured'));
      return;
    }
    const { sourceOrgId, targetOrgId, objectApiNames } = (msg as BaseMessage & { payload: MetadataDiffRequestPayload }).payload;
    try {
      logger.info('Forge metadata diff started');
      const diffs = await this.metadataDiff.compare(sourceOrgId, targetOrgId, objectApiNames);
      const response = buildResponse(this.deps, msg, 'forge:metadata-diff:response', { diffs });
      this.deps.broker.postToWebview(response);
    } catch (error: unknown) {
      sendHandlerError(this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', error);
    }
  }
}
