/**
 * AutopilotOrchestrator — Central coordinator for the Autopilot module.
 * Orchestrates the full flow: scan -> graph -> compliance -> plan -> execute -> report.
 * Uses dependency injection for all sub-services.
 */

import type {
  AutopilotConfig,
  AutopilotGraph,
  ExecutionPlan,
  ComplianceFrameworkType,
  AutopilotAnonymizationRule,
  AutopilotEvent,
  PIIFieldDetection,
  ComplianceProfile,
  ComplianceReport,
  AutopilotPlanScope,
  GrappeConfig,
  AutopilotNodeCompletedEvent,
  AutopilotNodeFailedEvent,
  AutopilotObjectListing,
  ApiName,
} from '@sandforge/shared';
import type {
  SchemaScanner,
  AutopilotConnection,
  SchemaScanResult,
  ScanOptions,
} from './SchemaScanner.js';
import { personalDataNotCovered, withAiDetections } from './personalFields.js';
import type {
  DependencyGraphBuilder,
  GraphObjectDescribe,
  GraphFieldDescribe,
} from './DependencyGraphBuilder.js';
import type { ComplianceEngine } from './ComplianceEngine.js';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { ExecutionPlanGenerator } from './ExecutionPlanGenerator.js';
import type { RecordIdRemapper } from './RecordIdRemapper.js';
import type { AutopilotExecutor, ExecutionResult } from './AutopilotExecutor.js';
import type { AutopilotGrappeAdapter } from './AutopilotGrappeAdapter.js';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Grappe event emitted during partitioned autopilot execution */
export interface AutopilotGrappeEvent {
  type: 'grappe:started' | 'grappe:partitionProgress' | 'grappe:completed';
  payload: Record<string, unknown>;
}

/** Dependencies for the orchestrator, injected at construction time. */
export interface AutopilotOrchestratorDeps {
  /** Schema scanner for source/target org discovery. */
  schemaScanner: SchemaScanner;
  /** Builder for the dependency graph. */
  graphBuilder: DependencyGraphBuilder;
  /** Compliance engine for PII rules and reporting. */
  complianceEngine: ComplianceEngine;
  /** Smart anonymizer for PII fields. */
  anonymizer: SmartAnonymizer;
  /** Execution plan generator. */
  planGenerator: ExecutionPlanGenerator;
  /** Record ID remapper for lookup fields. */
  remapper: RecordIdRemapper;
  /**
   * Factory creating a fresh plan executor per execution. Pause/skip state
   * lives on the executor instance, so one instance per execution is what
   * isolates concurrent (and successive) runs from each other — a shared
   * singleton would leak `paused`/`skippedObjects` across executions.
   * Construction is trivial (deps + batch size), so per-execution instances
   * cost nothing.
   */
  createExecutor: () => AutopilotExecutor;
  /** Grappe adapter; its presence is part of what activates the start/end bracketing. */
  grappeAdapter: AutopilotGrappeAdapter;
  /** Grappe mode configuration. */
  grappeConfig?: GrappeConfig;
  /** Callback for grappe events. */
  onGrappeEvent?: (event: AutopilotGrappeEvent) => void;
}

/** Full result of an autopilot run. */
export interface AutopilotResult {
  /** The dependency graph. */
  graph: AutopilotGraph;
  /** The execution plan. */
  plan: ExecutionPlan;
  /** The compliance profile applied. */
  complianceProfile: ComplianceProfile;
  /** Execution result summary. */
  executionResult: ExecutionResult;
  /** Compliance report after execution. */
  complianceReport: ComplianceReport;
}

/** Listener for orchestrator events. */
export type OrchestratorEventListener = (event: AutopilotEvent) => void;

/**
 * Central orchestrator for the Autopilot module.
 * Coordinates the full flow: scan -> graph -> compliance -> plan -> execute -> report.
 */
export class AutopilotOrchestrator {
  private readonly deps: AutopilotOrchestratorDeps;
  private eventListeners: OrchestratorEventListener[] = [];
  /**
   * Executors currently inside `execute()`, most recently started last.
   * pause/resume/skip target the latest one — the fixed message protocol
   * carries no operation id, so "latest wins" matches the handler semantics.
   */
  private readonly runningExecutors: AutopilotExecutor[] = [];
  /**
   * Skips registered while no execution is running. They are applied to the
   * next execution (historical "skip before execute" semantics) and consumed,
   * so they never leak into executions beyond that one.
   */
  private readonly pendingSkips = new Set<string>();

  /** @param deps - Injected dependencies for all sub-services. */
  constructor(deps: AutopilotOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Register an event listener.
   * @param listener - Callback invoked for each event.
   * @returns Unsubscribe function.
   */
  onEvent(listener: OrchestratorEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Emit an event to all registered listeners.
   * Listener errors are silently caught to avoid breaking the orchestration flow.
   */
  private emitEvent(event: AutopilotEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        /* isolated — listener errors must not break orchestration */
      }
    }
  }

  /**
   * Before step 1: the objects a run may copy, for the user to choose from,
   * without a describe or a count of any (`SchemaScanner.listObjects`).
   */
  listObjects(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    includeStandardObjects: boolean,
  ): Promise<AutopilotObjectListing[]> {
    return this.deps.schemaScanner.listObjects(sourceConn, targetConn, includeStandardObjects);
  }

  /** The records of the objects the user picked, counted in the source: one `COUNT()` each. */
  countObjects(
    sourceConn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, number>> {
    return this.deps.schemaScanner.countObjects(sourceConn, objectNames);
  }

  /**
   * Step 1: Scan schemas on source and target orgs.
   * @param sourceConn - Connection to the source org.
   * @param targetConn - Connection to the target org.
   * @param config - Object selection (at least one object), standard-object
   *   flag, and how far the walk to the parents goes.
   * @param onProgress - Told what the scan is doing, for whoever waits on it.
   * @returns Schema scan result with describes, dependencies, and record counts.
   */
  async scanSchemas(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    config: Pick<
      AutopilotConfig,
      'selectedObjects' | 'includeStandardObjects' | 'maxDepth' | 'maxObjects'
    >,
    onProgress?: ScanOptions['onProgress'],
  ): Promise<SchemaScanResult> {
    this.emitEvent({ type: 'scan-started', timestamp: new Date().toISOString() });
    const result = await this.deps.schemaScanner.scan(
      sourceConn,
      targetConn,
      config.selectedObjects,
      config.includeStandardObjects,
      {
        ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
        ...(config.maxObjects !== undefined ? { maxObjects: config.maxObjects } : {}),
        ...(onProgress ? { onProgress } : {}),
      },
    );
    this.emitEvent({ type: 'scan-completed', timestamp: new Date().toISOString() });
    return result;
  }

  /**
   * Step 2: Build dependency graph from scan results.
   * Converts SchemaScanResult ObjectDescribeResult to GraphObjectDescribe format.
   * @param scanResult - Result from schema scanning.
   * @param batchSize - Batch size for API call estimation.
   * @returns The complete dependency graph.
   */
  buildGraph(scanResult: SchemaScanResult, batchSize?: number): AutopilotGraph {
    const describes = new Map<string, GraphObjectDescribe>();

    for (const [objectName, objDescribe] of scanResult.objectDescribes) {
      const fields: GraphFieldDescribe[] = objDescribe.fields.map((f) => ({
        name: f.name,
        type: f.type,
        nillable: f.nillable,
        referenceTo: f.referenceTo,
        relationshipName: f.relationshipName,
      }));
      describes.set(objectName, { name: objDescribe.name, fields });
    }

    return this.deps.graphBuilder.build(describes, scanResult.recordCounts, batchSize);
  }

  /**
   * Step 3: Build compliance profile and generate anonymization rules.
   * @param framework - The compliance framework to apply.
   * @param piiDetections - PII fields detected by the AI scanner, when one ran.
   * @param detected - PII fields the deterministic detector named
   *   (`detectPersonalFields`). The scanner's add to them and never replace
   *   them: without an AI scan, a profile built from its detections alone had
   *   none, and a GDPR plan anonymized nothing.
   * @returns Profile and rules for anonymization.
   */
  buildCompliance(
    framework: ComplianceFrameworkType,
    piiDetections: PIIFieldDetection[],
    detected: readonly PIIFieldDetection[] = [],
  ): { profile: ComplianceProfile; rules: AnonymizationRule[] } {
    const profile = this.deps.complianceEngine.buildProfile(
      framework,
      withAiDetections(detected, piiDetections),
    );
    const rules = this.deps.complianceEngine.generateRules(profile);
    return { profile, rules };
  }

  /**
   * Step 4: Generate execution plan from graph and compliance data.
   * @param graph - The dependency graph.
   * @param framework - The compliance framework.
   * @param rules - Anonymization rules to include in the plan.
   * @param scope - What the scan copies of each object and leaves out, said
   *   with the plan.
   * @returns A complete execution plan with waves and estimates.
   */
  generatePlan(
    graph: AutopilotGraph,
    framework: ComplianceFrameworkType,
    rules: AnonymizationRule[],
    scope?: AutopilotPlanScope,
  ): ExecutionPlan {
    const notCovered = personalDataNotCovered(
      framework,
      graph.nodes.map((node) => node.objectApiName),
      rules,
    );
    const summary = {
      ...this.deps.complianceEngine.buildSummary(rules),
      ...(notCovered.length > 0 ? { notCovered } : {}),
    };
    const generated = this.deps.planGenerator.generate(graph, framework, summary);
    const plan = scope ? { ...generated, scope } : generated;
    this.emitEvent({ type: 'plan-generated', timestamp: new Date().toISOString() });
    return plan;
  }

  /**
   * Step 5: Execute the plan.
   * @param plan - The execution plan to run.
   * @param graph - The dependency graph (for edge info).
   * @param rules - Anonymization rules to apply during execution.
   * @param recordCounts - Record counts per object.
   * @returns Execution result summary.
   */
  async executePlan(
    plan: ExecutionPlan,
    graph: AutopilotGraph,
    rules: AnonymizationRule[],
    recordCounts: Map<string, number>,
    /**
     * Called as each node settles, while the run is still going.
     *
     * The executor has always emitted these — `node-completed` carries the
     * records written and the API calls it took — and nothing ever subscribed.
     * The whole stream went into the void, so the panel called "live stats"
     * marked every node as processing before the run began, sat in silence for
     * its whole length, and filled in every number at the end. A run of two
     * waves showed "0 / 243 records, 0 / 131 API calls" throughout.
     */
    onNodeSettled?: (event: AutopilotNodeCompletedEvent | AutopilotNodeFailedEvent) => void,
    /**
     * Stops the run between two calls, paused or not: see
     * `AutopilotExecutor.execute`. The result then says it was stopped and
     * which objects it did not write.
     */
    signal?: AbortSignal,
    /**
     * The objects read by id, with the ids — the scan's `parentIds`: of an
     * object that was not selected, only the records the selection
     * references are copied.
     */
    parentIds?: ReadonlyMap<string, readonly string[]>,
  ): Promise<ExecutionResult> {
    const totalRecords = Array.from(recordCounts.values()).reduce((s, c) => s + c, 0);
    const grappeActive = this.isGrappeActive(totalRecords);
    // One id for the run: the closing event names the run the opening one
    // started, not a second one minted when the executor returns.
    const operationId = `autopilot-${Date.now()}`;

    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:started',
        payload: {
          operationId,
          totalPartitions: plan.waves.length,
          totalRecords,
        },
      });
    }

    this.emitEvent({ type: 'execution-started', timestamp: new Date().toISOString() });
    // One executor per execution: pause/skip state is per-run, never shared.
    const executor = this.deps.createExecutor();
    /*
     * `on` hands back its own unsubscribe, and both are called in the `finally`
     * below. The executor is per-run and goes out of scope there, but these two
     * listeners close over the caller's message and its broker, so they are let
     * go explicitly rather than left to the garbage collector's judgement.
     */
    const noUnsubscribe = (): void => {};
    const offCompleted = onNodeSettled
      ? executor.on('node-completed', onNodeSettled)
      : noUnsubscribe;
    const offFailed = onNodeSettled ? executor.on('node-failed', onNodeSettled) : noUnsubscribe;
    for (const skipped of this.pendingSkips) {
      executor.skip(skipped);
    }
    this.pendingSkips.clear();
    this.runningExecutors.push(executor);
    let result: ExecutionResult;
    try {
      result = await executor.execute(plan, graph.edges, rules, recordCounts, signal, parentIds);
    } finally {
      this.runningExecutors.splice(this.runningExecutors.indexOf(executor), 1);
      offCompleted();
      offFailed();
    }
    // Deliberately after the try, not inside it: a crashed execution rethrows,
    // and neither the completion event nor the grappe:completed below may fire
    // for a run that never finished.
    this.emitEvent({ type: 'execution-completed', timestamp: new Date().toISOString() });

    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:completed',
        payload: {
          operationId,
          totalProcessed: result.totalSuccess + result.totalSkipped,
          totalFailed: result.totalFailure,
        },
      });
    }

    return result;
  }

  /** Check whether grappe mode should activate based on record count and config. */
  private isGrappeActive(totalRecords: number): boolean {
    const config = this.deps.grappeConfig;
    return !!(
      config?.enabled &&
      this.deps.grappeAdapter &&
      totalRecords >= config.autoActivateThreshold
    );
  }

  /**
   * Step 6: Generate compliance report after execution.
   * @param profile - The compliance profile used.
   * @param rules - Anonymization rules applied.
   * @param recordCounts - Records processed per object.
   * @param sourceOrgId - Source Salesforce org ID.
   * @param targetOrgId - Target Salesforce org ID.
   * @param totalFieldsScanned - Total fields scanned for PII.
   * @returns A tamper-evident compliance report.
   */
  generateReport(
    profile: ComplianceProfile,
    rules: AnonymizationRule[],
    recordCounts: Map<string, number>,
    sourceOrgId: string,
    targetOrgId: string,
    totalFieldsScanned: number,
  ): ComplianceReport {
    return this.deps.complianceEngine.generateReport(
      profile,
      rules,
      recordCounts,
      sourceOrgId,
      targetOrgId,
      totalFieldsScanned,
    );
  }

  /** Most recently started execution still running ("latest wins" target). */
  private latestRunningExecutor(): AutopilotExecutor | undefined {
    return this.runningExecutors[this.runningExecutors.length - 1];
  }

  /**
   * Pause the most recently started running execution. Other simultaneous
   * executions keep running; a pause with no execution in flight is a no-op
   * (it must not leak into the next execution).
   */
  pause(): void {
    this.latestRunningExecutor()?.pause();
  }

  /** Resume the most recently started running execution after a pause. */
  resume(): void {
    this.latestRunningExecutor()?.resume();
  }

  /**
   * Skip an object during execution. Targets the most recently started
   * running execution; when nothing is running the skip is held and applied
   * to the next execution only (see {@link pendingSkips}).
   * @param objectApiName - The object to skip.
   */
  skip(objectApiName: string): void {
    const running = this.latestRunningExecutor();
    if (running) {
      running.skip(objectApiName);
      return;
    }
    this.pendingSkips.add(objectApiName);
  }
}
