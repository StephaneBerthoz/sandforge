import type { BaseMessage } from './base.messages.js';
import type { GeneratedReport } from '../reporting.types.js';

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
 * Audit trail and data lineage stay unbuilt, and stay marked as such.
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
