import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { loadOrgRibbon } from '../../components/ui/lazyOrgRibbon';
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

/** What React.lazy reads of a loader's answer: a `then` it hands its two callbacks. */
interface Thenable<T> {
  then(onFulfilled: (value: T) => unknown, onRejected: (reason: unknown) => unknown): unknown;
}

/**
 * React.lazy as React takes it: from a loader that answers a promise "or
 * another thenable", which its types narrow to a promise.
 */
const lazyStep = lazy as <P extends object>(
  load: () => Thenable<{ default: ComponentType<P> }>,
) => LazyExoticComponent<ComponentType<P>>;

/**
 * `load`, run once for a step's `lazy` and for its preload alike, and answered
 * at once when its module is in.
 *
 * The preload ran the loader itself, and `lazy` ran it again the first time
 * the step was drawn: a promise of its own, which settles a microtask later
 * however long ago the chunk came. React drew the step's fallback for that
 * microtask, an empty box in place of the Review just left, and the panel,
 * that much shorter, went back to its top at the first Execute. Once the
 * module is in, the loader answers with a thenable that calls back before it
 * returns, which `lazy` draws on the spot. A load that failed is run again the
 * next time the step is asked for.
 */
function loadOnce<T>(load: () => Promise<T>): () => Thenable<T> {
  let loaded: { module: T } | undefined;
  let loading: Promise<T> | undefined;
  return () => {
    if (loaded) {
      const { module } = loaded;
      return { then: (onFulfilled) => onFulfilled(module) };
    }
    loading ??= load().then(
      (module) => {
        loaded = { module };
        return module;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };
}

/** Discovery: the graph read from the source, drawn as it grows. */
const loadDiscovery = loadOnce(() =>
  withEnglish(() => import('./ForgeDiscovery'), ['forgeRun'])().then((module) => ({
    default: module.ForgeDiscovery,
  })),
);

/** Review: the plan, the gaps, the automation and the controls before a run. */
const loadReview = loadOnce(() =>
  withEnglish(() => import('./ForgeReview'), ['checkpointNotes', 'forgeRun'])().then((module) => ({
    default: module.ForgeReview,
  })),
);

/** Execution: the run, written as it goes. */
const loadExecution = loadOnce(() =>
  withEnglish(() => import('./ForgeExecution'), ['forgeRun'])().then((module) => ({
    default: module.ForgeExecution,
  })),
);

/** Results: what the run wrote, and what it left. */
const loadResults = loadOnce(() =>
  withEnglish(() => import('./ForgeResults'), ['checkpointNotes', 'forgeRun', 'list'])().then(
    (module) => ({
      default: module.ForgeResults,
    }),
  ),
);

export const ForgeDiscovery = lazyStep(loadDiscovery);
export const ForgeReview = lazyStep(loadReview);
export const ForgeExecution = lazyStep(loadExecution);
export const ForgeResults = lazyStep(loadResults);

/**
 * The steps a run can reach from each one, fetched while it is shown.
 *
 * The execution step's chunk used to be asked for only once the run had
 * started, after the review had played its exit: one more round trip at the
 * start of every run, and on a remote window that dropped meanwhile a run
 * writing behind a screen that never loaded. Fetched while the review is read,
 * it is in the module map by the time Execute is pressed.
 */
const NEXT_STEPS: Readonly<Record<string, readonly (() => Thenable<unknown>)[]>> = {
  // The ribbon of the two orgs comes with Review: the steps before it draw none.
  discovery: [loadReview, loadOrgRibbon],
  review: [loadExecution, loadResults],
};

/**
 * Fetch the chunks of the steps a run can reach from `phase`, and their
 * English, without drawing them. A fetch that fails is left to the step's own
 * loader, which says so in its place when the run gets there.
 */
export function preloadStepsAfter(phase: string): void {
  for (const load of NEXT_STEPS[phase] ?? []) {
    load().then(
      () => undefined,
      () => undefined,
    );
  }
}
