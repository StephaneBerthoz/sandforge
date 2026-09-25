import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { ExtensionHandlers } from './ExtensionHandlers';
import { MessageBroker } from './MessageBroker';
import { MessageRouter } from './MessageRouter';
import { WebviewStateSync } from './WebviewStateSync';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { ConfigStore } from '../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../test/InMemoryConfigStoreBackend';
import { SecretVault } from '../core/storage/SecretVault';
import type { SecretStorageAdapter } from '../core/storage/SecretVault';
import { AuthProvider } from '../core/connection/AuthProvider';
import type { SfdxBridge } from '../core/connection/SfdxBridge';
import { getJsforceConnection } from '../core/connection/ConnectionHelper';
import { ErrorResolver, type AIProvider } from '../modules/ai/ErrorResolver';
import type { AIModules } from './handlers/AIHandler';

vi.mock('../core/connection/ConnectionHelper', () => ({
  getJsforceConnection: vi.fn(),
  getConnectionPool: vi.fn(() => ({ remove: vi.fn() })),
}));

function createSecretStorage(): SecretStorageAdapter {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    store: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

/**
 * Turning AI off must stop the model being asked about a failed run.
 *
 * The webview never asked — the host resolves a failure where it raises it —
 * so the guard belongs here, on the path a real failure takes: a backup that
 * fails with a Salesforce code outside the table of known errors.
 */
describe('ExtensionHandlers — failed runs with AI turned off', () => {
  let handlers: ExtensionHandlers;
  let postMessage: ReturnType<typeof vi.fn>;
  let deliver: (raw: unknown) => void;
  let provider: ReturnType<typeof vi.fn<AIProvider>>;

  beforeEach(() => {
    const broker = new MessageBroker();
    const orgManager = new OrgManager();
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    const secretVault = new SecretVault(createSecretStorage());

    handlers = new ExtensionHandlers({
      log: () => undefined,
      broker,
      stateSync: new WebviewStateSync(broker),
      orgManager,
      orgRegistry: new OrgRegistry(configStore, secretVault, orgManager),
      configStore,
      secretVault,
      authProvider: new AuthProvider(),
      sfdxBridge: {} as SfdxBridge,
    });
    handlers.registerAll(new MessageRouter(broker));

    // One open panel: a failure with no view open asks nothing anyway, which
    // would make the assertion below pass for the wrong reason.
    postMessage = vi.fn();
    const onDidReceiveMessage = (listener: (raw: unknown) => void) => {
      deliver = listener;
      return { dispose: () => undefined };
    };
    broker.registerPanel({ webview: { onDidReceiveMessage, postMessage } } as unknown as
      vscode.WebviewPanel | vscode.WebviewView);

    provider = vi
      .fn<AIProvider>()
      .mockResolvedValue(
        JSON.stringify({ explanation: 'model answer', suggestions: [], confidence: 0.4 }),
      );
    vi.mocked(getJsforceConnection).mockRejectedValue(
      new Error('SOMETHING_ODD_HAPPENED: the org refused the export'),
    );
  });

  function aiModules(): AIModules {
    return {
      nl2soql: {},
      errorResolver: new ErrorResolver(provider),
      pipelineGenerator: {},
    } as unknown as AIModules;
  }

  async function failBackup(id: string): Promise<void> {
    deliver({
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        id,
        type: 'backup:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account'] },
      },
    });
    await vi.waitFor(() =>
      expect(
        postMessage.mock.calls.some((c) => (c[0] as BaseMessage).type === 'operation:failed'),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('asks the model about an unknown failure while AI is on', async () => {
    handlers.setAIModules(aiModules());

    await failBackup('req-on');

    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
  });

  it('asks the model nothing once the AI modules are taken away', async () => {
    handlers.setAIModules(aiModules());
    handlers.setAIModules(undefined);

    await failBackup('req-off');

    expect(provider).not.toHaveBeenCalled();
  });
});
