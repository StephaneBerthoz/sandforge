import { lazy } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';

/*
 * The Forge steps a run reaches after its input, each a chunk of its own
 * fetched the first time the run gets there: discovery, review, execution and
 * the results. The page opens on its input step and parsed every step before
 * it painted: 1.4 MB of script.
 *
 * So does their English: the words of the steps after the input live in
 * `forgeRun`, which a step loads with its chunk, and the page's own `forge`
 * holds the input's. Forge's 46 kB of English were parsed whole before the
 * input painted, the review's and the results' three quarters of it.
 * src/PanelRouter.english.test.ts reads each list against the keys the step
 * spells.
 *
 * What the extension answers as the page moves to a step — the discovery's
 * graph, the plan, the run's progress and its end — is taken by the store,
 * whatever the screen (directRun's discovery listener, useForgeStore's run
 * and plan listeners): nothing a step shows is lost while its chunk loads. A
 * step listens itself only for what it asks for once drawn.
 */

/** Discovery: the graph read from the source, drawn as it grows. */
const loadDiscovery = () =>
  withEnglish(() => import('./ForgeDiscovery'), ['forgeRun'])().then((module) => ({
    default: module.ForgeDiscovery,
  }));

/** Review: the plan, the gaps, the automation and the controls before a run. */
const loadReview = () =>
  withEnglish(() => import('./ForgeReview'), ['forgeRun'])().then((module) => ({
    default: module.ForgeReview,
  }));

/** Execution: the run, written as it goes. */
const loadExecution = () =>
  withEnglish(() => import('./ForgeExecution'), ['forgeRun'])().then((module) => ({
    default: module.ForgeExecution,
  }));

/** Results: what the run wrote, and what it left. */
const loadResults = () =>
  withEnglish(() => import('./ForgeResults'), ['forgeRun', 'list'])().then((module) => ({
    default: module.ForgeResults,
  }));

export const ForgeDiscovery = lazy(loadDiscovery);
export const ForgeReview = lazy(loadReview);
export const ForgeExecution = lazy(loadExecution);
export const ForgeResults = lazy(loadResults);

/**
 * The steps a run can reach from each one, fetched while it is shown.
 *
 * The execution step's chunk used to be asked for only once the run had
 * started, after the review had played its exit: one more round trip at the
 * start of every run, and on a remote window that dropped meanwhile a run
 * writing behind a screen that never loaded. Fetched while the review is read,
 * it is in the module map by the time Execute is pressed.
 */
const NEXT_STEPS: Readonly<Record<string, readonly (() => Promise<unknown>)[]>> = {
  discovery: [loadReview],
  review: [loadExecution, loadResults],
};

/**
 * Fetch the chunks of the steps a run can reach from `phase`, and their
 * English, without drawing them. A fetch that fails is left to the step's own
 * loader, which says so in its place when the run gets there.
 */
export function preloadStepsAfter(phase: string): void {
  for (const load of NEXT_STEPS[phase] ?? []) void load().catch(() => undefined);
}
