import { useState, useCallback, useRef } from 'react';
import { useVSCodeApi } from './useVSCodeApi';

/** A new value, or how to make it from the current one, as `useState` takes it. */
export type PersistedStateUpdate<T> = T | ((current: T) => T);

/**
 * Persist and restore a piece of webview state across panel reloads.
 * Uses vscode.getState/setState with key-based merging to avoid
 * overwriting other persisted keys.
 *
 * The setter takes a value or, as `useState`'s does, a function of the
 * current one: a "show more" adds a page to the count it finds, a toggle
 * flips what is open.
 *
 * @param key - Unique key for this piece of state (e.g., 'syncDraft', 'seedDraft')
 * @param initialValue - Default value when no persisted state exists
 * @returns [value, setValue] tuple similar to useState
 */
export function useWebviewPersistedState<T>(
  key: string,
  initialValue: T,
): [T, (update: PersistedStateUpdate<T>) => void] {
  const api = useVSCodeApi();

  const [value, setValueInternal] = useState<T>(() => {
    const persisted = api.getState() as Record<string, unknown> | null | undefined;
    if (persisted && typeof persisted === 'object' && key in persisted) {
      return persisted[key] as T;
    }
    return initialValue;
  });
  // The value the next update starts from: two updates in one handler each
  // see the one before, as useState's updaters do.
  const latest = useRef(value);

  const setValue = useCallback(
    (update: PersistedStateUpdate<T>) => {
      const next =
        typeof update === 'function' ? (update as (current: T) => T)(latest.current) : update;
      latest.current = next;
      setValueInternal(next);
      const existing = (api.getState() as Record<string, unknown>) ?? {};
      api.setState({ ...existing, [key]: next });
    },
    [api, key],
  );

  return [value, setValue];
}
