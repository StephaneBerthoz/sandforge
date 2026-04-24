import type { Page } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from '../mocks/vscode-api';

/**
 * High-level test helper that wraps the VSCode API mock pattern.
 *
 * Provides auto-correlated request→response messaging and eliminates
 * the need for manual `correlationId` extraction or `waitForTimeout`.
 */
export class MockBridge {
  private page!: Page;

  /**
   * Initialize the mock bridge on a Playwright page.
   * Must be called before `page.goto()` so the init script runs first.
   */
  async setup(page: Page): Promise<void> {
    this.page = page;
    await injectVSCodeApiMock(page);
  }

  /**
   * Wait for a message of the given type to appear in captured outgoing messages.
   * Uses `page.waitForFunction` instead of `waitForTimeout` for reliability.
   *
   * @returns The full message object including its `id` for correlation.
   */
  async waitForMessage(
    type: string,
    options?: { timeout?: number },
  ): Promise<Record<string, unknown>> {
    const timeout = options?.timeout ?? 5000;

    const message = await this.page.waitForFunction(
      ({ msgType }) => {
        const msgs =
          (
            window as unknown as Record<string, unknown[]>
          ).__SANDFORGE_MESSAGES__ ?? [];
        return msgs.find(
          (m) => (m as Record<string, unknown>).type === msgType,
        ) as Record<string, unknown> | undefined;
      },
      { msgType: type },
      { timeout },
    );

    return message.jsonValue() as Promise<Record<string, unknown>>;
  }

  /**
   * Send a response message from the "extension" to the webview.
   *
   * If `correlationId` is not provided, it is auto-extracted from the last
   * captured message whose type matches the conventional request type
   * (e.g., for `org:list:response` it looks for `org:list`).
   */
  async respond(
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    let cid = correlationId;

    if (!cid) {
      // Derive the request type from the response type (strip `:response` suffix)
      const requestType = type.replace(/:response$/, '');
      cid = await this.page.evaluate((reqType) => {
        const msgs =
          (
            window as unknown as Record<string, unknown[]>
          ).__SANDFORGE_MESSAGES__ ?? [];
        const match = [...msgs]
          .reverse()
          .find(
            (m) => (m as Record<string, unknown>).type === reqType,
          ) as Record<string, unknown> | undefined;
        return (match?.id as string) ?? 'unknown';
      }, requestType);
    }

    await sendExtensionMessage(this.page, {
      type,
      id: `resp-${Date.now()}`,
      correlationId: cid,
      payload,
    });
  }

  /**
   * Convenience: wait for an outgoing request of `requestType`, then
   * immediately send a response of `responseType` with the given payload.
   *
   * Replaces the common `resolveOrgListLoading` pattern.
   */
  async respondToNext(
    requestType: string,
    responseType: string,
    payload: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<void> {
    const request = await this.waitForMessage(requestType, options);
    const correlationId = (request.id as string) ?? 'unknown';

    await sendExtensionMessage(this.page, {
      type: responseType,
      id: `resp-${Date.now()}`,
      correlationId,
      payload,
    });
  }

  /**
   * Get all captured outgoing messages, optionally filtered by type.
   */
  async getMessages(
    type?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.page.evaluate((msgType) => {
      const msgs =
        (
          window as unknown as Record<string, unknown[]>
        ).__SANDFORGE_MESSAGES__ ?? [];
      if (!msgType) return msgs as Record<string, unknown>[];
      return msgs.filter(
        (m) => (m as Record<string, unknown>).type === msgType,
      ) as Record<string, unknown>[];
    }, type ?? null);
  }

  /**
   * Post a sequence of messages from the extension to the webview with an
   * optional delay between them. Useful for simulating CDC event streams or
   * multi-step extension responses.
   *
   * Each entry is dispatched as a `MessageEvent` with `data: { type, id, payload }`
   * and `origin: ''`, matching the pattern used by `sendExtensionMessage`.
   *
   * @param messages Ordered list of `{ type, payload }` entries.
   * @param options.delayMs Optional delay (milliseconds) inserted between messages.
   */
  async stream(
    messages: Array<{ type: string; payload: Record<string, unknown> }>,
    options?: { delayMs?: number },
  ): Promise<void> {
    const delayMs = options?.delayMs ?? 0;
    for (let i = 0; i < messages.length; i++) {
      const entry = messages[i];
      const id = `resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.page.evaluate(
        ({ type, payload, messageId }) => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type, id: messageId, payload },
              origin: '',
            }),
          );
        },
        { type: entry.type, payload: entry.payload, messageId: id },
      );
      if (delayMs > 0 && i < messages.length - 1) {
        await this.page.waitForTimeout(delayMs);
      }
    }
  }
}
