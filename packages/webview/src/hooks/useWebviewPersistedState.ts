import { useState, useCallback } from 'react';
import { useVSCodeApi } from './useVSCodeApi';

/**
 * Persist and restore a piece of webview state across panel reloads.
 * Uses vscode.getState/setState with key-based merging to avoid
 * overwriting other persisted keys.
 *
 * @param key - Unique key for this piece of state (e.g., 'syncDraft', 'seedDraft')
 * @param initialValue - Default value when no persisted state exists
 * @returns [value, setValue] tuple similar to useState
 */
export function useWebviewPersistedState<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const api = useVSCodeApi();

  const [value, setValueInternal] = useState<T>(() => {
    const persisted = api.getState() as Record<string, unknown> | null | undefined;
    if (persisted && typeof persisted === 'object' && key in persisted) {
      return persisted[key] as T;
    }
    return initialValue;
  });

  const setValue = useCallback(
    (newValue: T) => {
      setValueInternal(newValue);
      const existing = (api.getState() as Record<string, unknown>) ?? {};
      api.setState({ ...existing, [key]: newValue });
    },
    [api, key],
  );

  return [value, setValue];
}
