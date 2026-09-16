import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

/**
 * Hold the most recent value in a ref whose identity never changes.
 *
 * Effects that must react to *one* trigger — a mutation answer landing, a
 * wizard step changing, a mount — still use props, callbacks and translations
 * to do their work. Listing those in the dependency array makes the effect
 * re-run whenever any of them is rebuilt; leaving them out takes a lint
 * suppression, which also hides the next dependency somebody forgets.
 *
 * Reading them through this ref keeps the trigger list honest — the dependency
 * array names the trigger and nothing else, with no suppression. It also serves
 * code that runs after later renders, such as a timer set by the effect or a
 * callback it hands to a store: `ref.current` read at that moment is the latest
 * value, not the one of the render that ran the effect.
 *
 * The write happens in a layout-free effect declared at the call site, so it
 * runs before any effect declared after it in the same component: an effect
 * placed below `useLatestRef` always reads the current commit's value, never
 * the previous one.
 *
 * @param value - The value to keep current.
 * @returns A stable ref whose `current` is the latest `value`.
 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
