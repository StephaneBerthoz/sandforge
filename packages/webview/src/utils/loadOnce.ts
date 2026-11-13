import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** What React.lazy reads of a loader's answer: a `then` it hands its two callbacks. */
export interface Thenable<T> {
  then(onFulfilled: (value: T) => unknown, onRejected: (reason: unknown) => unknown): unknown;
}

/**
 * `load`, run once for a part's `lazy` and for its preload alike, and answered
 * at once when its module is in.
 *
 * A preload that ran the loader itself left `lazy` to run it again the first
 * time the part was drawn: a promise of its own, which settles a microtask
 * later however long ago the chunk came. React drew the part's fallback for
 * that microtask, and showed the part no sooner than it reveals any content a
 * fallback stood for: Forge's execution step left an empty box in place of
 * the Review just left, and the panel, that much shorter, went back to its
 * top; the ribbon of the two orgs came some 100 milliseconds after Review,
 * and moved it 79 pixels down under the user's eyes. Once the module is in,
 * the loader answers with a thenable that calls back before it returns, which
 * `lazy` draws on the spot. A load that failed is run again the next time the
 * part is asked for.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Thenable<T> {
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

/**
 * React.lazy as React takes it: from a loader that answers a promise "or
 * another thenable", which its types narrow to a promise. For a loader made
 * by {@link loadOnce}.
 */
export const lazyOnce = lazy as <P extends object>(
  load: () => Thenable<{ default: ComponentType<P> }>,
) => LazyExoticComponent<ComponentType<P>>;
