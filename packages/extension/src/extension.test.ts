import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const mockOutputChannel = {
  appendLine: vi.fn(),
  dispose: vi.fn(),
};

const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

const mockDisposable = { dispose: vi.fn() };

const mockSecrets = {
  get: vi.fn().mockResolvedValue(undefined),
  store: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
};

const mockWebviewPanel = {
  webview: {
    html: '',
    cspSource: 'https://test.csp.source',
    onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    postMessage: vi.fn(),
    asWebviewUri: vi.fn().mockImplementation((uri: { toString: () => string }) => ({
      toString: () => `vscode-webview://test/${String(uri)}`,
    })),
  },
  reveal: vi.fn(),
  dispose: vi.fn(),
  onDidDispose: vi.fn(),
};

const mockTreeView = {
  dispose: vi.fn(),
};

const mockEventEmitter = {
  event: vi.fn(),
  fire: vi.fn(),
  dispose: vi.fn(),
};

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

/** `vscode.l10n.t` as the host provides it: substitutes `{0}`, returns the source string. */
const substituteL10n = (message: string, ...args: unknown[]): string =>
  message.replace(/\{(\d+)\}/g, (_match: string, i: string) => String(args[Number(i)]));
const mockL10nT = vi.fn(substituteL10n);

/** The options every MessageBroker was built with, in construction order. */
const brokerOptions: Array<MessageBrokerOptions | undefined> = [];

vi.mock('./bridge/MessageBroker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/MessageBroker')>();
  class OptionsCapturingBroker extends actual.MessageBroker {
    constructor(options?: MessageBrokerOptions) {
      super(options);
      brokerOptions.push(options);
    }
  }
  return { ...actual, MessageBroker: OptionsCapturingBroker };
});

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    registerWebviewViewProvider: vi.fn(() => mockDisposable),
    createStatusBarItem: vi.fn(() => ({ ...mockStatusBarItem })),
    createWebviewPanel: vi.fn(() => ({
      ...mockWebviewPanel,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    })),
    createTreeView: vi.fn(() => ({ ...mockTreeView })),
    registerTreeDataProvider: vi.fn(() => mockDisposable),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
  },
  commands: {
    registerCommand: vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  },
  env: {
    isTelemetryEnabled: false,
    openExternal: vi.fn().mockResolvedValue(true),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: undefined,
  },
  Uri: {
    parse: vi.fn((value: string) => ({ toString: () => value })),
    joinPath: vi
      .fn()
      .mockImplementation((base: { toString: () => string }, ...segments: string[]) => ({
        toString: () => `${base.toString()}/${segments.join('/')}`,
      })),
  },
  l10n: {
    // Indirection on purpose: the factory runs while the module body is still
    // in its temporal dead zone, so the spy is read at call time, not here.
    t: (message: string, ...args: unknown[]) => mockL10nT(message, ...args),
  },
  EventEmitter: vi.fn(() => mockEventEmitter),
  ThemeIcon: vi.fn().mockImplementation((iconId: string) => ({ id: iconId })),
  ThemeColor: vi.fn().mockImplementation((colorId: string) => ({ id: colorId })),
  TreeItem: vi.fn().mockImplementation((label: string, collapsibleState: number) => ({
    label,
    collapsibleState,
  })),
}));

import { activate, deactivate, buildStatusBarLabel, localizedFixSuggestion } from './extension';
import { knownErrorTexts } from './core/common/errorKnowledgeBase';
import { OrgManager } from './core/connection/OrgManager';
import { WebviewStateSync } from './bridge/WebviewStateSync';
import { BackgroundOperationRegistry } from './core/engine/BackgroundOperationRegistry';
import { MODULE_COMMANDS } from './composition/moduleCommands';
import type { SidebarViewProvider } from './providers/SidebarViewProvider';
import type { StatusBarOrg } from './extension';
import type { MessageBrokerOptions } from './bridge/MessageBroker';

function createMockMemento(): import('vscode').Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T): T => {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue as T;
    },
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function createContext(): import('vscode').ExtensionContext {
  return {
    extensionUri: { fsPath: '/test', toString: () => 'file:///test' },
    globalStorageUri: { fsPath: '/test/global', toString: () => 'file:///test/global' },
    extension: { id: 'sandforge.sandforge', packageJSON: { version: '1.2.5' } },
    subscriptions: [] as unknown[],
    secrets: mockSecrets,
    globalState: createMockMemento(),
  } as unknown as import('vscode').ExtensionContext;
}

describe('extension', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    await deactivate();
  });

  it('should activate and create output channel', () => {
    const context = createContext();

    activate(context);

    expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('SandForge is now active.'),
    );
  });

  it('should register sidebar webview view provider', async () => {
    const context = createContext();

    activate(context);

    const vscode = await import('vscode');
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
      'sandforge.sidebarView',
      expect.objectContaining({}),
    );
  });

  it('should register module commands', async () => {
    const context = createContext();

    activate(context);

    const vscode = await import('vscode');
    // Every module route known to the sidebar has a registered command —
    // the list is derived from the single source of truth so it cannot drift.
    for (const { command } of MODULE_COMMANDS) {
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(command, expect.any(Function));
    }
  });

  it('should set up status bar with org count and monitor command', async () => {
    const context = createContext();

    activate(context);

    const vscode = await import('vscode');
    // createStatusBarItem is called by StatusBarProvider
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    // Verify the created item gets proper text/command
    const calls = vi.mocked(vscode.window.createStatusBarItem).mock.results;
    const statusBarItem = calls[0]?.value as typeof mockStatusBarItem;
    expect(statusBarItem.text).toBe('$(flame) SandForge: 0 orgs');
    expect(statusBarItem.command).toBe('sandforge.openMonitor');
  });

  it('should refresh the status bar when the sidebar selects an org', async () => {
    const context = createContext();
    activate(context);

    const vscode = await import('vscode');
    const provider = vi.mocked(vscode.window.registerWebviewViewProvider).mock
      .calls[0][1] as unknown as SidebarViewProvider;

    // Resolve the sidebar view and capture its message handler.
    let messageHandler: ((message: Record<string, unknown>) => void) | undefined;
    const mockView = {
      webview: {
        options: undefined,
        html: '',
        cspSource: 'https://test.csp.source',
        onDidReceiveMessage: vi.fn((handler: (message: Record<string, unknown>) => void) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: { toString: () => string }) => ({
          toString: () => String(uri),
        })),
      },
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    };
    provider.resolveWebviewView(mockView as never, undefined, undefined);

    const calls = vi.mocked(vscode.window.createStatusBarItem).mock.results;
    const statusBarItem = calls[0]?.value as typeof mockStatusBarItem;
    const showCallsBefore = statusBarItem.show.mock.calls.length;

    messageHandler?.({ type: 'sidebar:selectOrg', payload: { orgId: 'org-x' } });

    // The selection triggers a status bar refresh (setItem -> show again).
    expect(statusBarItem.show.mock.calls.length).toBe(showCallsBefore + 1);
  });

  it('sends the selected org with the org list it pushes to the sidebar when the orgs change', async () => {
    let orgListener: (() => void) | undefined;
    const onOrgChange = vi
      .spyOn(OrgManager.prototype, 'onOrgChange')
      .mockImplementation((listener) => {
        orgListener = listener as () => void;
        return () => undefined;
      });
    try {
      activate(createContext());

      const vscode = await import('vscode');
      const provider = vi.mocked(vscode.window.registerWebviewViewProvider).mock
        .calls[0][1] as unknown as SidebarViewProvider;
      let messageHandler: ((message: Record<string, unknown>) => void) | undefined;
      const postMessage = vi.fn();
      const mockView = {
        webview: {
          options: undefined,
          html: '',
          cspSource: 'https://test.csp.source',
          onDidReceiveMessage: vi.fn((handler: (message: Record<string, unknown>) => void) => {
            messageHandler = handler;
            return { dispose: vi.fn() };
          }),
          postMessage,
          asWebviewUri: vi.fn((uri: { toString: () => string }) => ({
            toString: () => String(uri),
          })),
        },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      };
      provider.resolveWebviewView(mockView as never, undefined, undefined);

      messageHandler?.({ type: 'sidebar:selectOrg', payload: { orgId: 'org-x' } });
      postMessage.mockClear();
      orgListener?.();

      expect(postMessage).toHaveBeenCalledWith({
        type: 'org:list:response',
        payload: expect.objectContaining({ selectedOrgId: 'org-x' }),
      });
    } finally {
      onOrgChange.mockRestore();
    }
  });

  it('should register the openOrgInBrowser command (and no native orgs tree)', async () => {
    const context = createContext();

    activate(context);

    const vscode = await import('vscode');
    // The native Organizations tree is gone — the launcher dropdown is the
    // only org surface; the browser-open command stays for it.
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'sandforge.openOrgInBrowser',
      expect.any(Function),
    );
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith(
      'sandforge.orgsView.refresh',
      expect.any(Function),
    );
    expect(vscode.window.registerTreeDataProvider).not.toHaveBeenCalled();
  });

  describe('sandforge.openOrgInBrowser', () => {
    // The command opens a URL read from stored org state, which is
    // hand-editable and filled by sfdx imports. It shares its HTTPS allowlist
    // with monitor:open-apex-jobs, but only the handler's refusal was tested:
    // bypassing the command's check left every test here green.
    const orgWith = (instanceUrl: string) =>
      ({ id: 'org-1', alias: 'Acme', instanceUrl }) as unknown as ReturnType<OrgManager['getOrg']>;
    let getOrg: MockInstance<OrgManager['getOrg']> | undefined;
    let getAllOrgs: MockInstance<OrgManager['getAllOrgs']> | undefined;

    afterEach(() => {
      getOrg?.mockRestore();
      getAllOrgs?.mockRestore();
      getOrg = undefined;
      getAllOrgs = undefined;
    });

    const registered = [
      {
        id: 'org-1',
        alias: 'Acme',
        username: 'admin@acme.test',
        instanceUrl: 'https://acme.my.salesforce.com',
      },
      {
        id: 'org-2',
        alias: 'Globex',
        username: 'admin@globex.test',
        instanceUrl: 'https://globex.my.salesforce.com',
      },
    ] as unknown as ReturnType<OrgManager['getAllOrgs']>;

    function stubRegisteredOrgs(orgs: ReturnType<OrgManager['getAllOrgs']>): void {
      getAllOrgs = vi.spyOn(OrgManager.prototype, 'getAllOrgs').mockReturnValue(orgs);
      getOrg = vi
        .spyOn(OrgManager.prototype, 'getOrg')
        .mockImplementation((id: string) => orgs.find((org) => org.id === id));
    }

    it('asks which org to open when it is run without an org id', async () => {
      stubRegisteredOrgs(registered);
      activate(createContext());
      const vscode = await import('vscode');
      vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
        (async (items: unknown) => (items as { label: string }[])[1]) as never,
      );

      await registeredCommands.get('sandforge.openOrgInBrowser')?.();

      const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as {
        label: string;
        description?: string;
      }[];
      expect(items.map((item) => item.label)).toEqual(['Acme', 'Globex']);
      expect(items[1].description).toBe('admin@globex.test');
      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://globex.my.salesforce.com/', true);
      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    });

    it('opens nothing when the org picker is dismissed', async () => {
      stubRegisteredOrgs(registered);
      activate(createContext());
      const vscode = await import('vscode');

      await registeredCommands.get('sandforge.openOrgInBrowser')?.();

      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('says there is no org to open instead of showing an empty picker', async () => {
      stubRegisteredOrgs([] as unknown as ReturnType<OrgManager['getAllOrgs']>);
      activate(createContext());
      const vscode = await import('vscode');

      await registeredCommands.get('sandforge.openOrgInBrowser')?.();

      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://acme.my.salesforce.com',
      'not a url',
    ])('refuses to open %s', async (instanceUrl) => {
      getOrg = vi.spyOn(OrgManager.prototype, 'getOrg').mockReturnValue(orgWith(instanceUrl));
      activate(createContext());
      const vscode = await import('vscode');

      registeredCommands.get('sandforge.openOrgInBrowser')?.('org-1');

      expect(vscode.env.openExternal).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it('opens the URL that passed the check, parsed strictly', async () => {
      getOrg = vi
        .spyOn(OrgManager.prototype, 'getOrg')
        .mockReturnValue(orgWith('https://acme.my.salesforce.com'));
      activate(createContext());
      const vscode = await import('vscode');

      registeredCommands.get('sandforge.openOrgInBrowser')?.('org-1');

      expect(vscode.Uri.parse).toHaveBeenCalledWith('https://acme.my.salesforce.com/', true);
      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    });
  });

  it('should push disposables to subscriptions', () => {
    const context = createContext();

    activate(context);

    // 16 module commands + 1 cheers + 1 sandforge.ai config-change listener
    // + outputChannel + sidebarRegistration + sidebarProvider
    // + openOrgInBrowser command + AI token budget reset command
    // + statusBar + panelManager + stateSync + backgroundRegistry + orgChange unsub
    // + orgManager + offlineManager + liveOperationTracker
    // + performanceTracker = 32
    expect(context.subscriptions.length).toBe(32);
  });

  it('writes telemetry log records to the output channel as readable lines, not raw JSON', async () => {
    activate(createContext());

    // The secret migration runs at activation and logs its summary through pino.
    await vi.waitFor(() =>
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
        expect.stringMatching(/^\[[\d-]+T[\d:.]+Z\] \[INFO\] secret migration complete \{/),
      ),
    );
    const lines = mockOutputChannel.appendLine.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith('{"level"'))).toBe(false);
  });

  it('lets a module panel load resources from the webview bundle only', async () => {
    activate(createContext());
    const vscode = await import('vscode');

    registeredCommands.get('sandforge.openMonitor')?.();

    const options = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0][3] as {
      localResourceRoots: readonly { toString(): string }[];
    };
    expect(options.localResourceRoots.map(String)).toEqual(['file:///test/webview-dist']);
  });

  it('disposes the state sync and the background registry with the extension', () => {
    const stateSyncDispose = vi.spyOn(WebviewStateSync.prototype, 'dispose');
    const registryDispose = vi.spyOn(BackgroundOperationRegistry.prototype, 'dispose');
    try {
      const context = createContext();
      activate(context);

      for (const sub of context.subscriptions as { dispose: () => unknown }[]) {
        sub.dispose();
      }

      expect(stateSyncDispose).toHaveBeenCalledTimes(1);
      expect(registryDispose).toHaveBeenCalledTimes(1);
    } finally {
      stateSyncDispose.mockRestore();
      registryDispose.mockRestore();
    }
  });

  it('should deactivate without error', async () => {
    const context = createContext();
    activate(context);

    await expect(deactivate()).resolves.toBeUndefined();
  });

  it('should handle double deactivation without error', async () => {
    await expect(deactivate()).resolves.toBeUndefined();
  });
});

describe('buildStatusBarLabel', () => {
  const connectedOrg: StatusBarOrg = {
    id: 'o1',
    alias: 'dev',
    username: 'admin@dev.com',
    status: 'connected',
  };
  const expiredOrg: StatusBarOrg = {
    id: 'o2',
    alias: 'prod',
    username: 'admin@prod.com',
    status: 'expired',
  };

  it('falls back to the bare org count when there are no orgs', () => {
    expect(buildStatusBarLabel([], undefined)).toEqual({
      text: '$(flame) SandForge: 0 orgs',
      tooltip: 'SandForge — Click to open Monitor',
    });
  });

  it('keeps the bare count when no org is selected and none is connected', () => {
    const label = buildStatusBarLabel([expiredOrg], undefined);
    expect(label.text).toBe('$(flame) SandForge: 1 org');
    expect(label.tooltip).toBe('SandForge — Click to open Monitor');
  });

  it('shows the selected org alias with the org count', () => {
    const label = buildStatusBarLabel([connectedOrg, expiredOrg], 'o2');
    expect(label.text).toBe('$(flame) SandForge: prod (2 orgs)');
    expect(label.tooltip).toBe('prod — admin@prod.com (expired)');
  });

  it('falls back to the first connected org when nothing is selected', () => {
    const label = buildStatusBarLabel([expiredOrg, connectedOrg], undefined);
    expect(label.text).toBe('$(flame) SandForge: dev (2 orgs)');
    expect(label.tooltip).toBe('dev — admin@dev.com (connected)');
  });

  it('falls back to the first connected org when the selection no longer exists', () => {
    const label = buildStatusBarLabel([connectedOrg], 'ghost');
    expect(label.text).toBe('$(flame) SandForge: dev (1 org)');
  });
});

describe('localizedFixSuggestion', () => {
  beforeEach(() => {
    mockL10nT.mockClear();
  });

  it('translates a curated answer through the entry its error code selects', () => {
    // The table is written in English and reached the notification rendered:
    // a French VS Code showed an English paragraph. The code is what picks the
    // sentence `vscode.l10n.t` is keyed on.
    const entry = knownErrorTexts('UNABLE_TO_LOCK_ROW');
    mockL10nT.mockImplementationOnce((message: string) => `[fr] ${message}`);

    const line = localizedFixSuggestion({
      source: 'knowledge-base',
      text: entry?.suggestion ?? '',
      code: 'UNABLE_TO_LOCK_ROW',
    });

    expect(mockL10nT).toHaveBeenCalledWith(entry?.suggestion);
    expect(line).toBe(`[fr] ${entry?.suggestion}`);
  });

  it('leaves a model answer alone — it is already written in the UI language', () => {
    const line = localizedFixSuggestion({ source: 'model', text: 'reduce the batch size' });

    expect(line).toBe('reduce the batch size');
    expect(mockL10nT).not.toHaveBeenCalled();
  });

  it('keeps the rendered line when the code is not one the table answers', () => {
    const line = localizedFixSuggestion({
      source: 'knowledge-base',
      text: 'something the table no longer holds',
      code: 'SOMETHING_WE_HAVE_NEVER_SEEN',
    });

    expect(line).toBe('something the table no longer holds');
    expect(mockL10nT).not.toHaveBeenCalled();
  });
});

describe('the fix suggestion notification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await deactivate();
    brokerOptions.length = 0;
  });

  afterEach(() => {
    mockL10nT.mockImplementation(substituteL10n);
  });

  /** Activates, then has `vscode.l10n.t` answer in "French" from here on. */
  async function activateInFrench() {
    activate(createContext());
    mockL10nT.mockImplementation(
      (message: string, ...args: unknown[]) => `[fr] ${substituteL10n(message, ...args)}`,
    );
    const vscode = await import('vscode');
    expect(brokerOptions.at(-1)?.showFixSuggestion).toBeTypeOf('function');
    return {
      notify: brokerOptions.at(-1)?.showFixSuggestion,
      shown: vi.mocked(vscode.window.showInformationMessage),
    };
  }

  it('shows a known error code the way the UI language writes it', async () => {
    const { notify, shown } = await activateInFrench();
    const suggestion = knownErrorTexts('UNABLE_TO_LOCK_ROW')?.suggestion;
    expect(suggestion).toBeDefined();

    notify?.({ source: 'knowledge-base', text: suggestion ?? '', code: 'UNABLE_TO_LOCK_ROW' });

    expect(shown).toHaveBeenCalledWith(
      `[fr] SandForge: suggested fix for a known Salesforce error — [fr] ${suggestion}`,
    );
  });

  it('shows a model answer as the model wrote it', async () => {
    const { notify, shown } = await activateInFrench();

    notify?.({ source: 'model', text: 'réduire la taille des lots' });

    expect(shown).toHaveBeenCalledWith(
      '[fr] SandForge: fix suggested by the AI model — réduire la taille des lots',
    );
  });
});
