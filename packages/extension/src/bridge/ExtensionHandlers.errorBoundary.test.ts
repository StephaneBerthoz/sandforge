import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { ExtensionHandlers } from './ExtensionHandlers';
import type { ExtensionHandlersDeps } from './ExtensionHandlers';
import { MessageBroker } from './MessageBroker';
import { MessageRouter } from './MessageRouter';
import { WebviewStateSync } from './WebviewStateSync';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { ConfigStore } from '../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../core/storage/ConfigStoreBackend';
import { SecretVault } from '../core/storage/SecretVault';
import type { SecretStorageAdapter } from '../core/storage/SecretVault';
import { AuthProvider } from '../core/connection/AuthProvider';
import type { SfdxBridge } from '../core/connection/SfdxBridge';

function createMockSecretStorage(): SecretStorageAdapter {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    store: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
}

function createMockSfdxBridge(): SfdxBridge {
  return {
    isCliAvailable: vi.fn().mockResolvedValue(true),
    listOrgs: vi.fn().mockResolvedValue([]),
    loginWeb: vi.fn().mockResolvedValue(undefined),
  } as unknown as SfdxBridge;
}

/**
 * The `error:boundary` route logs webview crash reports (React ErrorBoundary)
 * to the output channel. Scoped test file, same rationale as
 * ExtensionHandlers.workbenchReload.test.ts.
 */
describe('ExtensionHandlers — error:boundary route', () => {
  let broker: MessageBroker;
  let router: MessageRouter;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    broker = new MessageBroker();
    router = new MessageRouter(broker);
    const stateSync = new WebviewStateSync(broker);
    const orgManager = new OrgManager();
    const backend = new InMemoryConfigStoreBackend();
    const configStore = new ConfigStore(backend);
    configStore.initialize();
    const secretVault = new SecretVault(createMockSecretStorage());
    const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);
    const authProvider = new AuthProvider();
    const sfdxBridge = createMockSfdxBridge();

    log = vi.fn();
    const deps: ExtensionHandlersDeps = {
      log,
      broker,
      stateSync,
      orgManager,
      orgRegistry,
      configStore,
      secretVault,
      authProvider,
      sfdxBridge,
    };
    new ExtensionHandlers(deps).registerAll(router);
  });

  it('logs the crash report when an error:boundary message is dispatched', () => {
    const panel = {
      webview: {
        onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        postMessage: vi.fn(),
      },
    };
    broker.registerPanel(panel as never);
    const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
      msg: unknown,
    ) => void;

    messageCallback({
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        id: 'bridge-err-1',
        type: 'error:boundary',
        timestamp: Date.now(),
        payload: { message: 'Cannot read properties of undefined', stack: 'TypeError: …' },
      },
    });

    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('error:boundary');
    expect(line).toContain('Cannot read properties of undefined');
  });
});
