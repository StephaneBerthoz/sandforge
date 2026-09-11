import type {
  BaseMessage,
  ForgeExecutionResult,
  GeneratedReport,
  SyncHistoryEntry,
} from '@sandforge/shared';

import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';

/** Message types handled by ReportsHandler. */
const REPORTS_TYPES = new Set(['reports:list']);

/** Where Forge and Sync already keep their runs. */
const FORGE_HISTORY_KEY = 'forge:history';
const SYNC_HISTORY_KEY = 'sync:history:all';

/** Reports returned when the request does not ask for a different number. */
const DEFAULT_LIMIT = 50;

/** One report per run, newest first. */
export interface ReportsResult {
  reports: GeneratedReport[];
  summary: {
    totalOperations: number;
    successRate: number;
    avgDuration: number;
    errorRate: number;
  };
}

/** Records a Forge run wrote, counted from the graph it executed. */
function forgeRecordCount(run: ForgeExecutionResult): number {
  const nodes = run.graph?.nodes ?? [];
  return nodes.reduce((total, node) => total + (node.recordCount ?? 0), 0);
}

/**
 * Builds execution reports out of history two modules already keep.
 *
 * Reports shipped as four tabs with no producer: it printed 0 / 0 / 0.0 % / 0,
 * which reads as a measurement rather than as an absent feature. Nothing was
 * missing but the reading — Forge has stored its runs under `forge:history`
 * and Sync under `sync:history:all` since they shipped, each with a status, a
 * duration and a record count.
 *
 * So this adds no persistence, calls no org, and invents no number. It reads
 * two arrays and reshapes them. Audit trail and data lineage have no such
 * store, and stay marked unbuilt rather than being filled with something
 * plausible.
 */
export class ReportsHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  constructor(
    private readonly deps: Pick<HandlerDeps, 'nextId' | 'broker' | 'log' | 'configStore'>,
  ) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!REPORTS_TYPES.has(msg.type)) return false;
    this.handleList(msg);
    return true;
  }

  private handleList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const limit = this.readLimit(msg);
    const result = this.build(limit);
    this.deps.log(
      `[ReportsHandler] ${result.reports.length} report(s) from stored history ` +
        `(${result.summary.successRate}% success)`,
    );
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, 'reports:list:response', { ...result }),
    );
  }

  /** `limit` from the payload, bounded; anything unusable falls back. */
  private readLimit(msg: BaseMessage): number {
    const raw = (msg as { payload?: { limit?: unknown } }).payload?.limit;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(raw), 500);
  }

  /**
   * Reports and the figures above them, newest first.
   *
   * @param limit - Most reports to return.
   * @returns The reports, and a summary computed from those same reports —
   *   not tracked separately, so the total can never disagree with the list
   *   printed under it.
   */
  build(limit: number = DEFAULT_LIMIT): ReportsResult {
    const forge = this.deps.configStore.get<ForgeExecutionResult[]>(FORGE_HISTORY_KEY) ?? [];
    const sync = this.deps.configStore.get<SyncHistoryEntry[]>(SYNC_HISTORY_KEY) ?? [];

    const reports: GeneratedReport[] = [
      ...forge.map((run) => this.forgeReport(run)),
      ...sync.map((entry) => this.syncReport(entry)),
    ]
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, limit);

    return { reports, summary: summarise(reports) };
  }

  private forgeReport(run: ForgeExecutionResult): GeneratedReport {
    const objects = run.graph?.nodes?.length ?? 0;
    const records = forgeRecordCount(run);
    return {
      id: `forge-${run.forgeId}`,
      definitionId: `forge-${run.forgeId}`,
      type: 'seed_execution',
      title: `Forge clone — ${objects} object(s)`,
      summary:
        `${run.status} · ${records} record(s) across ${objects} object(s) · ` +
        `${run.idRemapCount} id(s) remapped`,
      sections: [
        {
          title: 'Outcome',
          type: 'summary',
          order: 0,
          content: {
            status: run.status,
            objects,
            records,
            idRemapCount: run.idRemapCount,
            durationMs: run.duration,
          },
        },
      ],
      metadata: {
        module: 'forge',
        operationId: run.forgeId,
        duration: run.duration,
        recordCount: records,
      },
      generatedAt: run.timestamp,
    };
  }

  private syncReport(entry: SyncHistoryEntry): GeneratedReport {
    const result = entry.result;
    const processed = result?.totalProcessed ?? 0;
    const failed = result?.totalFailed ?? 0;
    return {
      id: `sync-${entry.id}`,
      definitionId: `sync-${entry.id}`,
      type: 'sync_execution',
      title: `Sync — ${entry.configSnapshot?.name ?? 'unnamed configuration'}`,
      summary:
        `${result?.status ?? 'unknown'} · ${processed} processed, ` +
        `${result?.totalSuccess ?? 0} succeeded, ${failed} failed · ` +
        `triggered ${entry.triggeredBy}`,
      sections: [
        {
          title: 'Outcome',
          type: 'summary',
          order: 0,
          content: {
            status: result?.status ?? 'unknown',
            processed,
            succeeded: result?.totalSuccess ?? 0,
            failed,
            skipped: result?.totalSkipped ?? 0,
            triggeredBy: entry.triggeredBy,
          },
        },
      ],
      metadata: {
        module: 'sync',
        operationId: entry.id,
        duration: result?.duration,
        recordCount: processed,
      },
      generatedAt: entry.endTime ?? entry.startTime,
    };
  }
}

/** True when a report's own summary says the run did not fully succeed. */
function failed(report: GeneratedReport): boolean {
  const status = (report.sections[0]?.content as { status?: unknown } | undefined)?.status;
  return status === 'failure' || status === 'failed' || status === 'partial';
}

/**
 * The KPI row, computed from the reports it sits above.
 *
 * An empty history gives zeros — and the page only renders this row once a
 * producer exists, so those zeros now mean "no runs yet", which is a
 * measurement, rather than "no feature", which is what they used to mean.
 *
 * @param reports - The reports being displayed.
 * @returns Totals, and rates as percentages rounded to one decimal.
 */
export function summarise(reports: GeneratedReport[]): ReportsResult['summary'] {
  const total = reports.length;
  if (total === 0) {
    return { totalOperations: 0, successRate: 0, avgDuration: 0, errorRate: 0 };
  }
  const failures = reports.filter(failed).length;
  const durations = reports.map((r) => r.metadata.duration ?? 0);
  const round1 = (n: number): number => Math.round(n * 10) / 10;

  return {
    totalOperations: total,
    successRate: round1(((total - failures) / total) * 100),
    avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / total),
    errorRate: round1((failures / total) * 100),
  };
}
