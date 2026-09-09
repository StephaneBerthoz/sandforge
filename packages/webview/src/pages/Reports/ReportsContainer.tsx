import React from 'react';
import type { GeneratedReport } from '@sandforge/shared';

import { ReportsPage } from './ReportsPage';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useFileSave } from '../../hooks/useFileSave';

/** What `reports:list:response` carries. */
interface ReportsPayload {
  reports: GeneratedReport[];
  summary: AnalyticsSummary;
}

/**
 * Gives {@link ReportsPage} its data source.
 *
 * The page has always been presentational, and `PanelRouter` mounted it with
 * no props at all — so every tab said "not wired yet", correctly. The data it
 * needed was never missing: Forge and Sync have each been storing their runs
 * since they shipped, and `reports:list` reads them.
 *
 * Executions and analytics are fed from that. Audit trail and data lineage
 * have no store behind them and keep saying so: filling them with something
 * plausible is the failure this module is recovering from.
 */
export const ReportsContainer: React.FC = () => {
  // The hook queries on mount by default; the histories only change when a run
  // finishes, so reopening the panel is what re-reads them.
  const { data, error } = useBridgeQuery<ReportsPayload>('reports:list', undefined, {
    responseType: 'reports:list:response',
  });
  const { save } = useFileSave();

  /** Export one report as JSON, saved by the host. */
  const handleExportReport = (id: string): void => {
    const report = data?.reports.find((r) => r.id === id);
    if (!report) return;
    save(`${report.id}.json`, JSON.stringify(report, null, 2), ['json']);
  };

  // A failed read is not an absent producer: leaving `reports` undefined here
  // would make the page say "not wired yet" about a feature that is wired and
  // simply did not answer.
  if (error) {
    return <ReportsPage reports={[]} analyticsSummary={data?.summary} />;
  }

  return (
    <ReportsPage
      reports={data?.reports}
      analyticsSummary={data?.summary}
      onExportReport={handleExportReport}
    />
  );
};
