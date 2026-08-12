import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Set window.__SANDFORGE_MODULE__ = 'ai' so PanelApp renders the AI page
 * directly (AI is a standalone panel, not in the sidebar router).
 */
async function setupAIPanel(bridge: MockBridge, page: import('@playwright/test').Page): Promise<void> {
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'ai';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="ai-chat-panel"]', { timeout: 10000 });
}

test.describe('AI Module — Chat (NL2SOQL)', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAIPanel(bridge, page);
  });

  test('displays the AI chat panel', async ({ page }) => {
    await expect(page.getByTestId('ai-chat-panel')).toBeVisible();
  });

  test('shows empty state when no conversations exist', async ({ page }) => {
    await expect(page.getByTestId('no-conversations')).toBeVisible();
  });

  test('shows empty state when no conversation is selected', async ({ page }) => {
    // EmptyState component uses data-testid="empty-state" internally
    await expect(page.getByText('Select or create a conversation')).toBeVisible();
  });

  test('displays new conversation button', async ({ page }) => {
    await expect(page.getByTestId('new-conversation-btn')).toBeVisible();
  });

  test('creates a new conversation', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();

    // Mock the conversation:created response
    await bridge.respond('ai:conversation:created', {
      conversation: {
        id: 'conv-1',
        title: 'New Conversation',
        createdAt: Date.now(),
      },
    });

    await expect(page.getByTestId('conversation-item-conv-1')).toBeVisible({ timeout: 5000 });
  });

  test('sends a chat message and shows loading', async ({ page }) => {
    // Create a conversation first
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-2', title: 'Test Chat', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-2').waitFor({ state: 'visible', timeout: 5000 });

    // Type and send a message
    await page.getByTestId('chat-input').fill('SELECT Id FROM Account');
    await page.getByTestId('send-btn').click();

    // Loading indicator should appear
    await expect(page.getByTestId('loading-indicator')).toBeVisible({ timeout: 5000 });
  });

  test('displays assistant response after chat message', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-3', title: 'Test', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-3').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Show all accounts');
    await page.getByTestId('send-btn').click();

    // Mock assistant response
    await bridge.respond('ai:chat:response', {
      conversationId: 'conv-3',
      message: {
        id: 'msg-resp-1',
        role: 'assistant',
        content: 'SELECT Id, Name FROM Account',
        timestamp: Date.now(),
      },
    });

    await expect(page.getByTestId('message-bubble-assistant')).toBeVisible({ timeout: 5000 });
  });

  test('handles error response', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-4', title: 'Error Test', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-4').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Bad query');
    await page.getByTestId('send-btn').click();

    // Mock error response
    await bridge.respond('ai:error', {
      message: 'AI service unavailable',
    });

    // Error should not crash the UI — panel remains visible
    await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 5000 });
  });

  test('send button is disabled when input is empty', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-5', title: 'Empty Test', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-5').waitFor({ state: 'visible', timeout: 5000 });

    await expect(page.getByTestId('send-btn')).toBeDisabled();
  });
});

test.describe('AI Module — Conversation Management', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAIPanel(bridge, page);
  });

  test('deletes a conversation', async ({ page }) => {
    // Create conversation
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-del-1', title: 'To Delete', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-del-1').waitFor({ state: 'visible', timeout: 5000 });

    // Delete it
    await page.getByTestId('delete-conversation-conv-del-1').click();

    // Verify delete message was sent
    const messages = await bridge.getMessages('ai:conversation:delete');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('displays conversation list in sidebar', async ({ page }) => {
    await expect(page.getByTestId('conversation-sidebar')).toBeVisible();
    await expect(page.getByTestId('conversation-list')).toBeVisible();
  });
});

test.describe('AI Module — NL2SOQL', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAIPanel(bridge, page);
  });

  test('sends NL2SOQL request via chat', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-soql', title: 'SOQL', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-soql').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Find all contacts with email containing @acme.com');
    await page.getByTestId('send-btn').click();

    // Verify message was captured
    const messages = await bridge.getMessages('ai:chat');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('displays SOQL response with explanation', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-soql-2', title: 'SOQL2', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-soql-2').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Show accounts');
    await page.getByTestId('send-btn').click();

    await bridge.respond('ai:chat:response', {
      conversationId: 'conv-soql-2',
      message: {
        id: 'msg-soql-resp',
        role: 'assistant',
        content: "Here's the SOQL:\n```sql\nSELECT Id, Name FROM Account\n```\nThis query returns all Account records with their IDs and Names.",
        timestamp: Date.now(),
      },
    });

    await expect(page.getByTestId('message-bubble-assistant')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('AI Module — Error Resolver', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAIPanel(bridge, page);
  });

  test('sends error resolution request via chat', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-err', title: 'Error Help', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-err').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('I got this error: FIELD_CUSTOM_VALIDATION_EXCEPTION');
    await page.getByTestId('send-btn').click();

    const messages = await bridge.getMessages('ai:chat');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('displays resolution suggestions', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-err-2', title: 'Error Fix', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-err-2').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Fix: INSUFFICIENT_ACCESS');
    await page.getByTestId('send-btn').click();

    await bridge.respond('ai:chat:response', {
      conversationId: 'conv-err-2',
      message: {
        id: 'msg-err-resp',
        role: 'assistant',
        content: 'This error means the user lacks CRUD permission. Solutions:\n1. Check profile permissions\n2. Verify sharing rules\n3. Check field-level security',
        timestamp: Date.now(),
      },
    });

    await expect(page.getByTestId('message-bubble-assistant')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('AI Module — Suggestions & Anomaly', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAIPanel(bridge, page);
  });

  test('sends suggestions request via chat', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-sug', title: 'Suggestions', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-sug').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Suggest optimizations for my Account object');
    await page.getByTestId('send-btn').click();

    const messages = await bridge.getMessages('ai:chat');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('sends anomaly scan request via chat', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-anom', title: 'Anomaly', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-anom').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Scan for data anomalies in Contact records');
    await page.getByTestId('send-btn').click();

    const messages = await bridge.getMessages('ai:chat');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('displays anomaly scan results', async ({ page }) => {
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'conv-anom-2', title: 'Scan', createdAt: Date.now() },
    });

    await page.getByTestId('conversation-item-conv-anom-2').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('chat-input').fill('Check anomalies');
    await page.getByTestId('send-btn').click();

    await bridge.respond('ai:chat:response', {
      conversationId: 'conv-anom-2',
      message: {
        id: 'msg-anom-resp',
        role: 'assistant',
        content: 'Anomaly scan results:\n- 3 contacts with duplicate emails\n- 12 accounts with missing industry\n- 1 contact with future birthdate',
        timestamp: Date.now(),
      },
    });

    await expect(page.getByTestId('message-bubble-assistant')).toBeVisible({ timeout: 5000 });
  });
});
