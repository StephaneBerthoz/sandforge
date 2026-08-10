import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import type { ModuleRoute } from '../stores/useAppStore';

/** Timeout in ms for chord key sequences (e.g., G then H). */
const CHORD_TIMEOUT = 500;

/**
 * G+key navigation map — covers every navigable module route.
 * Mnemonics where the initial was already taken:
 *   y = sYnc (s → seed), p = autoPilot (a → automation),
 *   n = migratioN (m → monitor), z = froZen (f → forge),
 *   i = ai (intelligence), l = heLp (h → home).
 */
const CHORD_MAP: Record<string, ModuleRoute> = {
  h: 'home',
  m: 'monitor',
  f: 'forge',
  g: 'grappe',
  c: 'compare',
  d: 'dataops',
  a: 'automation',
  r: 'reports',
  e: 'settings',
  s: 'seed',
  y: 'sync',
  p: 'autopilot',
  n: 'migration',
  z: 'frozen',
  i: 'ai',
  o: 'orgs',
  l: 'help',
};

/** Ctrl+number direct navigation map. */
const CTRL_NUM_MAP: Record<string, ModuleRoute> = {
  '1': 'monitor',
  '2': 'seed',
  '3': 'sync',
  '4': 'compare',
  '5': 'dataops',
  '6': 'automation',
  '7': 'grappe',
  '8': 'autopilot',
  '9': 'migration',
  '0': 'forge',
};

/**
 * Registers global keyboard shortcuts for navigation and actions.
 * Supports chord sequences like G followed by H for "Go to Home",
 * Ctrl+1..9/0 for direct module navigation,
 * Ctrl+Enter for execute, and Escape for cancel.
 * Ignores keystrokes inside input/textarea elements.
 */
export function useGlobalShortcuts(): void {
  const pendingChord = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      /* ── Ctrl/Meta shortcuts (work even in inputs for Ctrl+Enter) ── */
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // Ctrl+1..9/0 — direct module navigation (skip in inputs)
      if (ctrlOrMeta && !e.shiftKey && !e.altKey && !isInput) {
        const route = CTRL_NUM_MAP[e.key];
        if (route) {
          e.preventDefault();
          useAppStore.getState().navigate(route);
          return;
        }
      }

      // Ctrl+Enter — dispatch sandforge:execute event
      if (ctrlOrMeta && e.key === 'Enter') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('sandforge:execute'));
        return;
      }

      // Escape — dispatch sandforge:cancel event (only if not already handled)
      if (e.key === 'Escape' && !e.defaultPrevented) {
        document.dispatchEvent(new CustomEvent('sandforge:cancel'));
        return;
      }

      // Skip chord navigation in inputs
      if (isInput) return;

      const key = e.key.toLowerCase();

      // Handle chord second key
      if (pendingChord.current === 'g' && !ctrlOrMeta && !e.altKey) {
        if (chordTimer.current) {
          clearTimeout(chordTimer.current);
          chordTimer.current = null;
        }
        pendingChord.current = null;

        const route = CHORD_MAP[key];
        if (route) {
          e.preventDefault();
          useAppStore.getState().navigate(route);
        }
        return;
      }

      // Start chord with 'g'
      if (key === 'g' && !ctrlOrMeta && !e.altKey && !e.shiftKey) {
        pendingChord.current = 'g';
        chordTimer.current = setTimeout(() => {
          pendingChord.current = null;
          chordTimer.current = null;
        }, CHORD_TIMEOUT);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (chordTimer.current) {
        clearTimeout(chordTimer.current);
      }
    };
  }, []);
}
