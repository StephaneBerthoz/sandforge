import type { Page } from '@playwright/test';
import {
  MODULE_HOW_TO,
  howToHiddenKey,
  type HowToModule,
} from '../../src/components/ui/moduleHowTo';

/** Options of the mocked webview API. */
export interface VSCodeApiMockOptions {
  /**
   * Leave each module's how-to open, as on a first visit. By default the page
   * starts as for someone who has hidden them all: open, a how-to pushes the
   * page below it down, and the scans and clicks written for that page land
   * below the fold. The how-to's own tests open it.
   */
  howToOpen?: boolean;
}

/**
 * Inject a mock `acquireVsCodeApi` into the page before the app loads.
 *
 * This satisfies the VSCode webview API contract so the React app can boot
 * outside of a real VSCode host. Messages sent via `postMessage` are captured
 * in `window.__SANDFORGE_MESSAGES__` for assertion.
 */
export async function injectVSCodeApiMock(
  page: Page,
  options: VSCodeApiMockOptions = {},
): Promise<void> {
  const initialState = options.howToOpen
    ? undefined
    : Object.fromEntries(
        (Object.keys(MODULE_HOW_TO) as HowToModule[]).map((module) => [
          howToHiddenKey(module),
          'true',
        ]),
      );
  await page.addInitScript((initial: Record<string, string> | undefined) => {
    interface VSCodeApiShape {
      postMessage: (msg: unknown) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    }

    let savedState: unknown = initial;
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
  }, initialState);
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
