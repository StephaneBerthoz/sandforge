import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Controls Tab can land on; disabled controls are skipped by the browser too. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Dialogs currently holding a trap, in the order they opened. Two overlays can
 * be up at once (Welcome and What's New both render at startup), and Escape
 * must close only the one on top.
 */
const openTraps: HTMLElement[] = [];

/** Options for {@link useFocusTrap}. */
export interface FocusTrapOptions {
  /** Selector, inside the dialog, of the element to focus when it opens. */
  initialFocus?: string;
}

/**
 * Keeps keyboard focus inside a modal dialog while it is mounted.
 *
 * On open, focus moves into the dialog (unless a child already took it, e.g.
 * through `autoFocus`): to `initialFocus`, else the first focusable control,
 * else the dialog itself, which then needs `tabIndex={-1}`. Tab and Shift+Tab
 * wrap at the ends, Escape calls `onEscape`, and on close focus goes back to
 * the element that had it before. Keys pressed while focus sits in another
 * modal (the command palette, a native `<dialog>`) are left to that modal.
 *
 * Mount the hook in a component that renders only while the dialog is open:
 * the trap is set up when that component mounts.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  onEscape: () => void,
  options?: FocusTrapOptions,
): void {
  // Parents pass inline closures; reading the latest one through a ref keeps
  // the trap from tearing down and refocusing on every parent render.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  // Read on the first render, before the dialog commits: a child with
  // `autoFocus` takes focus during the commit, ahead of any effect, and an
  // effect would record that child as the opener.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  const initialFocus = options?.initialFocus;

  useEffect(() => {
    const container = ref.current;
    if (!container) return undefined;

    const opener = openerRef.current;
    openTraps.push(container);

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    if (!container.contains(document.activeElement)) {
      const target =
        (initialFocus ? container.querySelector<HTMLElement>(initialFocus) : null) ??
        focusables()[0] ??
        container;
      target.focus();
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (openTraps[openTraps.length - 1] !== container) return;
      const active = document.activeElement;
      if (active && !container.contains(active) && active.closest('dialog, [aria-modal="true"]')) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!active || !container.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = openTraps.lastIndexOf(container);
      if (index !== -1) openTraps.splice(index, 1);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref, initialFocus]);
}
