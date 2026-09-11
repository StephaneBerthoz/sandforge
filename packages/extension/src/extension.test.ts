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

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    registerWebviewViewProvider: vi.fn(() => mockDisposable),
    createStatusBarItem: vi.fn(() => ({ ...mockStatusBarItem })),
    createWebviewPanel: vi.fn(() => ({ ...mockWebviewPanel, onDidDispose: vi.fn() })),
    createTreeView: vi.fn(() => ({ ...mockTreeView })),
    registerTreeDataProvider: vi.fn(() => mockDisposable),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
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
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (_match: string, i: string) => String(args[Number(i)])),
  },
  EventEmitter: vi.fn(() => mockEventEmitter),
  ThemeIcon: vi.fn().mockImplementation((iconId: string) => ({ id: iconId })),
  ThemeColor: vi.fn().mockImplementation((colorId: string) => ({ id: colorId })),
  TreeItem: vi.fn().mockImplementation((label: string, collapsibleState: number) => ({
    label,
    collapsibleState,
  })),
}));

import { activate, deactivate, buildStatusBarLabel } from './extension';
import { OrgManager } from './core/connection/OrgManager';
import { MODULE_COMMANDS } from './composition/moduleCommands';
import type { SidebarViewProvider } from './providers/SidebarViewProvider';
import type { StatusBarOrg } from './extension';

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

    afterEach(() => {
      getOrg?.mockRestore();
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
    // + openOrgInBrowser command
    // + statusBar + panelManager + backgroundRegistry + orgChange unsub
    // + orgManager + offlineManager + liveOperationTracker + performanceTracker
    // + cacheManager = 31
    expect(context.subscriptions.length).toBe(31);
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
