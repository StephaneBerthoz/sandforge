import type { MutedAutomation } from '../../utils/automation-mute.js';
import type { BaseMessage } from './base.messages.js';
import type {
  AutopilotGraph,
  AutopilotObjectListing,
  ExecutionPlan,
  AnonymizationOverride,
  AutopilotNodeStatus,
} from '../autopilot.types.js';
import type { ComplianceFrameworkType } from '../common.types.js';
import type { ComplianceReport } from '../compliance.types.js';

/**
 * Request to list the objects a run may copy: the object picker's list, read
 * from the two orgs' global describes and nothing else.
 */
export interface AutopilotListObjectsRequest extends BaseMessage {
  type: 'autopilot:list-objects';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    includeStandardObjects: boolean;
  };
}

/** The objects a run may copy, without a describe or a count of any. */
export interface AutopilotObjectsListed extends BaseMessage {
  type: 'autopilot:objects-listed';
  payload: {
    objects: AutopilotObjectListing[];
  };
}

/** Request to count the records of a few listed objects: the ones the user picked. */
export interface AutopilotCountObjectsRequest extends BaseMessage {
  type: 'autopilot:count-objects';
  payload: {
    sourceOrgId: string;
    objectApiNames: string[];
  };
}

/** Records per object counted; an object the org would not count is left out. */
export interface AutopilotObjectsCounted extends BaseMessage {
  type: 'autopilot:objects-counted';
  payload: {
    counts: Record<string, number>;
  };
}

/** Request to scan source/target org schemas and build dependency graph */
export interface AutopilotScanSchemaRequest extends BaseMessage {
  type: 'autopilot:scan-schema';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    selectedObjects: string[];
    includeStandardObjects: boolean;
    /** Lookups followed from a selected object, at most: Forge's full depth (5) unless said. */
    maxDepth?: number;
    /** Objects the plan holds, the selected ones included: Forge's object cap (50) unless said. */
    maxObjects?: number;
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
    /**
     * Mute the target's automation for the run: assign the user it writes as,
     * for its duration, the permission sets holding the bypasses the target's
     * flows, processes and workflow rules test to stay quiet, and take them
     * back as it ends. Refused on a production org, and for a user who cannot
     * assign permission sets; what no bypass keeps quiet still runs, and is
     * asked about as ever.
     */
    muteAutomation?: boolean;
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

/**
 * What a stopped run left undone in the records it wrote to one object: the
 * updates that follow the waves are writes, and a stop sends none of them.
 */
export interface AutopilotStopLeftover {
  objectApiName: string;
  /** Records written without a lookup the second pass would have filled: they keep it empty. */
  lookupsLeftEmpty?: number;
  /** Records written at a draft status never given back the one they had in the source. */
  statusesNotGivenBack?: number;
}

/** Autopilot execution completed, or stopped */
export interface AutopilotCompleted extends BaseMessage {
  type: 'autopilot:completed';
  payload: {
    totalRecords: number;
    totalSuccessCount: number;
    totalFailureCount: number;
    totalElapsedMs: number;
    totalApiCalls: number;
    /**
     * Set when the run was stopped (`execution:abort`, with the id of the
     * `autopilot:execute` request): the batch in flight was answered and
     * counted, and nothing was written after it.
     */
    stopped?: boolean;
    /** The objects of a stopped run it did not write whole, in plan order. */
    notWritten?: string[];
    /**
     * Per object of a stopped run, in plan order, the records it wrote and
     * left unfinished: what the user has to fix. Absent when there are none.
     */
    leftByStop?: AutopilotStopLeftover[];
    /**
     * Of a stopped run, the emails on a case it read and held back until
     * the task each names was in, and never sent: the stop came first.
     * Counted among the email node's records not sent. Absent when none.
     */
    emailsHeldForTheirTask?: number;
    /**
     * What the run muted of the target's automation, when it was asked to
     * (`muteAutomation`): the permission sets assigned to the user it wrote as
     * for its duration, what they silenced, what still ran, and whether they
     * were taken back. Absent when it was not asked.
     */
    mutedAutomation?: MutedAutomation;
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
