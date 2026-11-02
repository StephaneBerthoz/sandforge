import type { MutedAutomation } from '../../utils/automation-mute.js';
import type { BaseMessage } from './base.messages.js';
import type {
  AutopilotGraph,
  AutopilotObjectListing,
  ExecutionPlan,
  AnonymizationOverride,
  AutopilotFitMode,
  AutopilotFitReport,
  AutopilotPlanWriteGate,
  AutopilotRefusal,
  AutopilotRunStatus,
} from '../autopilot.types.js';
import type {
  ComplianceFrameworkType,
  CurrencyReplaced,
  PriceCurrencySettled,
  RecordTypeGiven,
} from '../common.types.js';
import type { RunCheckpointInfo, RunCheckpointRequest } from '../checkpoint.types.js';
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
    /**
     * What the plan comes to against the target's data storage, read once
     * with `/limits` as it is made: said before Run, with what fitting it
     * would take. Absent when it was not read.
     */
    writeGate?: AutopilotPlanWriteGate;
    /**
     * What an `autopilot:fit-plan` came to when it fitted nothing: the plan
     * fits as it stands (`heldBy: 'whole'`), or `cannotFit` says why nothing
     * is proposed. The plan answered is then the one under review.
     */
    fitNotApplied?: AutopilotFitReport;
  };
}

/**
 * `autopilot:fit-plan`. WebView -> Extension. Fit the plan under review to
 * the target's storage, as a person asked (`AutopilotFitMode`): answered by
 * an `autopilot:plan-ready` of the fitted plan, its report in
 * `plan.scope.fitted`, the plan it was fitted from kept to go back to.
 * Nothing is written; the gate is met again by the fitted plan at Run.
 *
 * What the run is set to do counts in what fits, as the review stands: what
 * its mute keeps quiet creates no record to keep room for, and the checkpoint
 * it takes first spends some of the day's API requests.
 */
export interface AutopilotFitPlanRequest extends BaseMessage {
  type: 'autopilot:fit-plan';
  payload: {
    mode: AutopilotFitMode;
    muteAutomation?: boolean;
    checkpointFirst?: RunCheckpointRequest;
  };
}

/**
 * `autopilot:fit-undo`. WebView -> Extension. Back to the plan a fit started
 * from: answered by an `autopilot:plan-ready` of that plan.
 */
export interface AutopilotFitUndoRequest extends BaseMessage {
  type: 'autopilot:fit-undo';
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
    /**
     * Take a checkpoint of the objects the run writes before its first write
     * (`RunCheckpointRequest`: how many days it is kept, and what it leaves
     * out), to rewind the run to: refused on a target the registry does not
     * call a development org, and a take refused or failed refuses the run,
     * nothing written. Absent, no checkpoint is taken.
     */
    checkpointFirst?: RunCheckpointRequest;
  };
}

/**
 * What the host says of a node as it runs: `processing` for every node of the
 * plan once it starts, then the status each settles on, as a node reaches it
 * and once more when the run ends. `skipped` is Skip Node's, `stopped` a stop's.
 */
export type AutopilotNodeRunStatus = 'processing' | 'completed' | 'failed' | 'skipped' | 'stopped';

/** Progress update for a node during execution */
export interface AutopilotNodeProgress extends BaseMessage {
  type: 'autopilot:node-progress';
  payload: {
    nodeId: string;
    objectName: string;
    status: AutopilotNodeRunStatus;
    /** The node's wave, 0-based. */
    wave: number;
    /** Records written. */
    recordCount?: number;
    /** Records refused. */
    failureCount?: number;
    /** Records the target already held, linked to instead of written. */
    linkedCount?: number;
    /** Why records were refused, by status code and fields. */
    refusals?: AutopilotRefusal[];
    /** Records born a draft given back their status after their children. */
    statusesApplied?: number;
    /** Why a status could not be given back. */
    statusRefusals?: AutopilotRefusal[];
    /** Records given, once what they point at was in, the lookups they went in without. */
    lookupsFilled?: number;
    /** Why a lookup stayed empty, by status code and the lookups it left. */
    lookupRefusals?: AutopilotRefusal[];
    /** Records read and never sent: the platform writes them, or what they hang from, itself. */
    leftToThePlatform?: number;
    /** Records a stopped run never sent, or those of an object skipped. */
    notSent?: number;
    /** Records written in another currency than they were read in, and their amounts. */
    currenciesReplaced?: CurrencyReplaced[];
    /** Prices read in a currency the target lacks, and how each went. */
    pricesSettled?: PriceCurrencySettled[];
    /** The record type the target gave the records created without one, read back once written. */
    recordTypeGiven?: RecordTypeGiven;
    /** Records read that came to name one the fit cut, held back with it. */
    cutSinceFit?: number;
    /** What the node failed on: the target's first refusal, or why its write threw. */
    error?: string;
    /** API calls this node cost, so the page can total them as the run goes. */
    apiCallsUsed?: number;
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

/**
 * What the run left empty in the records it wrote to one object: the lookups a
 * second pass could not fill, its update refused, or the record they name
 * never written.
 */
export interface AutopilotLookupsNotFilled {
  objectApiName: string;
  /** Records that keep a lookup empty, each counted once. */
  records: number;
  /** Why, by status code and the lookups it left. */
  refusals: AutopilotRefusal[];
}

/** Autopilot execution completed, or stopped */
export interface AutopilotCompleted extends BaseMessage {
  type: 'autopilot:completed';
  payload: {
    /** How the run ended, as the audit trail and the command line say it. */
    status: AutopilotRunStatus;
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
    /**
     * The checkpoint of what the run writes, when it was asked to take one
     * before its first write (`checkpointFirst`): taken, or deleted as the
     * run wrote nothing. An Autopilot run has no removal: it is the way
     * back. Absent when it was not asked.
     */
    checkpoint?: RunCheckpointInfo;
    /**
     * Of a plan fitted to the target's storage, the records read that had
     * come to name a record the fit cut, since it chose them: held back with
     * that record. Absent when there were none.
     */
    cutSinceFit?: number;
    /**
     * Per object, in plan order, the records written that keep a lookup empty
     * for good: the node of each says the same. Absent when there are none.
     */
    lookupsNotFilled?: AutopilotLookupsNotFilled[];
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
