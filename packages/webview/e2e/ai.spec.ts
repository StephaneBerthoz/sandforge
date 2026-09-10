import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * AI panel E2E.
 *
 * The panel is booted directly (`__SANDFORGE_MODULE__ = 'ai'`) because that is
 * how the extension opens it — there has been no in-app navigation sidebar
 * since 1.8.0.
 *
 * Two gates decide what this panel renders, and this file used to satisfy
 * neither:
 *
 * 1. `sandforge.ai.enabled` defaults to `false` (packages/extension/package.json).
 *    BridgeProvider asks the host with `ai:status` on mount and only flips
 *    `aiAvailable` when `ai:status:response` carries `enabled: true`. Until
 *    then AIPage renders `ai-not-configured`, so every wait on `ai-chat-panel`
 *    timed out against a perfectly healthy "configure your API key" screen.
 *    `openAIPanel` answers that request; the first describe below proves the
 *    gate is real by watching the panel refuse to mount without it.
 *
 * 2. BridgeProvider guards its mount burst with a ref, so StrictMode's second
 *    pass does not re-send: exactly one `org:list` and one `ai:status` per
 *    load, which is what `seedOrgs` / `respondToNext` correlate against.
 *
 * Everything the panel receives afterwards (`ai:conversation:created`,
 * `ai:chat:response`, `ai:error`, `ai:conversation:loaded`,
 * `ai:resolve-error:response`) arrives through `useMessageListener`, which
 * dispatches on `type` alone and never inspects `correlationId` — those are
 * posted with `sendExtensionMessage` rather than dressed up as replies to a
 * request that was never made.
 */

/** Boot the app into the AI panel with the assistant left switched off. */
async function openAIPanelDisabled(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'ai';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await bridge.respondToNext(
    'ai:status',
    'ai:status:response',
    { enabled: false },
    {
      timeout: 10_000,
    },
  );
  return bridge;
}

/** Boot the app into the AI panel with the assistant enabled and rendered. */
async function openAIPanel(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'ai';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await bridge.respondToNext(
    'ai:status',
    'ai:status:response',
    { enabled: true },
    {
      timeout: 10_000,
    },
  );
  await page.waitForSelector('[data-testid="ai-chat-panel"]', { timeout: 10_000 });
  return bridge;
}

/**
 * Every outgoing message of a type, unwrapped from the post envelope.
 *
 * Since 1.5.0 the webview posts `{ protocolVersion, payload: message }`, so the
 * real `type` sits one level down. `MockBridge.getMessages` matches the
 * top-level `type` and therefore answers `[]` for every application message —
 * which is why the delete/NL2SOQL assertions in the quarantined version could
 * never have passed even with the panel mounted.
 */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === msgType) as Record<string, unknown>[];
  }, type);
}

/** Payloads of every outgoing message of a type, newest last. */
async function outgoingPayloads(page: Page, type: string): Promise<Record<string, unknown>[]> {
  const messages = await outgoing(page, type);
  return messages.map((m) => (m.payload as Record<string, unknown> | undefined) ?? {});
}

/** Create a conversation and let the host confirm it with a real id. */
async function createConversation(page: Page, id: string, title: string): Promise<void> {
  await page.getByTestId('new-conversation-btn').click();
  await sendExtensionMessage(page, {
    type: 'ai:conversation:created',
    id: `evt-${id}`,
    payload: {
      conversation: { id, title, updatedAt: new Date().toISOString(), messageCount: 0 },
    },
  });
  await page.getByTestId(`conversation-item-${id}`).waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('AI Module — availability gate', () => {
  test('keeps the chat panel behind sandforge.ai.enabled', async ({ page }) => {
    await openAIPanelDisabled(page);

    await expect(page.getByTestId('ai-not-configured')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI Assistant Not Configured' })).toBeVisible();
    // The guidance is only useful if it points somewhere.
    await expect(page.getByRole('button', { name: 'Go to Settings' })).toBeVisible();
    await expect(page.getByTestId('ai-chat-panel')).toHaveCount(0);
  });

  test('mounts the chat panel once the host reports AI enabled', async ({ page }) => {
    await openAIPanel(page);

    await expect(page.getByTestId('ai-chat-panel')).toBeVisible();
    await expect(page.getByTestId('ai-not-configured')).toHaveCount(0);
  });
});

test.describe('AI Module — Chat', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openAIPanel(page);
  });

  test('asks the host for persisted conversations and shows the empty list', async ({ page }) => {
    // Mounting with AI available is what triggers the fetch; a panel that
    // renders "No conversations yet" without asking is showing a guess.
    await bridge.waitForMessage('ai:conversation:list', { timeout: 5000 });

    await expect(page.getByTestId('no-conversations')).toBeVisible();
    await expect(page.getByTestId('no-conversations')).toHaveText('No conversations yet');
  });

  test('invites the user to select or create a conversation', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Select or create a conversation' }),
    ).toBeVisible();
    // No conversation selected means no input surface at all.
    await expect(page.getByTestId('chat-input')).toHaveCount(0);
  });

  test('displays the new conversation button', async ({ page }) => {
    await expect(page.getByTestId('new-conversation-btn')).toBeVisible();
    await expect(page.getByTestId('new-conversation-btn')).toBeEnabled();
  });

  test('creates a conversation and replaces the optimistic entry', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();

    // The panel renders an optimistic `local-conv-*` row immediately and posts
    // the create request; both matter.
    await expect(page.locator('[data-testid^="conversation-item-local-conv-"]')).toHaveCount(1);
    const created = await outgoingPayloads(page, 'ai:conversation:create');
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('New Chat');

    await sendExtensionMessage(page, {
      type: 'ai:conversation:created',
      id: 'evt-conv-1',
      payload: {
        conversation: {
          id: 'conv-1',
          title: 'New Chat',
          updatedAt: new Date().toISOString(),
          messageCount: 0,
        },
      },
    });

    await expect(page.getByTestId('conversation-item-conv-1')).toBeVisible({ timeout: 5000 });
    // The optimistic row is replaced, not duplicated.
    await expect(page.locator('[data-testid^="conversation-item-local-conv-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="conversation-item-"]')).toHaveCount(1);
    await expect(page.getByTestId('no-messages')).toBeVisible();
  });

  test('posts the typed message on ai:chat and shows it pending', async ({ page }) => {
    await createConversation(page, 'conv-2', 'Test Chat');

    await page.getByTestId('chat-input').fill('SELECT Id FROM Account');
    await page.getByTestId('send-btn').click();

    const sent = await outgoingPayloads(page, 'ai:chat');
    expect(sent).toHaveLength(1);
    expect(sent[0].conversationId).toBe('conv-2');
    expect(sent[0].message).toBe('SELECT Id FROM Account');

    // The user turn is echoed locally, the panel waits, and the composer is
    // cleared and locked until the answer arrives.
    await expect(page.getByTestId('message-bubble-user')).toHaveText('SELECT Id FROM Account');
    await expect(page.getByTestId('loading-indicator')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('chat-input')).toHaveValue('');
    await expect(page.getByTestId('chat-input')).toBeDisabled();
  });

  test('renders the assistant answer verbatim and releases the composer', async ({ page }) => {
    await createConversation(page, 'conv-3', 'Test');

    await page.getByTestId('chat-input').fill('Show all accounts');
    await page.getByTestId('send-btn').click();
    await expect(page.getByTestId('loading-indicator')).toBeVisible({ timeout: 5000 });

    const answer =
      "Here's the SOQL:\n```sql\nSELECT Id, Name FROM Account\n```\nThis query returns all Account records with their IDs and Names.";
    await sendExtensionMessage(page, {
      type: 'ai:chat:response',
      id: 'evt-chat-3',
      payload: {
        conversationId: 'conv-3',
        message: {
          id: 'msg-resp-1',
          role: 'assistant',
          content: answer,
          timestamp: new Date().toISOString(),
        },
      },
    });

    const bubble = page.getByTestId('message-bubble-assistant');
    await expect(bubble).toBeVisible({ timeout: 5000 });
    // The bubble is `whitespace-pre-wrap` and renders the text as sent — line
    // breaks and fences included. `textContent` keeps them; `toHaveText`
    // normalises whitespace, so compare the raw node text.
    expect(await bubble.evaluate((el) => el.textContent)).toBe(answer);

    await expect(page.getByTestId('loading-indicator')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
  });

  test('gates the send button on non-empty input', async ({ page }) => {
    await createConversation(page, 'conv-5', 'Empty Test');

    await expect(page.getByTestId('send-btn')).toBeDisabled();

    await page.getByTestId('chat-input').fill('Hello');
    await expect(page.getByTestId('send-btn')).toBeEnabled();

    // Whitespace is not a message.
    await page.getByTestId('chat-input').fill('   ');
    await expect(page.getByTestId('send-btn')).toBeDisabled();
  });

  test('an ai:error clears the pending state without losing the panel', async ({ page }) => {
    await createConversation(page, 'conv-4', 'Error Test');

    await page.getByTestId('chat-input').fill('Bad query');
    await page.getByTestId('send-btn').click();
    await expect(page.getByTestId('loading-indicator')).toBeVisible({ timeout: 5000 });

    await sendExtensionMessage(page, {
      type: 'ai:error',
      id: 'evt-err-1',
      payload: { message: 'AI service unavailable' },
    });

    // The spinner has to stop and the composer has to come back, otherwise a
    // single failed turn locks the conversation for good.
    await expect(page.getByTestId('loading-indicator')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect(page.getByTestId('ai-chat-panel')).toBeVisible();
    await expect(page.getByTestId('message-bubble-user')).toHaveText('Bad query');
  });
});

test.describe('AI Module — Conversation management', () => {
  test.beforeEach(async ({ page }) => {
    await openAIPanel(page);
  });

  test('displays the conversation sidebar', async ({ page }) => {
    await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
    await expect(page.getByTestId('conversation-list')).toBeVisible();
    await expect(page.getByTestId('conversation-list')).toHaveAttribute(
      'aria-label',
      'Conversations',
    );
  });

  test('loads a conversation history when one is selected', async ({ page }) => {
    await createConversation(page, 'conv-a', 'First');
    await createConversation(page, 'conv-b', 'Second');

    // Re-selecting the first one asks the host for its history.
    await page.getByTestId('conversation-item-conv-a').click();
    const loads = await outgoingPayloads(page, 'ai:conversation:load');
    expect(loads.map((p) => p.conversationId)).toContain('conv-a');

    await sendExtensionMessage(page, {
      type: 'ai:conversation:loaded',
      id: 'evt-loaded-a',
      payload: {
        conversation: {
          id: 'conv-a',
          title: 'First',
          messages: [
            {
              id: 'hist-1',
              role: 'user',
              content: 'How many accounts?',
              timestamp: new Date().toISOString(),
            },
            {
              id: 'hist-2',
              role: 'assistant',
              content: 'SELECT COUNT() FROM Account',
              timestamp: new Date().toISOString(),
            },
          ],
        },
      },
    });

    await expect(page.getByTestId('message-hist-1')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('message-bubble-assistant')).toHaveText(
      'SELECT COUNT() FROM Account',
    );
    await expect(page.getByTestId('no-messages')).toHaveCount(0);
  });

  test('deletes a conversation', async ({ page }) => {
    await createConversation(page, 'conv-del-1', 'To Delete');

    await page.getByTestId('delete-conversation-conv-del-1').click();

    const deletes = await outgoingPayloads(page, 'ai:conversation:delete');
    expect(deletes.map((p) => p.conversationId)).toContain('conv-del-1');

    // The row goes, and with it the chat area — the deleted conversation was
    // the active one.
    await expect(page.getByTestId('conversation-item-conv-del-1')).toHaveCount(0);
    await expect(page.getByTestId('no-conversations')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Select or create a conversation' }),
    ).toBeVisible();
  });
});

/**
 * The AI error resolver.
 *
 * The quarantined version "tested" this by typing the words "I got this error"
 * into the chat box, which posts `ai:chat` like any other sentence — it never
 * touched the resolver. The real surface is in BridgeProvider: a failed
 * operation is forwarded to the assistant on `ai:resolve-error` whenever AI is
 * available, and the answer is surfaced as a toast.
 */
test.describe('AI Module — Error resolver', () => {
  test.beforeEach(async ({ page }) => {
    await openAIPanel(page);
  });

  test('forwards a failed operation to the assistant', async ({ page }) => {
    await sendExtensionMessage(page, {
      type: 'operation:failed',
      id: 'evt-op-failed',
      payload: {
        operationId: 'op-42',
        error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Amount must be positive',
        retryable: false,
      },
    });

    await expect
      .poll(async () => (await outgoing(page, 'ai:resolve-error')).length, { timeout: 5000 })
      .toBeGreaterThan(0);

    const asked = await outgoingPayloads(page, 'ai:resolve-error');
    expect(asked[0].errorMessage).toBe(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Amount must be positive',
    );
    expect(asked[0].context).toMatchObject({ operationId: 'op-42', retryable: false });
  });

  test('surfaces the suggested fix as a notification', async ({ page }) => {
    await sendExtensionMessage(page, {
      type: 'operation:failed',
      id: 'evt-op-failed-2',
      payload: { operationId: 'op-43', error: 'INSUFFICIENT_ACCESS', retryable: true },
    });
    await expect
      .poll(async () => (await outgoing(page, 'ai:resolve-error')).length, { timeout: 5000 })
      .toBeGreaterThan(0);

    await sendExtensionMessage(page, {
      type: 'ai:resolve-error:response',
      id: 'evt-resolve-1',
      payload: {
        success: true,
        resolution: {
          explanation: 'The running user lacks CRUD permission on the target object.',
          suggestedFix: 'Grant Edit on Account to the integration profile, then retry.',
          confidence: 0.82,
        },
      },
    });

    const toasts = page.getByTestId('floating-toasts');
    await expect(toasts).toContainText('AI Fix Suggestion', { timeout: 5000 });
    await expect(toasts).toContainText(
      'Grant Edit on Account to the integration profile, then retry.',
    );
  });
});
