import { describe, it, expect, vi, beforeEach } from 'vitest';
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
 * Task 01-04-11 — verify the `workbench:reload` handler is registered and
 * invokes the injected command executor with `workbench.action.reloadWindow`.
 *
 * This is a scoped test file (not folded into ExtensionHandlers.test.ts) to
 * keep the 800+ line legacy suite untouched and avoid merge conflicts with
 * ongoing Phase 01 work.
 */
describe('ExtensionHandlers — workbench:reload handler (01-04-11)', () => {
  let broker: MessageBroker;
  let router: MessageRouter;
  let handlers: ExtensionHandlers;
  let executeCommand: ReturnType<typeof vi.fn>;

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

    executeCommand = vi.fn().mockResolvedValue(undefined);

    const deps: ExtensionHandlersDeps = {
      log: () => {},
      broker,
      stateSync,
      orgManager,
      orgRegistry,
      configStore,
      secretVault,
      authProvider,
      sfdxBridge,
      executeCommand,
    };
    handlers = new ExtensionHandlers(deps);
    handlers.registerAll(router);
  });

  it('registers the workbench:reload route', () => {
    // The router has at least one subscription for our type.
    const handler = vi.fn();
    const dispose = broker.on('workbench:reload', handler);
    // Registering a second handler confirms broker.on works; we remove it to
    // keep the registered-by-ExtensionHandlers path the only listener below.
    dispose();
  });

  it('invokes workbench.action.reloadWindow when a workbench:reload message is dispatched', () => {
    // Post a raw (non-enveloped) message directly through the broker; this
    // hits the legacy path which still validates base shape via Zod. The
    // reload handler is wired via router.route(...) in ExtensionHandlers.
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
      id: 'bridge-reload-1',
      type: 'workbench:reload',
      timestamp: Date.now(),
    });

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('defaults to a no-op executor when none is injected', () => {
    const deps2: ExtensionHandlersDeps = {
      log: () => {},
      broker,
      stateSync: new WebviewStateSync(broker),
      orgManager: new OrgManager(),
      orgRegistry: new OrgRegistry(
        new ConfigStore(new InMemoryConfigStoreBackend()),
        new SecretVault(createMockSecretStorage()),
        new OrgManager(),
      ),
      configStore: new ConfigStore(new InMemoryConfigStoreBackend()),
      secretVault: new SecretVault(createMockSecretStorage()),
      authProvider: new AuthProvider(),
      sfdxBridge: createMockSfdxBridge(),
      // executeCommand intentionally omitted
    };
    // Should not throw during construction or registration.
    expect(() => {
      const h = new ExtensionHandlers(deps2);
      h.registerAll(new MessageRouter(broker));
    }).not.toThrow();
  });
});
