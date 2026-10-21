import { lazy } from 'react';

/*
 * The Forge steps a run reaches after its input, each a chunk of its own
 * fetched the first time the run gets there: discovery, review, execution and
 * the results. The page opens on its input step and parsed every step before
 * it painted: 1.4 MB of script.
 *
 * What the extension answers as the page moves to a step — the discovery's
 * graph, the plan, the run's progress and its end — is taken by the store,
 * whatever the screen (directRun's discovery listener, useForgeStore's run
 * and plan listeners): nothing a step shows is lost while its chunk loads. A
 * step listens itself only for what it asks for once drawn.
 */

/** Discovery: the graph read from the source, drawn as it grows. */
export const ForgeDiscovery = lazy(() =>
  import('./ForgeDiscovery').then((module) => ({ default: module.ForgeDiscovery })),
);

/** Review: the plan, the gaps, the automation and the controls before a run. */
export const ForgeReview = lazy(() =>
  import('./ForgeReview').then((module) => ({ default: module.ForgeReview })),
);

/** Execution: the run, written as it goes. */
export const ForgeExecution = lazy(() =>
  import('./ForgeExecution').then((module) => ({ default: module.ForgeExecution })),
);

/** Results: what the run wrote, and what it left. */
export const ForgeResults = lazy(() =>
  import('./ForgeResults').then((module) => ({ default: module.ForgeResults })),
);
