import { lazy } from 'react';

/*
 * Monitor's two Recharts charts, in a chunk fetched once the dashboard has
 * painted: the trend's area chart and the storage panel's donut, each drawn
 * inside a box of fixed height that holds its place meanwhile. The dashboard
 * parsed Recharts, 337 kB, before it painted its counts and its tables; the
 * trends of several limits are drawn by hand (TrendCharts) and need none of it.
 */

/** A trend's area chart. */
export const TrendArea = lazy(() =>
  import('./TrendArea').then((module) => ({ default: module.TrendArea })),
);

/** The storage panel's donut. */
export const StorageDonut = lazy(() =>
  import('./StorageDonut').then((module) => ({ default: module.StorageDonut })),
);
