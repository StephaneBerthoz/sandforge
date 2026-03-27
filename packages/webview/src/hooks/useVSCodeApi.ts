declare function acquireVsCodeApi(): VSCodeApi;

/** Typed interface for the VSCode webview API. */
export interface VSCodeApi {
  /** Send a message to the extension host. */
  postMessage: (message: unknown) => void;
  /** Retrieve the persisted webview state. */
  getState: () => unknown;
  /** Persist state across webview reloads. */
  setState: (state: unknown) => void;
}

/** No-op fallback for non-webview contexts (tests, dev server). */
const noopApi: VSCodeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

let cachedApi: VSCodeApi | undefined;

/**
 * Acquire and cache the VSCode webview API.
 * Returns a no-op fallback when running outside a VSCode webview
 * (e.g., in tests or the Vite dev server).
 */
function getApi(): VSCodeApi {
  if (cachedApi) {
    return cachedApi;
  }

  if (typeof acquireVsCodeApi === 'function') {
    cachedApi = acquireVsCodeApi();
  } else {
    cachedApi = noopApi;
  }

  return cachedApi;
}

/**
 * Non-hook accessor for the VSCode webview API.
 * Use this in Zustand stores and other non-React contexts
 * where hooks cannot be called.
 */
export function getVscodeApi(): VSCodeApi {
  return getApi();
}

/**
 * Hook that provides typed access to the VSCode webview API.
 * The underlying API instance is acquired once and cached for the
 * lifetime of the webview.
 */
export function useVSCodeApi(): VSCodeApi {
  return getApi();
}
