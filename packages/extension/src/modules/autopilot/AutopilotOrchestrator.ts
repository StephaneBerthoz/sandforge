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
  GrappeConfig,
} from '@sandforge/shared';
import type { SchemaScanner, AutopilotConnection, SchemaScanResult } from './SchemaScanner.js';
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
  /** Plan executor with pause/resume/skip. */
  executor: AutopilotExecutor;
  /** Grappe adapter for parallel partitioning. */
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
   * Step 1: Scan schemas on source and target orgs.
   * @param sourceConn - Connection to the source org.
   * @param targetConn - Connection to the target org.
   * @param config - Object selection (empty = auto-detect all) and standard-object flag.
   * @returns Schema scan result with describes, dependencies, and record counts.
   */
  async scanSchemas(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    config: Pick<AutopilotConfig, 'selectedObjects' | 'includeStandardObjects'>,
  ): Promise<SchemaScanResult> {
    this.emitEvent({ type: 'scan-started', timestamp: new Date().toISOString() });
    const result = await this.deps.schemaScanner.scan(
      sourceConn,
      targetConn,
      config.selectedObjects,
      config.includeStandardObjects,
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
   * @param piiDetections - PII fields detected by the AI scanner.
   * @returns Profile and rules for anonymization.
   */
  buildCompliance(
    framework: ComplianceFrameworkType,
    piiDetections: PIIFieldDetection[],
  ): { profile: ComplianceProfile; rules: AnonymizationRule[] } {
    const profile = this.deps.complianceEngine.buildProfile(framework, piiDetections);
    const rules = this.deps.complianceEngine.generateRules(profile);
    return { profile, rules };
  }

  /**
   * Step 4: Generate execution plan from graph and compliance data.
   * @param graph - The dependency graph.
   * @param framework - The compliance framework.
   * @param rules - Anonymization rules to include in the plan.
   * @returns A complete execution plan with waves and estimates.
   */
  generatePlan(
    graph: AutopilotGraph,
    framework: ComplianceFrameworkType,
    rules: AnonymizationRule[],
  ): ExecutionPlan {
    const summary = this.deps.complianceEngine.buildSummary(rules);
    const plan = this.deps.planGenerator.generate(graph, framework, summary);
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
  ): Promise<ExecutionResult> {
    const totalRecords = Array.from(recordCounts.values()).reduce((s, c) => s + c, 0);
    const grappeActive = this.isGrappeActive(totalRecords);

    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:started',
        payload: {
          operationId: `autopilot-${Date.now()}`,
          totalPartitions: plan.waves.length,
          totalRecords,
        },
      });
    }

    this.emitEvent({ type: 'execution-started', timestamp: new Date().toISOString() });
    const result = await this.deps.executor.execute(plan, graph.edges, rules, recordCounts);
    this.emitEvent({ type: 'execution-completed', timestamp: new Date().toISOString() });

    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:completed',
        payload: {
          operationId: `autopilot-${Date.now()}`,
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

  /** Pause execution. Delegates to the executor. */
  pause(): void {
    this.deps.executor.pause();
  }

  /** Resume execution after a pause. Delegates to the executor. */
  resume(): void {
    this.deps.executor.resume();
  }

  /**
   * Skip an object during execution.
   * @param objectApiName - The object to skip.
   */
  skip(objectApiName: string): void {
    this.deps.executor.skip(objectApiName);
  }
}
