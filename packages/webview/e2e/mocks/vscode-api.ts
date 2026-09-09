import type { Page } from '@playwright/test';

/**
 * Inject a mock `acquireVsCodeApi` into the page before the app loads.
 *
 * This satisfies the VSCode webview API contract so the React app can boot
 * outside of a real VSCode host. Messages sent via `postMessage` are captured
 * in `window.__SANDFORGE_MESSAGES__` for assertion.
 */
export async function injectVSCodeApiMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface VSCodeApiShape {
      postMessage: (msg: unknown) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    }

    let savedState: unknown = undefined;
    const messages: unknown[] = [];

    // Expose captured messages for test assertions
    (window as unknown as Record<string, unknown>).__SANDFORGE_MESSAGES__ = messages;

    const api: VSCodeApiShape = {
      postMessage: (msg: unknown) => {
        messages.push(msg);
      },
      getState: () => savedState,
      setState: (state: unknown) => {
        savedState = state;
      },
    };

    // VSCode webviews provide this global function exactly once
    (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => api;
  });
}

/**
 * Simulate the extension sending a message to the webview via `window.postMessage`.
 *
 * The message is dispatched with an empty origin so the security guard in
 * `useMessageBus` lets it through (empty origin is allowed for tests).
 */
export async function sendExtensionMessage(
  page: Page,
  message: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((msg) => {
    // Dispatch a MessageEvent with an empty origin so the security check in
    // useMessageBus allows it (empty origin is accepted for tests/dev).
    window.dispatchEvent(new MessageEvent('message', { data: msg, origin: '' }));
  }, message);
}
