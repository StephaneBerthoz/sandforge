import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Options for {@link useFocusOnChange}. */
export interface FocusOnChangeOptions {
  /**
   * Where the focus may be taken from besides nowhere: the screen the change
   * redraws. A control outside it — another panel, a dialog — keeps the focus.
   */
  scope?: RefObject<HTMLElement | null>;
  /** Take the focus on the first render too: the screen was opened by a control that went with it. */
  onMount?: boolean;
}

/** A value no `key` is: the first render counts as a change. */
const NEVER_SHOWN = Symbol('never-shown');

/**
 * Hand `target` the keyboard when `key` changes, once the change has committed.
 *
 * A screen that swaps what it shows — a phase, a run's end — unmounts the
 * control that changed it, and the focus that control held falls to `<body>`:
 * the next Tab starts over at the top of the panel and a screen reader says
 * nothing of what is now shown. The focus is taken only when it is free:
 * nowhere, or inside `scope`. Give `target` a `tabIndex={-1}` and a name (a
 * heading, or a group named after what it shows).
 */
export function useFocusOnChange(
  target: RefObject<HTMLElement | null>,
  key: unknown,
  options: FocusOnChangeOptions = {},
): void {
  const { scope, onMount = false } = options;
  // StrictMode runs a mount's effect twice: the key settled by the first run
  // is not taken as a change by the second.
  const shown = useRef<unknown>(onMount ? NEVER_SHOWN : key);
  useEffect(() => {
    if (Object.is(shown.current, key)) return;
    shown.current = key;
    const focused = document.activeElement;
    const free =
      focused === null || focused === document.body || (scope?.current?.contains(focused) ?? false);
    if (free) target.current?.focus();
  }, [key, target, scope]);
}
