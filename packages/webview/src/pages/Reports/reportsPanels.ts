import { lazy } from 'react';

/*
 * The Reports tabs that draw with a library, each a chunk of its own, fetched
 * the first time its tab opens: the charts of Analytics (Recharts) and the
 * graph of Lineage (React Flow). The page opens on Executions, which needs
 * neither, and parsed both before it painted: 1.2 MB of script, half of it
 * these two libraries.
 */

/** The Analytics tab's charts. */
export const AnalyticsDashboard = lazy(() =>
  import('./AnalyticsDashboard').then((module) => ({ default: module.AnalyticsDashboard })),
);

/** The Lineage tab's graph. */
export const LineageGraph = lazy(() =>
  import('./LineageGraph').then((module) => ({ default: module.LineageGraph })),
);
