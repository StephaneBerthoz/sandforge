import { lazy } from 'react';

/*
 * The Reports tab that draws with a library, a chunk of its own, fetched the
 * first time its tab opens: the graph of Lineage (React Flow). The page opens
 * on Executions, which does not need it, and parsed it before it painted,
 * with the charts of an Analytics tab since removed: 1.2 MB of script, half
 * of it these two libraries.
 */

/** The Lineage tab's graph. */
export const LineageGraph = lazy(() =>
  import('./LineageGraph').then((module) => ({ default: module.LineageGraph })),
);
