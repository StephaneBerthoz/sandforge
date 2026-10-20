import type {
  AuditObjectCounts,
  AutopilotGraph,
  ExecutionPlan,
  ComplianceProfile,
  AutopilotAnonymizationRule,
  AutopilotRefusal,
  AutopilotStopLeftover,
  CurrencyReplaced,
  PriceCurrencySettled,
} from '@sandforge/shared';
import { guardTierOf } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendNotification,
  sendHandlerError,
  PRODUCTION_GUARD_MISSING,
  GUARD_REFUSAL,
  guardBlockedError,
} from './HandlerTypes.js';
import {
  validatePayload,
  autopilotListObjectsPayloadSchema,
  autopilotCountObjectsPayloadSchema,
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
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import {
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  readDataStorage,
  readEmailLimits,
  type DataStorage,
  type EmailCheck,
  type WritePlan,
} from '../../modules/forge/ForgeRunGate.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import {
  autopilotEmails,
  autopilotWritePlan,
  gateAutopilotWrite,
  objectsThePlanWrites,
} from '../../modules/autopilot/AutopilotRunGate.js';
import { detectPersonalFields } from '../../modules/autopilot/personalFields.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

/** Message types handled by AutopilotHandler. */
const AUTOPILOT_TYPES = new Set([
  'autopilot:list-objects',
  'autopilot:count-objects',
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

/** How long the target's `/limits` may take to say what data storage it has left. */
const LIMITS_TIMEOUT_MS = 30_000;

/** How long the read of the target's automation may take, as Forge's may. */
const AUTOMATION_TIMEOUT_MS = 60_000;

/**
 * The codes a run's write gate stops it with on the error channel, each
 * worded by the page in the interface language: Forge's gate codes, under
 * Autopilot's name so neither page reads the other's.
 */
export const AUTOPILOT_GATE_CODES = {
  STORAGE_EXCEEDED: 'AUTOPILOT_STORAGE_EXCEEDED',
  WRITE_DECLINED: 'AUTOPILOT_WRITE_DECLINED',
  CONFIRMATION_UNAVAILABLE: 'AUTOPILOT_CONFIRMATION_UNAVAILABLE',
} as const;

/**
 * How a request is refused while the Autopilot module has not reached the
 * handler: its nine modules load after activation (see
 * `composition/autopilotComposition.ts`), and a host whose load failed never
 * gets one. Not `NOT_INITIALIZED`: under that code the page says Production
 * Guard is missing.
 */
export const AUTOPILOT_NOT_READY = {
  code: 'AUTOPILOT_NOT_READY',
  message: 'Autopilot module is not initialized.',
} as const;

/**
 * The requests the page sends without waiting for an answer — Pause, Resume
 * and Skip — for which a notification is the only word that reaches the user.
 */
const SENT_WITHOUT_WAITING = new Set([
  'autopilot:pause',
  'autopilot:resume',
  'autopilot:skip-node',
]);

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
  private registry?: BackgroundOperationRegistry;
  private liveTracker?: LiveOperationTracker;
  /**
   * What reads the target's automation for a run's gate: the handler's own
   * reader, as Forge reads it, unless another is set. It was Forge's, handed
   * over once Forge's composition had loaded: a run started before that, the
   * Forge page never opened, counted none of the emails the target's flows
   * send, and said so.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };
  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Another reader of the target's automation than the handler's own: a run's
   * gate counts the emails the target's flows send as the plan's records go in.
   */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** The handler's own reader of the target's automation, as Forge reads it, off the activation path. */
  private ownReader(): Promise<TargetAutomationReader> {
    this.reader ??= import('../../modules/forge/TargetAutomationReader.js').then(
      ({ TargetAutomationReader, targetAutomationQueries }) =>
        new TargetAutomationReader(
          targetAutomationQueries((orgId) =>
            getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager),
          ),
        ),
    );
    return this.reader;
  }

  /** Inject autopilot orchestrator. */
  setOrchestrator(orchestrator: AutopilotOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Inject the registry `execution:abort` stops runs through. Each run is
   * registered under the id of its `autopilot:execute` request.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** Inject the tracker the Monitor's Live Operations lists runs from. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
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
      case 'autopilot:list-objects':
        await this.handleListObjects(msg);
        return true;
      case 'autopilot:count-objects':
        await this.handleCountObjects(msg);
        return true;
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

  /**
   * Refuse a request the module is not there to serve, under one code the
   * page words in the interface language.
   *
   * The seven paths each sent "Autopilot module is not initialized." as an
   * English notification and nothing else, so a page waiting on the answer
   * — the scan, the plan, the run, the report — kept its spinner until its
   * own timeout: thirty seconds, ten minutes for a run. The request is now
   * answered, and the page shows the refusal where it shows its other
   * errors; a notification beside it would say it twice. Pause, Resume and
   * Skip wait for no answer, and keep the notification, with the code.
   */
  private refuseNotReady(msg: InboundRequest): void {
    sendHandlerError(
      this.deps,
      msg.type,
      'autopilot:error',
      msg,
      new Error(AUTOPILOT_NOT_READY.message),
      { code: AUTOPILOT_NOT_READY.code },
    );
    if (SENT_WITHOUT_WAITING.has(msg.type)) {
      sendNotification(this.deps, 'error', 'Autopilot', AUTOPILOT_NOT_READY.message, {
        code: AUTOPILOT_NOT_READY.code,
      });
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

  /**
   * The object picker's list: the two orgs' global describes, and nothing per
   * object. The first scan the page asked for described and counted every
   * object of the org before the user had picked one.
   */
  private async handleListObjects(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      this.refuseNotReady(msg);
      return;
    }
    const parsed = validatePayload(
      autopilotListObjectsPayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const sourceConn = (await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as AutopilotConnection;
      const targetConn = (await getJsforceConnection(
        parsed.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as AutopilotConnection;
      const objects = await this.orchestrator.listObjects(
        sourceConn,
        targetConn,
        parsed.includeStandardObjects,
      );
      const response = buildResponse(this.deps, msg, 'autopilot:objects-listed', {
        objects: objects as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} count=${objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:list-objects', 'autopilot:error', msg, err);
    }
  }

  /**
   * The records of the objects the user picked, counted in the source: a page
   * at a time, as the picker asks. An object the org will not count is left
   * out, and the picker shows no count for it.
   */
  private async handleCountObjects(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      this.refuseNotReady(msg);
      return;
    }
    const parsed = validatePayload(
      autopilotCountObjectsPayloadSchema,
      msg,
      'autopilot:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const sourceConn = (await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as AutopilotConnection;
      const counts = await this.orchestrator.countObjects(sourceConn, parsed.objectApiNames);
      const response = buildResponse(this.deps, msg, 'autopilot:objects-counted', {
        counts: Object.fromEntries(counts),
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'autopilot:count-objects', 'autopilot:error', msg, err);
    }
  }

  private async handleScanSchema(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.orchestrator) {
      this.refuseNotReady(msg);
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
      // How far the walk to the parents goes: what the request says, the
      // scanner's bounds — Forge's — otherwise. Unbounded, a plan for two
      // objects held six hundred.
      const scanResult = await this.orchestrator.scanSchemas(sourceConn, targetConn, {
        selectedObjects: payload.selectedObjects,
        includeStandardObjects: payload.includeStandardObjects,
        ...(payload.maxDepth !== undefined ? { maxDepth: payload.maxDepth } : {}),
        ...(payload.maxObjects !== undefined ? { maxObjects: payload.maxObjects } : {}),
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
      this.refuseNotReady(msg);
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
      // The personal fields the detector names, whenever the framework
      // anonymizes: the panel has no AI scan to hand the profile, and with
      // none a GDPR plan anonymized nothing.
      const detected =
        payload.complianceFramework !== 'none' && operation.scanResult
          ? detectPersonalFields(
              this.deps.infraServices?.piiDetector ?? new PIIDetector(),
              operation.scanResult.objectDescribes,
            )
          : [];
      const { profile, rules } = this.orchestrator.buildCompliance(
        payload.complianceFramework,
        [],
        detected,
      );
      operation.profile = profile;
      operation.rules = rules;
      const plan = this.orchestrator.generatePlan(
        operation.graph,
        payload.complianceFramework,
        rules,
        operation.scanResult?.scope,
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
      this.refuseNotReady(msg);
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
      // The page says it in the interface language by its code. No
      // notification beside it: one said the same refusal in English.
      sendHandlerError(
        this.deps,
        'autopilot:execute',
        'autopilot:error',
        msg,
        new Error(PRODUCTION_GUARD_MISSING.message),
        { code: PRODUCTION_GUARD_MISSING.code },
      );
      return;
    }
    const totalRecords = Array.from(scanResult.recordCounts.values()).reduce((s, c) => s + c, 0);

    // The run's stop. `execution:abort` with this request's id reaches it
    // through the registry: the page's Stop sends it, and Live Operations'
    // Cancel. Registered before the guard is asked, so a stop sent while the
    // confirmation waits is not lost: the run then writes nothing.
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this keeps a host with none
    // from an unhandled rejection.
    tracked.catch(() => {});
    this.registry?.register(msg.id, 'autopilot', 'Autopilot run', tracked, abortController);

    const targetOrg = this.deps.orgManager.getOrg(operation.targetOrgId);
    const guardRequest = {
      orgId: operation.targetOrgId,
      orgTier: guardTierOf(targetOrg),
      operation: 'insert' as const,
      objectName: plan.waves[0]?.objects[0] ?? 'AutopilotData',
      recordCount: totalRecords,
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
    // Each with the code every write path is stopped with: the page says it
    // in the interface language by it, where these messages are English. No
    // notification beside it: one carried the same refusal, in English, next
    // to the page's translated error.
    if (decision === 'refused') {
      const refusal = guardBlockedError(check.blockedReason ?? check.impactSummary);
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, refusal, {
        code: GUARD_REFUSAL.blocked,
      });
      // Settled, or the registry lists it as running for the session.
      settle(refusal);
      return;
    }
    // `safety.requireProdConfirmation`: explicit user consent before
    // writing to a production org.
    if (decision === 'declined') {
      const message = 'Operation cancelled by user (production confirmation declined).';
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, new Error(message), {
        code: GUARD_REFUSAL.declined,
      });
      settle(new Error(message));
      return;
    }

    // The plan's records against the setting, the target's data storage and
    // the emails its flows send for them, as Forge's gate holds a clone:
    // refused past the storage, asked about past the setting, near the
    // storage or past a daily email limit, before anything is written. A
    // person account is sized at 4 KB, as Salesforce counts it.
    const writePlan = autopilotWritePlan(plan, scanResult.recordCounts, scanResult.personAccounts);
    const gate = await gateAutopilotWrite({
      plan: writePlan,
      storage: await this.readTargetDataStorage(operation.targetOrgId),
      confirmAboveRecords: this.confirmAboveRecords(),
      emails: await this.targetEmails(operation.targetOrgId, plan, writePlan),
      org: targetOrg?.alias ?? operation.targetOrgId,
      orgTier: guardRequest.orgTier,
      confirm: (question) => guard.confirmRun(question),
    });
    if (!gate.go) {
      recordWriteRun(this.deps, {
        action: 'autopilot_execute',
        module: 'autopilot',
        operationId: msg.id,
        orgId: operation.targetOrgId,
        outcome: 'stopped',
        guard: guardDecision,
        code: gate.code,
      });
      const stop = new Error(gate.message);
      sendHandlerError(this.deps, 'autopilot:execute', 'autopilot:error', msg, stop, {
        code: AUTOPILOT_GATE_CODES[gate.code],
      });
      settle(stop);
      return;
    }

    this.liveTracker?.register(msg.id, 'autopilot', 'Autopilot run', totalRecords);
    this.executingOperations.add(operation.id);
    /** Per object, what the run wrote, as each node settles. */
    const written = new Map<string, AuditObjectCounts>();
    /** A run is recorded once, whichever way it ends. */
    let recorded = false;
    const recordRun = (
      outcome: 'success' | 'partial' | 'failure' | 'stopped' | 'cancelled',
    ): void => {
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
        // Stopped before it wrote anything, under the code a cancelled
        // Forge run is recorded with: read as a failure otherwise.
        ...(outcome === 'stopped' ? { code: RUN_CANCELLED } : {}),
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
          // Live Operations shows the run's records as its nodes settle.
          const processed = [...written.values()].reduce((s, c) => s + c.created + c.failed, 0);
          this.liveTracker?.updateProgress(
            msg.id,
            totalRecords > 0 ? Math.round((processed / totalRecords) * 100) : 0,
            processed,
            totalRecords,
            name,
          );
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
        abortController.signal,
        // Of an object that was not selected, only the records the selection
        // references: read by id, as the scan found them.
        scanResult.parentIds,
        // Emails and phone numbers neutralized unless the review step's box
        // was unticked: see `AutopilotRunOptions`.
        payload.keepContactPoints === true ? { keepContactPoints: true } : {},
      );

      // Send node-progress 'completed' or 'failed' per node based on execution result
      const completedSet = new Set(result.completedObjects);
      const failedSet = new Set(result.failedObjects);
      const skippedSet = new Set(result.skippedObjects);
      const stoppedSet = new Set(result.stoppedObjects ?? []);
      /**
       * What a stop kept the updates after the waves from giving back, per
       * object: records that keep a lookup empty, records left a draft.
       */
      const leftByStop: AutopilotStopLeftover[] = [];
      /** The emails a stop kept from the target while they waited for their task. */
      let emailsHeldForTheirTask = 0;

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
                  // Said in the node's detail, as Forge's results say them.
                  ...(outcome.currenciesReplaced
                    ? { currenciesReplaced: outcome.currenciesReplaced }
                    : {}),
                  ...(outcome.pricesSettled ? { pricesSettled: outcome.pricesSettled } : {}),
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
          } else if (stoppedSet.has(name)) {
            // Cut short or never reached by the stop: what it wrote, and what
            // it never sent, which the audit counts apart — the emails that
            // waited for their task among them.
            const notSent = outcome?.notSent ?? 0;
            emailsHeldForTheirTask += outcome?.heldForTheirTask ?? 0;
            written.set(name, {
              ...emptyCounts(name),
              created: outcome?.written ?? 0,
              failed: outcome?.failed ?? 0,
              ...(notSent > 0 ? { notSent } : {}),
            });
            this.sendNodeProgress(msg, name, 'stopped', wave.order, {
              ...settled,
              recordCount: outcome?.written ?? 0,
              failureCount: outcome?.failed ?? 0,
              ...(notSent > 0 ? { notSent } : {}),
            });
          }
          // Written, and left unfinished by the stop: the audit counts them,
          // and the page says them with what the run did not write, so the
          // user knows what is left to fix. Neither was counted anywhere.
          const lookupsLeftEmpty = outcome?.lookupsLeftEmpty ?? 0;
          const statusesNotGivenBack = outcome?.statusesNotGivenBack ?? 0;
          if (lookupsLeftEmpty + statusesNotGivenBack > 0) {
            const left = {
              ...(lookupsLeftEmpty > 0 ? { lookupsLeftEmpty } : {}),
              ...(statusesNotGivenBack > 0 ? { statusesNotGivenBack } : {}),
            };
            leftByStop.push({ objectApiName: name, ...left });
            written.set(name, {
              ...(written.get(name) ?? {
                ...emptyCounts(name),
                created: outcome?.written ?? 0,
                failed: outcome?.failed ?? 0,
              }),
              ...left,
            });
          }
        }
      }

      // Stopped by the user, the run is cancelled once it wrote a record or
      // had one refused, its counts saying which: it was recorded as partial,
      // as a run the org cut short is.
      recordRun(
        result.stopped
          ? result.totalSuccess + result.totalFailure > 0
            ? 'cancelled'
            : 'stopped'
          : result.totalFailure === 0 && failedSet.size === 0
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
        ...(result.stopped
          ? {
              stopped: true,
              notWritten: result.stoppedObjects ?? [],
              ...(leftByStop.length > 0 ? { leftByStop } : {}),
              ...(emailsHeldForTheirTask > 0 ? { emailsHeldForTheirTask } : {}),
            }
          : {}),
      });
      this.deps.broker.postToWebview(response);
      if (result.stopped) this.liveTracker?.cancel(msg.id);
      else this.liveTracker?.complete(msg.id);
      settle();
    } catch (err: unknown) {
      this.liveTracker?.fail(msg.id, extractErrorMessage(err));
      settle(err);
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

  /** `sandforge.safety.confirmAboveRecords`: the volume past which a run asks before it writes; 0 never asks. */
  private confirmAboveRecords(): number {
    const value = this.deps.services?.getSandforgeSetting?.<unknown>(
      'safety.confirmAboveRecords',
      DEFAULT_CONFIRM_ABOVE_RECORDS,
    );
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_CONFIRM_ABOVE_RECORDS;
  }

  /** The data storage the target has, or why it could not be read. */
  private async readTargetDataStorage(
    targetOrgId: string,
  ): Promise<DataStorage | { unread: string }> {
    try {
      const conn = await getJsforceConnection(
        targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      return await new TimeoutManager(LIMITS_TIMEOUT_MS).withTimeout('autopilot:limits', () =>
        readDataStorage(conn),
      );
    } catch (err: unknown) {
      return { unread: extractErrorMessage(err) };
    }
  }

  /**
   * The emails the target's flows send as the plan's records go in, per daily
   * limit, against what the target has left: its automation on the objects
   * the plan writes, read as Forge reads it, and its limits when something
   * sends. What could not be read is logged and asks nothing, as Forge's
   * write gate does: the gate counts emails it can count.
   */
  private async targetEmails(
    targetOrgId: string,
    plan: Pick<ExecutionPlan, 'waves'>,
    writePlan: WritePlan,
  ): Promise<EmailCheck[]> {
    const reader = this.targetAutomation;
    const emails = await autopilotEmails({
      plan: writePlan,
      objects: objectsThePlanWrites(plan),
      readAutomation: (objects) =>
        new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('autopilot:automation', () =>
          reader.read(targetOrgId, objects),
        ),
      readLimits: async () => {
        const conn = await getJsforceConnection(
          targetOrgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        );
        return new TimeoutManager(LIMITS_TIMEOUT_MS).withTimeout('autopilot:limits', () =>
          readEmailLimits(conn),
        );
      },
    });
    if (emails.unread !== undefined) {
      this.deps.log(
        `[WARN] autopilot:execute: the emails the target's flows send were not counted: ` +
          `${emails.unread} could not be read`,
      );
    }
    for (const check of emails.checks.filter((c) => c.verdict === 'unread')) {
      this.deps.log(
        `[WARN] autopilot:execute: about ${check.emails} ${check.limit} from the target's ` +
          `flows, against a limit that could not be read: ${check.unread ?? ''}`,
      );
    }
    return emails.checks;
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
    status: 'processing' | 'completed' | 'failed' | 'stopped',
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
      /** Records a stopped run never sent. */
      notSent?: number;
      /** Records written in another currency than they were read in, and their amounts. */
      currenciesReplaced?: CurrencyReplaced[];
      /** Prices read in a currency the target lacks, and how each went. */
      pricesSettled?: PriceCurrencySettled[];
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
      this.refuseNotReady(msg);
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
      this.refuseNotReady(msg);
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
      this.refuseNotReady(msg);
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
      this.refuseNotReady(msg);
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
