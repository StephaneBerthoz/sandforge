import { useEffect, useRef } from 'react';

/** The classic Konami Code sequence. */
const KONAMI_SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA',
];

/**
 * Hook that detects the Konami Code key sequence.
 * Calls the callback when the full sequence is entered.
 */
export function useKonamiCode(callback: () => void): void {
  const indexRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.code === KONAMI_SEQUENCE[indexRef.current]) {
        indexRef.current += 1;
        if (indexRef.current === KONAMI_SEQUENCE.length) {
          callbackRef.current();
          indexRef.current = 0;
        }
      } else {
        indexRef.current = e.code === KONAMI_SEQUENCE[0] ? 1 : 0;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
