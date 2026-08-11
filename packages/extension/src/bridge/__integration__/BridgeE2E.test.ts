import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { MessageBroker } from '../MessageBroker';
import { MessageRouter } from '../MessageRouter';

/**
 * Creates a mock WebviewPanel that captures messages and allows
 * simulating incoming messages from the WebView.
 */
function createMockPanel() {
  const sentMessages: BaseMessage[] = [];
  const receiveListeners: Array<(msg: BaseMessage) => void> = [];

  const panel = {
    webview: {
      postMessage: vi.fn().mockImplementation((msg: BaseMessage) => {
        sentMessages.push(msg);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: vi.fn().mockImplementation((listener: (msg: BaseMessage) => void) => {
        receiveListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    },
  };

  return {
    panel: panel as unknown as Parameters<MessageBroker['registerPanel']>[0],
    sentMessages,
    /**
     * Simulate a message sent from WebView to Extension. The webview always
     * envelops (protocolVersion + payload) — the broker drops raw,
     * non-enveloped messages since the Plan 01-04 hardening.
     */
    simulateWebViewMessage: (msg: BaseMessage) => {
      const envelope = { protocolVersion: PROTOCOL_VERSION, payload: msg };
      for (const listener of receiveListeners) {
        listener(envelope as unknown as BaseMessage);
      }
    },
  };
}

function createMessage(type: string, payload?: Record<string, unknown>): BaseMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: Date.now(),
    ...(payload ? { payload } : {}),
  } as BaseMessage;
}

describe('Bridge E2E Integration', () => {
  let broker: MessageBroker;
  let router: MessageRouter;
  let mockPanel: ReturnType<typeof createMockPanel>;

  beforeEach(() => {
    broker = new MessageBroker();
    router = new MessageRouter(broker);
    mockPanel = createMockPanel();
    broker.registerPanel(mockPanel.panel);
  });

  afterEach(() => {
    router.dispose();
    broker.dispose();
  });

  describe('org:connect flow', () => {
    it('should route org:connect message and respond', async () => {
      const handler = vi.fn().mockImplementation(async (msg: BaseMessage) => {
        broker.postToWebview(
          createMessage('org:connect:response', {
            orgId: (msg as BaseMessage & { payload: { orgId: string } }).payload.orgId,
            success: true,
          }),
        );
      });

      router.route('org:connect', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('org:connect', {
          orgId: 'org-1',
          authMethod: 'oauth',
          alias: 'TestOrg',
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(1);
      expect(mockPanel.sentMessages[0].type).toBe('org:connect:response');
    });
  });

  describe('org:disconnect flow', () => {
    it('should route org:disconnect message and respond', async () => {
      const handler = vi.fn().mockImplementation((msg: BaseMessage) => {
        broker.postToWebview(
          createMessage('org:statusChanged', {
            orgId: (msg as BaseMessage & { payload: { orgId: string } }).payload.orgId,
            status: 'disconnected',
          }),
        );
      });

      router.route('org:disconnect', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('org:disconnect', {
          orgId: 'org-1',
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(1);
      expect(mockPanel.sentMessages[0].type).toBe('org:statusChanged');
    });
  });

  describe('seed:execute flow', () => {
    it('should route seed:execute and emit lifecycle events', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'seed-op-1',
            module: 'seed',
            description: 'Seeding Account data',
          }),
        );

        broker.postToWebview(
          createMessage('operation:progress', {
            operationId: 'seed-op-1',
            percentage: 50,
            processedRecords: 500,
            totalRecords: 1000,
            currentStep: 'Inserting records',
          }),
        );

        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'seed-op-1',
            result: { inserted: 1000, failed: 0 },
          }),
        );
      });

      router.route('seed:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('seed:execute', {
          templateId: 'tpl-1',
          orgId: 'org-1',
          dryRun: false,
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(3);
      expect(mockPanel.sentMessages[0].type).toBe('operation:started');
      expect(mockPanel.sentMessages[1].type).toBe('operation:progress');
      expect(mockPanel.sentMessages[2].type).toBe('operation:completed');
    });
  });

  describe('sync:start flow', () => {
    it('should route sync:execute and handle lifecycle', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'sync-op-1',
            module: 'sync',
            description: 'Syncing Account data',
          }),
        );
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'sync-op-1',
            result: { synced: 500 },
          }),
        );
      });

      router.route('sync:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('sync:execute', {
          configId: 'cfg-1',
          dryRun: false,
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(2);
    });
  });

  describe('monitor:refresh flow', () => {
    it('should route monitor:refresh and return data', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('monitor:refresh:response', {
            limits: { DailyApiRequests: { used: 100, max: 15000 } },
            healthScore: 85,
          }),
        );
      });

      router.route('monitor:refresh', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('monitor:refresh', {
          orgId: 'org-1',
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(1);
    });
  });

  describe('compare:execute flow', () => {
    it('should route compare:execute and return diff results', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'cmp-op-1',
            module: 'compare',
            description: 'Comparing metadata',
          }),
        );
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'cmp-op-1',
            result: { added: 5, modified: 10, removed: 2 },
          }),
        );
      });

      router.route('compare:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('compare:execute', {
          configId: 'cfg-cmp-1',
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(2);
    });
  });

  describe('backup:execute flow', () => {
    it('should route backup:execute and return results', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'bkp-op-1',
            module: 'dataops',
            description: 'Backing up Account data',
          }),
        );
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'bkp-op-1',
            result: { recordCount: 5000 },
          }),
        );
      });

      router.route('backup:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('backup:execute', {
          configId: 'cfg-bkp-1',
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('pipeline:run flow', () => {
    it('should route pipeline:run and emit step progress', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'pip-op-1',
            module: 'automation',
            description: 'Running pipeline',
          }),
        );
        broker.postToWebview(
          createMessage('operation:progress', {
            operationId: 'pip-op-1',
            percentage: 33,
            processedRecords: 1,
            totalRecords: 3,
            currentStep: 'Step 1: Backup',
          }),
        );
        broker.postToWebview(
          createMessage('operation:progress', {
            operationId: 'pip-op-1',
            percentage: 66,
            processedRecords: 2,
            totalRecords: 3,
            currentStep: 'Step 2: Seed',
          }),
        );
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'pip-op-1',
            result: { stepsCompleted: 3, stepsFailed: 0 },
          }),
        );
      });

      router.route('pipeline:run', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('pipeline:run', {
          pipelineId: 'pip-1',
        }),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages).toHaveLength(4);
    });
  });

  describe('error handling', () => {
    it('should handle timeout error gracefully', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:failed', {
            operationId: 'op-timeout',
            error: 'Operation timed out after 30s',
            retryable: true,
          }),
        );
      });

      router.route('seed:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('seed:execute', {
          templateId: 'tpl-1',
          orgId: 'org-1',
          dryRun: false,
        }),
      );

      await Promise.resolve();

      expect(mockPanel.sentMessages[0].type).toBe('operation:failed');
    });

    it('should handle auth expired error', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:failed', {
            operationId: 'op-auth',
            error: 'Authentication token expired',
            retryable: false,
          }),
        );
        broker.postToWebview(
          createMessage('org:statusChanged', {
            orgId: 'org-1',
            status: 'expired',
          }),
        );
      });

      router.route('sync:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('sync:execute', {
          configId: 'cfg-1',
          dryRun: false,
        }),
      );

      await Promise.resolve();

      expect(mockPanel.sentMessages).toHaveLength(2);
    });

    it('should handle rate limit error', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:failed', {
            operationId: 'op-rate',
            error: 'API rate limit exceeded. Retry after 60s',
            retryable: true,
          }),
        );
      });

      router.route('monitor:refresh', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('monitor:refresh', {
          orgId: 'org-1',
        }),
      );

      await Promise.resolve();

      expect(mockPanel.sentMessages[0].type).toBe('operation:failed');
    });

    it('should handle network error', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        broker.postToWebview(
          createMessage('operation:failed', {
            operationId: 'op-network',
            error: 'Network unreachable',
            retryable: true,
          }),
        );
        broker.postToWebview(
          createMessage('notification', {
            level: 'error',
            title: 'Connection Lost',
            message: 'Unable to reach Salesforce. Check your network connection.',
          }),
        );
      });

      router.route('backup:execute', handler);

      mockPanel.simulateWebViewMessage(
        createMessage('backup:execute', {
          configId: 'cfg-1',
        }),
      );

      await Promise.resolve();

      expect(mockPanel.sentMessages).toHaveLength(2);
      expect(mockPanel.sentMessages[1].type).toBe('notification');
    });
  });

  describe('multi-panel broadcast', () => {
    it('should broadcast messages to all registered panels', () => {
      const panel2 = createMockPanel();
      broker.registerPanel(panel2.panel);

      broker.postToWebview(
        createMessage('notification', {
          level: 'info',
          title: 'Test',
          message: 'Broadcast test',
        }),
      );

      expect(mockPanel.sentMessages).toHaveLength(1);
      expect(panel2.sentMessages).toHaveLength(1);
    });
  });

  describe('router prefix routing', () => {
    it('should route all messages with a prefix', () => {
      const handler = vi.fn();
      const allTypes = [
        'org:list',
        'org:connect',
        'org:disconnect',
        'seed:execute',
        'sync:execute',
      ];
      router.routePrefix('org:', allTypes, handler);

      mockPanel.simulateWebViewMessage(createMessage('org:list'));
      mockPanel.simulateWebViewMessage(createMessage('org:connect', { orgId: 'org-1' }));
      mockPanel.simulateWebViewMessage(createMessage('seed:execute', { templateId: 'tpl-1' }));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple operations simultaneously', async () => {
      const operations: string[] = [];

      const seedHandler = vi.fn().mockImplementation(async () => {
        operations.push('seed:start');
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'seed-1',
            module: 'seed',
            description: 'Seed op',
          }),
        );
        operations.push('seed:complete');
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'seed-1',
            result: {},
          }),
        );
      });

      const syncHandler = vi.fn().mockImplementation(async () => {
        operations.push('sync:start');
        broker.postToWebview(
          createMessage('operation:started', {
            operationId: 'sync-1',
            module: 'sync',
            description: 'Sync op',
          }),
        );
        operations.push('sync:complete');
        broker.postToWebview(
          createMessage('operation:completed', {
            operationId: 'sync-1',
            result: {},
          }),
        );
      });

      router.route('seed:execute', seedHandler);
      router.route('sync:execute', syncHandler);

      mockPanel.simulateWebViewMessage(
        createMessage('seed:execute', { templateId: 'tpl-1', orgId: 'org-1', dryRun: false }),
      );
      mockPanel.simulateWebViewMessage(
        createMessage('sync:execute', { configId: 'cfg-1', dryRun: false }),
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(seedHandler).toHaveBeenCalledTimes(1);
      expect(syncHandler).toHaveBeenCalledTimes(1);
      expect(mockPanel.sentMessages.length).toBeGreaterThanOrEqual(4);
    });
  });
});
