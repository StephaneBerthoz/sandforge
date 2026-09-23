import React, { useState } from 'react';
import type {
  GeneratedReport,
  ReportsAuditResponse,
  ReportsLineageResponse,
} from '@sandforge/shared';

import { ReportsPage } from './ReportsPage';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import type { AuditFilter } from './AuditTrailViewer';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useFileSave } from '../../hooks/useFileSave';

/** What `reports:list:response` carries. */
interface ReportsPayload {
  reports: GeneratedReport[];
  summary: AnalyticsSummary;
}

/** What `reports:audit:response` carries. */
type AuditPayload = ReportsAuditResponse['payload'];

/** What `reports:lineage:response` carries. */
type LineagePayload = ReportsLineageResponse['payload'];

/** Audit entries asked for at first, and added by each "show more". */
const AUDIT_PAGE_SIZE = 100;

/**
 * Gives {@link ReportsPage} its data sources.
 *
 * The page has always been presentational, and `PanelRouter` mounted it with
 * no props at all — so every tab said "not wired yet", correctly. The data it
 * needed was never missing: Forge and Sync have each been storing their runs
 * since they shipped, and `reports:list` reads them.
 *
 * The audit trail and the lineage are read the same way, from what every path
 * that writes to an org records when its run ends: `reports:audit` pages the
 * trail, filtered on the host by module and org, and `reports:lineage` answers
 * the latest run's graph, or the one picked from the runs it keeps.
 */
export const ReportsContainer: React.FC = () => {
  // The hook queries on mount by default; the histories only change when a run
  // finishes, so reopening the panel is what re-reads them.
  const { data, error } = useBridgeQuery<ReportsPayload>('reports:list', undefined, {
    responseType: 'reports:list:response',
  });
  const { save } = useFileSave();

  const [auditFilter, setAuditFilter] = useState<AuditFilter>({});
  const [auditLimit, setAuditLimit] = useState(AUDIT_PAGE_SIZE);
  // A new filter or limit is a new payload, which the hook sends again.
  const audit = useBridgeQuery<AuditPayload>('reports:audit', {
    ...auditFilter,
    limit: auditLimit,
  });

  const [lineageRun, setLineageRun] = useState<string | undefined>();
  const lineage = useBridgeQuery<LineagePayload>(
    'reports:lineage',
    lineageRun !== undefined ? { operationId: lineageRun } : undefined,
  );

  /** Export one report as JSON, saved by the host. */
  const handleExportReport = (id: string): void => {
    const report = data?.reports.find((r) => r.id === id);
    if (!report) return;
    save(`${report.id}.json`, JSON.stringify(report, null, 2), ['json']);
  };

  /** A narrower filter starts again from the newest entries. */
  const handleAuditFilterChange = (filter: AuditFilter): void => {
    setAuditFilter(filter);
    setAuditLimit(AUDIT_PAGE_SIZE);
  };

  const auditProps = {
    auditEntries: audit.data?.entries,
    auditTotal: audit.data?.total,
    auditFacets: audit.data?.facets,
    auditFilter,
    onAuditFilterChange: handleAuditFilterChange,
    onShowMoreAudit: () => setAuditLimit((limit) => limit + AUDIT_PAGE_SIZE),
    auditError: audit.error ?? undefined,
    // `undefined` until the host answers; `null` once it says nothing is traced.
    lineageData: lineage.data ? lineage.data.lineage : undefined,
    lineageRuns: lineage.data?.runs,
    onSelectLineageRun: setLineageRun,
    lineageError: lineage.error ?? undefined,
  };

  // A failed read is not an absent producer: leaving `reports` undefined here
  // would make the page say "not wired yet" about a feature that is wired and
  // simply did not answer.
  if (error) {
    return <ReportsPage reports={[]} analyticsSummary={data?.summary} {...auditProps} />;
  }

  return (
    <ReportsPage
      reports={data?.reports}
      analyticsSummary={data?.summary}
      onExportReport={handleExportReport}
      {...auditProps}
    />
  );
};
