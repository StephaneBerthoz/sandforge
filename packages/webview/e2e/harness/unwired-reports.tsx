/**
 * The Reports components the panel does not feed yet, rendered with data.
 *
 * ReportsContainer passes the analytics summary and nothing else, so the
 * charts and the lineage graph never render in the shipped panel and no page
 * scan can reach them. This page mounts them the way ReportsPage would once
 * their data is wired, with the product stylesheet, for the contrast scans in
 * axe-accessibility.spec.ts.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import 'reactflow/dist/style.css';
import '../../src/index.css';
import { i18nReady } from '../../src/i18n';
import { AnalyticsDashboard } from '../../src/pages/Reports/AnalyticsDashboard';
import { LineageGraph } from '../../src/pages/Reports/LineageGraph';

const points = (metric: string, values: readonly number[]) =>
  values.map((value, day) => ({
    metric,
    value,
    timestamp: `2026-09-1${day}T00:00:00.000Z`,
    dimensions: {},
  }));

const root = document.getElementById('root');
if (root) {
  void i18nReady.then(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <main className="flex flex-col gap-4 p-4">
          <AnalyticsDashboard
            summary={{ totalOperations: 42, successRate: 95.2, avgDuration: 3400, errorRate: 4.8 }}
            operationsOverTime={{
              metric: 'operations',
              points: points('operations', [12, 18, 12]),
              aggregation: 'count',
              interval: 'day',
            }}
            errorTimeSeries={{
              metric: 'errors',
              points: points('errors', [1, 3, 2]),
              aggregation: 'count',
              interval: 'day',
            }}
          />
          <LineageGraph
            lineage={{
              operationId: 'op-lineage',
              generatedAt: '2026-09-12T00:00:00.000Z',
              nodes: [
                { id: 'n-source', type: 'source', label: 'Account (DevSandbox)' },
                { id: 'n-transform', type: 'transform', label: 'Anonymize email' },
                { id: 'n-filter', type: 'filter', label: 'Active only' },
                { id: 'n-destination', type: 'destination', label: 'Account (QASandbox)' },
              ],
              edges: [
                { sourceId: 'n-source', targetId: 'n-transform', recordCount: 1200 },
                { sourceId: 'n-transform', targetId: 'n-filter', recordCount: 1200 },
                { sourceId: 'n-filter', targetId: 'n-destination', label: 'upsert' },
              ],
            }}
          />
        </main>
      </React.StrictMode>,
    );
  });
}
