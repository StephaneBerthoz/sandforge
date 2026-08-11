import type { BaseMessage } from './base.messages.js';
import type {
  AutopilotGraph,
  ExecutionPlan,
  AnonymizationOverride,
  AutopilotNodeStatus,
} from '../autopilot.types.js';
import type { ComplianceFrameworkType } from '../common.types.js';
import type { ComplianceReport } from '../compliance.types.js';

/** Request to scan source/target org schemas and build dependency graph */
export interface AutopilotScanSchemaRequest extends BaseMessage {
  type: 'autopilot:scan-schema';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    selectedObjects: string[];
    includeStandardObjects: boolean;
  };
}

/** Schema scan result with full dependency graph */
export interface AutopilotSchemaResult extends BaseMessage {
  type: 'autopilot:schema-result';
  payload: {
    graph: AutopilotGraph;
  };
}

/** Request to generate an execution plan from the graph */
export interface AutopilotGeneratePlanRequest extends BaseMessage {
  type: 'autopilot:generate-plan';
  payload: {
    complianceFramework: ComplianceFrameworkType;
    maxRecordsPerObject: number;
    objectFilters: Record<string, string>;
    overrides: AnonymizationOverride[];
  };
}

/** Execution plan ready for review */
export interface AutopilotPlanReady extends BaseMessage {
  type: 'autopilot:plan-ready';
  payload: {
    plan: ExecutionPlan;
    graph: AutopilotGraph;
  };
}

/** Request to start autopilot execution */
export interface AutopilotExecuteRequest extends BaseMessage {
  type: 'autopilot:execute';
  payload: {
    grappeThreshold: number;
  };
}

/** Progress update for a node during execution */
export interface AutopilotNodeProgress extends BaseMessage {
  type: 'autopilot:node-progress';
  payload: {
    objectApiName: string;
    status: AutopilotNodeStatus;
    progress: number;
    recordsProcessed: number;
    recordsTotal: number;
    apiCallsUsed: number;
    elapsedMs: number;
  };
}

/** Node completed successfully */
export interface AutopilotNodeCompleted extends BaseMessage {
  type: 'autopilot:node-completed';
  payload: {
    objectApiName: string;
    successCount: number;
    failureCount: number;
    elapsedMs: number;
    apiCallsUsed: number;
  };
}

/** Node failed during execution */
export interface AutopilotNodeFailed extends BaseMessage {
  type: 'autopilot:node-failed';
  payload: {
    objectApiName: string;
    errors: string[];
    partialSuccessCount: number;
  };
}

/** Request to pause autopilot execution */
export interface AutopilotPauseRequest extends BaseMessage {
  type: 'autopilot:pause';
}

/** Request to resume autopilot execution */
export interface AutopilotResumeRequest extends BaseMessage {
  type: 'autopilot:resume';
}

/** Request to skip a node during execution */
export interface AutopilotSkipNodeRequest extends BaseMessage {
  type: 'autopilot:skip-node';
  payload: {
    objectApiName: string;
  };
}

/** Autopilot execution completed */
export interface AutopilotCompleted extends BaseMessage {
  type: 'autopilot:completed';
  payload: {
    totalRecords: number;
    totalSuccessCount: number;
    totalFailureCount: number;
    totalElapsedMs: number;
    totalApiCalls: number;
  };
}

/** Compliance report ready after execution */
export interface AutopilotComplianceReportReady extends BaseMessage {
  type: 'autopilot:compliance-report';
  payload: {
    report: ComplianceReport;
  };
}

/** Error response for autopilot operations (emitted via sendHandlerError). */
export interface AutopilotErrorResponse extends BaseMessage {
  type: 'autopilot:error';
  payload: { message: string; code: string; retryable: boolean };
}
