import type {
  BaseMessage,
  AutopilotScanSchemaRequest,
  AutopilotGeneratePlanRequest,
  AutopilotExecuteRequest,
  AutopilotSkipNodeRequest,
} from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendNotification, sendHandlerError } from './HandlerTypes.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import type { AutopilotOrchestrator } from '../../modules/autopilot/AutopilotOrchestrator.js';
import type {
  AutopilotConnection,
  SchemaScanResult,
} from '../../modules/autopilot/SchemaScanner.js';

/** Message types handled by AutopilotHandler. */
const AUTOPILOT_TYPES = new Set([
  'autopilot:scan-schema',
  'autopilot:generate-plan',
  'autopilot:execute',
  'autopilot:pause',
  'autopilot:resume',
  'autopilot:skip-node',
  'autopilot:compliance-report',
]);

/**
 * Domain handler for autopilot-related webview-to-extension messages.
 *
 * Manages the full autopilot lifecycle: schema scanning, plan generation,
 * execution with pause/resume/skip, and compliance reporting.
 */
export class AutopilotHandler implements DomainHandler {
  private orchestrator?: AutopilotOrchestrator;
  private scanResult?: SchemaScanResult;
  private graph?: Parameters<AutopilotOrchestrator['generatePlan']>[0];
  private rules?: Parameters<AutopilotOrchestrator['generatePlan']>[2];
  private plan?: ReturnType<AutopilotOrchestrator['generatePlan']>;
  private profile?: ReturnType<AutopilotOrchestrator['buildCompliance']>['profile'];

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject autopilot orchestrator. */
  setOrchestrator(orchestrator: AutopilotOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AUTOPILOT_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'autopilot:scan-schema':
        await this.handleScanSchema(msg);
        return true;
      case 'autopilot:generate-plan':
        await this.handleGeneratePlan(msg);
        return true;
      case 'autopilot:execute':
        await this.handleExecute(msg);
        return true;
      case 'autopilot:pause':
        this.handlePause(msg);
        return true;
      case 'autopilot:resume':
        this.handleResume(msg);
        return true;
      case 'autopilot:skip-node':
        this.handleSkipNode(msg);
        return true;
      case 'autopilot:compliance-report':
        this.handleComplianceReport(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleScanSchema(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const payload = (msg as AutopilotScanSchemaRequest).payload;
    try {
      const sourceConn = (await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as AutopilotConnection;
      const targetConn = (await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as AutopilotConnection;
      const scanResult = await this.orchestrator.scanSchemas(sourceConn, targetConn, {
        selectedObjects: payload.selectedObjects,
        includeStandardObjects: payload.includeStandardObjects,
      } as Parameters<AutopilotOrchestrator['scanSchemas']>[2]);
      this.scanResult = scanResult;
      const graph = this.orchestrator.buildGraph(scanResult);
      this.graph = graph;
      const response = buildResponse(this.deps, msg, 'autopilot:schema-result', { graph });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:scan-schema', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Schema scan failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async handleGeneratePlan(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    if (!this.graph) {
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        'No schema scan result available. Run scan-schema first.',
      );
      return;
    }
    const payload = (msg as AutopilotGeneratePlanRequest).payload;
    try {
      const { profile, rules } = this.orchestrator.buildCompliance(payload.complianceFramework, []);
      this.profile = profile;
      this.rules = rules;
      const plan = this.orchestrator.generatePlan(this.graph, payload.complianceFramework, rules);
      this.plan = plan;
      const response = buildResponse(this.deps, msg, 'autopilot:plan-ready', {
        plan,
        graph: this.graph,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:generate-plan', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Plan generation failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    if (!this.plan || !this.graph || !this.rules || !this.scanResult) {
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        'No execution plan available. Run generate-plan first.',
      );
      return;
    }
    const payload = (msg as AutopilotExecuteRequest).payload;
    try {
      if (payload.grappeThreshold && this.orchestrator) {
        this.deps.log(`[GRAPPE] autopilot threshold set to ${payload.grappeThreshold}`);
      }

      // Send node-progress 'processing' for all nodes in each wave before execution
      for (const wave of this.plan.waves) {
        for (const objectApiName of wave.objects) {
          this.sendNodeProgress(msg, String(objectApiName), 'processing', wave.order);
        }
      }

      const result = await this.orchestrator.executePlan(
        this.plan,
        this.graph,
        this.rules,
        this.scanResult.recordCounts,
      );

      // Send node-progress 'completed' or 'failed' per node based on execution result
      const completedSet = new Set(result.completedObjects);
      const failedSet = new Set(result.failedObjects);
      const skippedSet = new Set(result.skippedObjects);

      for (const wave of this.plan.waves) {
        for (const objectApiName of wave.objects) {
          const name = String(objectApiName);
          if (completedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'completed', wave.order, {
              recordCount: this.scanResult?.recordCounts.get(name) ?? 0,
              failureCount: 0,
            });
          } else if (failedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'failed', wave.order, {
              error: `Execution failed for ${name}`,
            });
          } else if (skippedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'completed', wave.order, {
              recordCount: 0,
              failureCount: 0,
            });
          }
        }
      }

      const response = buildResponse(this.deps, msg, 'autopilot:completed', {
        totalRecords: result.totalSuccess + result.totalFailure + result.totalSkipped,
        totalSuccessCount: result.totalSuccess,
        totalFailureCount: result.totalFailure,
        totalElapsedMs: result.elapsedMs,
        totalApiCalls: 0,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Execution failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  /**
   * Send an autopilot:node-progress message to the webview.
   *
   * @param requestMsg - The original request message for correlationId.
   * @param objectName - The Salesforce object API name.
   * @param status - Node processing status.
   * @param wave - Wave number (0-based).
   * @param extra - Optional extra fields (recordCount, failureCount, error).
   */
  private sendNodeProgress(
    requestMsg: BaseMessage,
    objectName: string,
    status: 'processing' | 'completed' | 'failed',
    wave: number,
    extra?: { recordCount?: number; failureCount?: number; error?: string },
  ): void {
    const progressMsg = buildResponse(this.deps, requestMsg, 'autopilot:node-progress', {
      nodeId: objectName,
      objectName,
      status,
      wave,
      ...(extra ?? {}),
    });
    this.deps.broker.postToWebview(progressMsg);
  }

  private handlePause(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    try {
      this.orchestrator.pause();
      sendNotification(this.deps, 'info', 'Autopilot', 'Execution paused.');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:pause', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Pause failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private handleResume(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    try {
      this.orchestrator.resume();
      sendNotification(this.deps, 'info', 'Autopilot', 'Execution resumed.');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:resume', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Resume failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private handleSkipNode(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const payload = (msg as AutopilotSkipNodeRequest).payload;
    try {
      this.orchestrator.skip(payload.objectApiName);
      sendNotification(this.deps, 'info', 'Autopilot', `Skipped node: ${payload.objectApiName}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:skip-node', 'autopilot:error', err);
      sendNotification(this.deps, 'error', 'Autopilot', `Skip failed: ${extractErrorMessage(err)}`);
    }
  }

  private handleComplianceReport(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    if (!this.profile || !this.rules || !this.scanResult) {
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        'No compliance data available. Run generate-plan first.',
      );
      return;
    }
    try {
      const report = this.orchestrator.generateReport(
        this.profile,
        this.rules,
        this.scanResult.recordCounts,
        '',
        '',
        this.scanResult.totalObjectsScanned,
      );
      const response = buildResponse(this.deps, msg, 'autopilot:compliance-report', { report });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:compliance-report', 'autopilot:error', err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Report generation failed: ${extractErrorMessage(err)}`,
      );
    }
  }
}
