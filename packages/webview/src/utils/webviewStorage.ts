import { getVscodeApi } from '../hooks/useVSCodeApi';

/**
 * localStorage-style string persistence backed by the VS Code webview state
 * (`getState`/`setState`) — the same mechanism `useWebviewPersistedState` and
 * the i18n language persistence rely on.
 *
 * VS Code does NOT guarantee that `localStorage`/`sessionStorage` survive
 * webview reloads; `getState`/`setState` is the supported persistence API.
 * Reads are synchronous (the host keeps the state in memory), so values are
 * available at boot. Writes merge with the existing state object so other
 * persisted keys (language, drafts, …) are preserved.
 *
 * All functions are best-effort and safe outside a webview (tests, Vite dev
 * server): reads return `null`, writes are silently dropped.
 */

/** Read a persisted string value. Returns `null` when absent or unreadable. */
export function getPersistedItem(key: string): string | null {
  try {
    const state = getVscodeApi().getState() as Record<string, unknown> | null | undefined;
    const value = state?.[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Persist a string value, merging with the existing webview state keys. */
export function setPersistedItem(key: string, value: string): void {
  try {
    const api = getVscodeApi();
    const existing = (api.getState() as Record<string, unknown> | null | undefined) ?? {};
    api.setState({ ...existing, [key]: value });
  } catch {
    // Non-webview context (tests, dev server) — nothing to persist to.
  }
}

/** Remove a persisted key while preserving the other webview state keys. */
export function removePersistedItem(key: string): void {
  try {
    const api = getVscodeApi();
    const existing = (api.getState() as Record<string, unknown> | null | undefined) ?? {};
    if (key in existing) {
      const next = { ...existing };
      delete next[key];
      api.setState(next);
    }
  } catch {
    // Non-webview context (tests, dev server) — nothing to persist to.
  }
}
