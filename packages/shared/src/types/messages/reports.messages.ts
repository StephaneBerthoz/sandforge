import type { BaseMessage } from './base.messages.js';
import type {
  AuditFacets,
  AuditLogEntry,
  DataLineageGraph,
  GeneratedReport,
  LineageRunSummary,
} from '../reporting.types.js';

/**
 * Execution reporting.
 *
 * The Reports module shipped as four tabs with no producer anywhere in the
 * codebase: it rendered four KPI tiles reading 0 / 0 / 0.0 % / 0 — figures a
 * reader takes for measurements ("this org ran nothing and fails everything")
 * rather than for an absent feature. v1.19.0 made it say so instead.
 *
 * It says so no longer, because the data was already there. Forge keeps its
 * last runs in `forge:history` and Sync keeps its own in `sync:history:all`,
 * both with status, duration and record counts. Reporting on them needs no new
 * persistence, no Salesforce call and no new storage format — only a channel
 * that reads what two modules have been writing all along.
 *
 * The audit trail and the lineage have a producer of their own: every path
 * that writes to an org records its run once, when it ends — who wrote what
 * to which org, in counts, and where the records came from.
 */

/** Ask the host for the execution reports it can build from stored history. */
export interface ReportsListRequest extends BaseMessage {
  type: 'reports:list';
  payload?: { limit?: number };
}

/**
 * Reports built from history, and the figures the KPI row prints.
 *
 * `summary` is computed from the same `reports` array rather than tracked
 * separately: a total that can disagree with the list under it is the failure
 * this module is recovering from.
 */
export interface ReportsListResponse extends BaseMessage {
  type: 'reports:list:response';
  payload: {
    reports: GeneratedReport[];
    summary: {
      totalOperations: number;
      /** Percentage, 0-100. */
      successRate: number;
      /** Milliseconds. */
      avgDuration: number;
      /** Percentage, 0-100. */
      errorRate: number;
    };
  };
}

/** Ask for recorded write runs, newest first, optionally for one module or org. */
export interface ReportsAuditRequest extends BaseMessage {
  type: 'reports:audit';
  payload?: { module?: string; orgId?: string; offset?: number; limit?: number };
}

/** One page of the audit trail. */
export interface ReportsAuditResponse extends BaseMessage {
  type: 'reports:audit:response';
  payload: {
    entries: AuditLogEntry[];
    /** Entries the filter matches, before paging. */
    total: number;
    offset: number;
    /**
     * Every module and org the trail holds, whatever the filter: what a
     * filter can offer, which the page alone cannot say.
     */
    facets: AuditFacets;
  };
}

/** Ask for the lineage of one run, or of the latest when no id is given. */
export interface ReportsLineageRequest extends BaseMessage {
  type: 'reports:lineage';
  payload?: { operationId?: string };
}

/** The lineage asked for, and the runs a lineage is kept for. */
export interface ReportsLineageResponse extends BaseMessage {
  type: 'reports:lineage:response';
  payload: {
    /** `null` when no run has been traced yet, or the id asked for is not kept. */
    lineage: DataLineageGraph | null;
    /** Newest first. */
    runs: LineageRunSummary[];
  };
}

/** `reports:error`. Extension -> WebView: a malformed reports request. */
export interface ReportsErrorMessage extends BaseMessage {
  type: 'reports:error';
  payload: { message: string; code: string; retryable: boolean };
}
