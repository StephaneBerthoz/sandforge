import type {
  AuditObjectCounts,
  AutopilotGraph,
  ExecutionPlan,
  ComplianceProfile,
  AutopilotAnonymizationRule,
  AutopilotRefusal,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendNotification,
  sendHandlerError,
  PRODUCTION_GUARD_MISSING,
} from './HandlerTypes.js';
import {
  validatePayload,
  autopilotScanSchemaPayloadSchema,
  autopilotGeneratePlanPayloadSchema,
  autopilotExecutePayloadSchema,
  autopilotSkipNodePayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import type { AutopilotOrchestrator } from '../../modules/autopilot/AutopilotOrchestrator.js';
import type {
  AutopilotConnection,
  SchemaScanResult,
} from '../../modules/autopilot/SchemaScanner.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';

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

/** Max tracked operations; oldest non-executing entries are evicted beyond this. */
const MAX_TRACKED_OPERATIONS = 10;

/**
 * Per-operation autopilot flow state (scan → plan → execute → report).
 *
 * One entry is created per `autopilot:scan-schema` request. The fixed message
 * protocol carries no operation id, so follow-up requests attach to the most
 * recently opened operation — the same "latest wins" semantics the previous
 * shared-fields version had, minus the cross-operation clobbering: each
 * request works on its own operation context and never re-reads shared fields
 * after an `await`.
 */
interface AutopilotOperation {
  /** Operation id (the scan-schema request id, echoed back as correlationId). */
  readonly id: string;
  /**
   * Target org captured at scan time. The execute payload carries no org id
   * (fixed message protocol), so the production guard resolves the org tier
   * from this value when the operation reaches `autopilot:execute`.
   */
  readonly targetOrgId: string;
  /** Source org captured at scan time: where the run's records come from. */
  readonly sourceOrgId: string;
  /** Schema scan result, set once the scan completes. */
  scanResult?: SchemaScanResult;
  /** Dependency graph built from the scan result. */
  graph?: AutopilotGraph;
  /** Compliance profile built at generate-plan time. */
  profile?: ComplianceProfile;
  /** Anonymization rules derived from the profile. */
  rules?: AutopilotAnonymizationRule[];
  /** Execution plan generated from the graph. */
  plan?: ExecutionPlan;
}

/**
 * Domain handler for autopilot-related webview-to-extension messages.
 *
 * Manages the full autopilot lifecycle: schema scanning, plan generation,
 * execution with pause/resume/skip, and compliance reporting. Flow state lives
 * in per-operation contexts ({@link AutopilotOperation}) keyed by operation id,
 * so concurrent scans/plans/executions cannot overwrite each other's state.
 */
export class AutopilotHandler implements DomainHandler {
  /** Tracked autopilot operations by operation id (bounded, oldest-first eviction). */
  private readonly operations = new Map<string, AutopilotOperation>();
  /** Operation that follow-up requests attach to (protocol carries no operation id). */
  private currentOperationId?: string;
  /** Operations currently inside executePlan — the target of pause/resume/skip. */
  private readonly executingOperations = new Set<string>();
  private orchestrator?: AutopilotOrchestrator;

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
  async handle(msg: InboundRequest): Promise<boolean> {
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

  /** Resolve the operation follow-up requests attach to (most recently opened). */
  private resolveCurrentOperation(): AutopilotOperation | undefined {
    return this.currentOperationId !== undefined
      ? this.operations.get(this.currentOperationId)
      : undefined;
  }

  /** Keep the operation map bounded; never evict an in-flight (executing) operation. */
  private evictOldOperations(): void {
    while (this.operations.size > MAX_TRACKED_OPERATIONS) {
      const oldest = this.operations.keys().next();
      if (oldest.done || this.executingOperations.has(oldest.value)) return;
      this.operations.delete(oldest.value);
      if (this.currentOperationId === oldest.value) {
        this.currentOperationId = [...this.operations.keys()].pop();
      }
    }
  }

  private async handleScanSchema(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const parsed = validatePayload(
      autopilotScanSchemaPayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    const previousCurrentId = this.currentOperationId;
    const operation: AutopilotOperation = {
      id: msg.id,
      targetOrgId: payload.targetOrgId,
      sourceOrgId: payload.sourceOrgId,
    };
    this.operations.set(msg.id, operation);
    this.currentOperationId = msg.id;
    this.evictOldOperations();

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
      });
      operation.scanResult = scanResult;
      const graph = this.orchestrator.buildGraph(scanResult);
      operation.graph = graph;
      const response = buildResponse(this.deps, msg, 'autopilot:schema-result', { graph });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      // Roll back the failed operation so the previous healthy one stays current.
      this.operations.delete(msg.id);
      if (this.currentOperationId === msg.id) {
        this.currentOperationId = previousCurrentId;
      }
      sendHandlerError(this.deps, 'autopilot:scan-schema', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Schema scan failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async handleGeneratePlan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const operation = this.resolveCurrentOperation();
    if (!operation?.graph) {
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        'No schema scan result available. Run scan-schema first.',
      );
      return;
    }
    const parsed = validatePayload(
      autopilotGeneratePlanPayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    try {
      const { profile, rules } = this.orchestrator.buildCompliance(payload.complianceFramework, []);
      operation.profile = profile;
      operation.rules = rules;
      const plan = this.orchestrator.generatePlan(
        operation.graph,
        payload.complianceFramework,
        rules,
      );
      operation.plan = plan;
      const response = buildResponse(this.deps, msg, 'autopilot:plan-ready', {
        plan,
        graph: operation.graph,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:generate-plan', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Plan generation failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const operation = this.resolveCurrentOperation();
    if (!operation?.plan || !operation.graph || !operation.rules || !operation.scanResult) {
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        'No execution plan available. Run generate-plan first.',
      );
      return;
    }
    const parsed = validatePayload(
      autopilotExecutePayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    // Capture per-operation state in locals: a concurrent scan/plan request
    // must not be able to swap this operation's data while executePlan is awaited.
    const { plan, graph, rules, scanResult } = operation;

    // Production guard check on the target org — same policy as sync/seed
    // runs. The guard instance comes from backgroundComposition and reaches
    // this handler via infraServices (same wiring as SyncOpsHandler). The
    // tier is resolved from the target org captured at scan time (the
    // execute payload carries no org id — fixed message protocol). Covers
    // every insert below: executePlan is the only path that writes. Without
    // the guard nothing is written.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      recordWriteRun(this.deps, {
        action: 'autopilot_execute',
        module: 'autopilot',
        operationId: msg.id,
        orgId: operation.targetOrgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      sendHandlerError(
        this.deps,
        'autopilot:execute',
        'autopilot:error',
        msg,
        new Error(PRODUCTION_GUARD_MISSING.message),
        { code: PRODUCTION_GUARD_MISSING.code },
      );
      sendNotification(this.deps, 'error', 'Autopilot', PRODUCTION_GUARD_MISSING.message);
      return;
    }
    const targetOrg = this.deps.orgManager.getOrg(operation.targetOrgId);
    const guardRequest = {
      orgId: operation.targetOrgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation: 'insert' as const,
      objectName: plan.waves[0]?.objects[0] ?? 'AutopilotData',
      recordCount: Array.from(scanResult.recordCounts.values()).reduce((s, c) => s + c, 0),
      module: 'autopilot',
    };
    const { check, decision } = await consultProductionGuard(guard, guardRequest);
    // What the run carries to the audit trail when it ends.
    const guardDecision = decision;
    if (decision === 'refused' || decision === 'declined') {
      recordWriteRun(this.deps, {
        action: 'autopilot_execute',
        module: 'autopilot',
        operationId: msg.id,
        orgId: operation.targetOrgId,
        outcome: 'stopped',
        guard: decision,
      });
    }
    if (decision === 'refused') {
      const message = `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`;
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, new Error(message));
      sendNotification(this.deps, 'error', 'Autopilot', message);
      return;
    }
    // `safety.requireProdConfirmation`: explicit user consent before
    // writing to a production org.
    if (decision === 'declined') {
      const message = 'Operation cancelled by user (production confirmation declined).';
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, new Error(message));
      sendNotification(this.deps, 'error', 'Autopilot', message);
      return;
    }

    this.executingOperations.add(operation.id);
    /** Per object, what the run wrote, as each node settles. */
    const written = new Map<string, AuditObjectCounts>();
    /** A run is recorded once, whichever way it ends. */
    let recorded = false;
    const recordRun = (outcome: 'success' | 'partial' | 'failure'): void => {
      if (recorded) return;
      recorded = true;
      recordWriteRun(this.deps, {
        action: 'autopilot_execute',
        module: 'autopilot',
        operationId: msg.id,
        orgId: operation.targetOrgId,
        outcome,
        guard: guardDecision,
        objects: [...written.values()],
        source: { origin: 'org', orgId: operation.sourceOrgId },
      });
    };
    try {
      if (payload.grappeThreshold) {
        this.deps.log(`[GRAPPE] autopilot threshold set to ${payload.grappeThreshold}`);
      }

      // Send node-progress 'processing' for all nodes in each wave before execution
      for (const wave of plan.waves) {
        for (const objectApiName of wave.objects) {
          this.sendNodeProgress(msg, String(objectApiName), 'processing', wave.order);
        }
      }

      /*
       * Forward each node as it settles, while the run is still going.
       *
       * The loop above marks every node of every wave as processing before
       * anything starts, and the loop below marks them all done once
       * everything has finished — so between the two the panel called "live
       * stats" sat in silence for the length of the run, showing 0 records
       * written of 243 and 0 API calls of 131. The executor was emitting the
       * real numbers the whole time and nothing subscribed.
       *
       * The reconciliation loop below is kept: it is the authority on which
       * nodes completed, failed or were skipped, and re-sending a terminal
       * status a node already reached changes nothing on the page.
       */
      const waveOf = new Map<string, number>();
      for (const wave of plan.waves) {
        for (const objectApiName of wave.objects) waveOf.set(String(objectApiName), wave.order);
      }

      const result = await this.orchestrator.executePlan(
        plan,
        graph,
        rules,
        scanResult.recordCounts,
        (event) => {
          const name = String(event.objectApiName);
          written.set(name, {
            ...emptyCounts(name),
            ...(event.type === 'node-completed'
              ? { created: event.successCount, failed: event.failureCount }
              : { created: event.partialSuccessCount, failed: event.failureCount ?? 0 }),
          });
          if (event.type === 'node-completed') {
            this.sendNodeProgress(msg, name, 'completed', waveOf.get(name) ?? 0, {
              recordCount: event.successCount,
              failureCount: event.failureCount,
              linkedCount: event.linkedCount,
              refusals: event.refusals,
              apiCallsUsed: event.apiCallsUsed,
            });
          } else {
            this.sendNodeProgress(msg, name, 'failed', waveOf.get(name) ?? 0, {
              // The records written before it failed are real work, and the
              // reconciliation loop below reports none of them.
              recordCount: event.partialSuccessCount,
              failureCount: event.failureCount,
              linkedCount: event.linkedCount,
              refusals: event.refusals,
              // The first refusal; the rest are in `refusals`, counted by code.
              // Joined, a node of five hundred refused records sent five
              // hundred messages as one line.
              error: event.errors[0] ?? `Execution failed for ${name}`,
            });
          }
        },
      );

      // Send node-progress 'completed' or 'failed' per node based on execution result
      const completedSet = new Set(result.completedObjects);
      const failedSet = new Set(result.failedObjects);
      const skippedSet = new Set(result.skippedObjects);

      for (const wave of plan.waves) {
        for (const objectApiName of wave.objects) {
          const name = String(objectApiName);
          // What the node really came to — written, linked, refused and why —
          // rather than the records the scan counted: sent as the node's
          // terminal status, the scan's count overwrote a partial node's real
          // figures and its refusals with a clean "all written".
          const outcome = result.objectOutcomes?.[name];
          const statuses = result.statuses?.[name];
          // Read and never sent: the platform writes them itself, or they
          // hang from one it does. Neither written nor failed, so said apart.
          const leftToThePlatform = (outcome?.leftToThePlatform ?? []).reduce(
            (sum, left) => sum + left.count,
            0,
          );
          const settled = {
            ...(outcome
              ? {
                  recordCount: outcome.written,
                  failureCount: outcome.failed,
                  linkedCount: outcome.linked,
                  refusals: outcome.refusals,
                  ...(leftToThePlatform > 0 ? { leftToThePlatform } : {}),
                }
              : {}),
            ...(statuses
              ? { statusesApplied: statuses.applied, statusRefusals: statuses.refusals }
              : {}),
          };
          if (completedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'completed', wave.order, {
              recordCount: scanResult.recordCounts.get(name) ?? 0,
              failureCount: 0,
              ...settled,
            });
          } else if (failedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'failed', wave.order, {
              ...settled,
              // The Salesforce message is the only actionable part; the generic
              // line is a fallback for a failure the executor could not
              // attribute to the node.
              error: result.nodeErrors?.[name] ?? `Execution failed for ${name}`,
            });
          } else if (skippedSet.has(name)) {
            this.sendNodeProgress(msg, name, 'completed', wave.order, {
              recordCount: 0,
              failureCount: 0,
            });
          }
        }
      }

      recordRun(
        result.totalFailure === 0 && failedSet.size === 0
          ? 'success'
          : result.totalSuccess > 0
            ? 'partial'
            : 'failure',
      );

      const response = buildResponse(this.deps, msg, 'autopilot:completed', {
        totalRecords: result.totalSuccess + result.totalFailure + result.totalSkipped,
        totalSuccessCount: result.totalSuccess,
        totalFailureCount: result.totalFailure,
        totalElapsedMs: result.elapsedMs,
        totalApiCalls: 0,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      // The nodes that settled before the run died say what it wrote.
      recordRun('failure');
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Execution failed: ${extractErrorMessage(err)}`,
      );
    } finally {
      this.executingOperations.delete(operation.id);
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
    requestMsg: InboundRequest,
    objectName: string,
    status: 'processing' | 'completed' | 'failed',
    wave: number,
    extra?: {
      recordCount?: number;
      failureCount?: number;
      /** Records the target already held, linked to instead of written. */
      linkedCount?: number;
      /** Why records were refused, by status code and fields. */
      refusals?: AutopilotRefusal[];
      /** Records born a draft given back their status after their children. */
      statusesApplied?: number;
      /** Why a status could not be given back. */
      statusRefusals?: AutopilotRefusal[];
      /** Records read and never sent: the platform writes them, or what they hang from, itself. */
      leftToThePlatform?: number;
      error?: string;
      /** API calls this node cost, so the page can total them as the run goes. */
      apiCallsUsed?: number;
    },
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

  /** Whether at least one operation is currently executing. */
  private hasExecutingOperation(): boolean {
    return this.executingOperations.size > 0;
  }

  private handlePause(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    if (!this.hasExecutingOperation()) {
      sendNotification(this.deps, 'warning', 'Autopilot', 'No autopilot execution in progress.');
      return;
    }
    try {
      this.orchestrator.pause();
      sendNotification(this.deps, 'info', 'Autopilot', 'Execution paused.');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:pause', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Pause failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private handleResume(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    if (!this.hasExecutingOperation()) {
      sendNotification(this.deps, 'warning', 'Autopilot', 'No autopilot execution in progress.');
      return;
    }
    try {
      this.orchestrator.resume();
      sendNotification(this.deps, 'info', 'Autopilot', 'Execution resumed.');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:resume', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Resume failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private handleSkipNode(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const parsed = validatePayload(
      autopilotSkipNodePayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;
    if (!this.hasExecutingOperation()) {
      sendNotification(this.deps, 'warning', 'Autopilot', 'No autopilot execution in progress.');
      return;
    }
    try {
      this.orchestrator.skip(payload.objectApiName);
      sendNotification(this.deps, 'info', 'Autopilot', `Skipped node: ${payload.objectApiName}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:skip-node', 'autopilot:error', msg, err);
      sendNotification(this.deps, 'error', 'Autopilot', `Skip failed: ${extractErrorMessage(err)}`);
    }
  }

  private handleComplianceReport(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      sendNotification(this.deps, 'error', 'Autopilot', 'Autopilot module is not initialized.');
      return;
    }
    const operation = this.resolveCurrentOperation();
    if (!operation?.profile || !operation.rules || !operation.scanResult) {
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
        operation.profile,
        operation.rules,
        operation.scanResult.recordCounts,
        '',
        '',
        operation.scanResult.totalObjectsScanned,
      );
      const response = buildResponse(this.deps, msg, 'autopilot:compliance-report', { report });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:compliance-report', 'autopilot:error', msg, err);
      sendNotification(
        this.deps,
        'error',
        'Autopilot',
        `Report generation failed: ${extractErrorMessage(err)}`,
      );
    }
  }
}
