import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import type { ModuleRoute } from '../stores/useAppStore';

/** Timeout in ms for chord key sequences (e.g., G then H). */
const CHORD_TIMEOUT = 500;

/** G+key navigation map. */
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
};

/**
 * Registers global keyboard shortcuts for navigation and actions.
 * Supports chord sequences like G→H for "Go to Home".
 * Ignores keystrokes inside input/textarea elements.
 */
export function useGlobalShortcuts(): void {
  const pendingChord = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (isInput) return;

      const key = e.key.toLowerCase();

      // Handle chord second key
      if (pendingChord.current === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
      if (key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
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
