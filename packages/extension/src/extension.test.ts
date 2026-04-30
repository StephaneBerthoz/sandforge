import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
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
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    })),
    workspaceFolders: undefined,
  },
  Uri: {
    joinPath: vi.fn().mockImplementation((base: { toString: () => string }, ...segments: string[]) => ({
      toString: () => `${base.toString()}/${segments.join('/')}`,
    })),
  },
  EventEmitter: vi.fn(() => mockEventEmitter),
  ThemeIcon: vi.fn().mockImplementation((iconId: string) => ({ id: iconId })),
  ThemeColor: vi.fn().mockImplementation((colorId: string) => ({ id: colorId })),
  TreeItem: vi.fn().mockImplementation((label: string, collapsibleState: number) => ({
    label,
    collapsibleState,
  })),
}));

import { activate, deactivate } from './extension';

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
    extension: { id: 'sandforge.sandforge' },
    subscriptions: [] as unknown[],
    secrets: mockSecrets,
    globalState: createMockMemento(),
  } as unknown as import('vscode').ExtensionContext;
}

describe('extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    deactivate();
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
    const expectedCommands = [
      'sandforge.openMonitor',
      'sandforge.openForge',
      'sandforge.openGrappe',
      'sandforge.openCompare',
      'sandforge.openDataOps',
      'sandforge.openAutomation',
      'sandforge.openOrgs',
      'sandforge.openSettings',
      'sandforge.openHelp',
    ];
    for (const cmd of expectedCommands) {
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(cmd, expect.any(Function));
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

  it('should push disposables to subscriptions', () => {
    const context = createContext();

    activate(context);

    // 9 module commands + 1 cheers + outputChannel + sidebarRegistration + statusBar + panelManager + backgroundRegistry = 15
    expect(context.subscriptions.length).toBe(15);
  });

  it('should deactivate without error', () => {
    const context = createContext();
    activate(context);

    expect(() => deactivate()).not.toThrow();
  });

  it('should handle double deactivation without error', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
