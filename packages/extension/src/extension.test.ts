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

/**
 * Every process the extension starts and every call it sends a Salesforce org,
 * counted: what an activation costs is asserted below, not guessed. A process
 * fails at once, the way a CLI the host cannot run does; an org refuses the
 * token, the way an expired session does, which sends the extension to the CLI.
 */
const activationCost = { processes: [] as string[], identityCalls: [] as string[] };

vi.mock('child_process', () => {
  const start =
    (kind: string) =>
    (...args: unknown[]): { pid: undefined; kill: () => void } => {
      const argv = Array.isArray(args[1]) ? (args[1] as string[]) : [];
      activationCost.processes.push([kind, String(args[0]), ...argv].join(' '));
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        queueMicrotask(() => (callback as (err: Error) => void)(new Error('not run in tests')));
      }
      return { pid: undefined, kill: () => undefined };
    };
  return { exec: start('exec'), execFile: start('execFile'), spawn: start('spawn') };
});

vi.mock('./core/connection/jsforceEntry.js', () => ({
  jsforce: {
    Connection: class {
      constructor(private readonly options: { instanceUrl: string }) {}
      identity(): Promise<never> {
        activationCost.identityCalls.push(this.options.instanceUrl);
        return Promise.reject(
          Object.assign(new Error('INVALID_SESSION_ID: Session expired or invalid'), {
            errorCode: 'INVALID_SESSION_ID',
          }),
        );
      }
    },
  },
}));

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
      .mockImplementation(
        (base: { toString: () => string; fsPath?: string }, ...segments: string[]) => ({
          toString: () => `${base.toString()}/${segments.join('/')}`,
          fsPath: base.fsPath === undefined ? undefined : [base.fsPath, ...segments].join('/'),
        }),
      ),
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgManager } from './core/connection/OrgManager';
import { OrgRegistry } from './core/connection/OrgRegistry';
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

  it('should set up status bar with org count, opening Organizations while no org is registered', async () => {
    const context = createContext();

    activate(context);

    const vscode = await import('vscode');
    // createStatusBarItem is called by StatusBarProvider
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    // Verify the created item gets proper text/command
    const calls = vi.mocked(vscode.window.createStatusBarItem).mock.results;
    const statusBarItem = calls[0]?.value as typeof mockStatusBarItem;
    expect(statusBarItem.text).toBe('$(flame) SandForge: 0 orgs');
    expect(statusBarItem.command).toBe('sandforge.openOrgs');
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

    // 17 module commands (Home among them) + 1 cheers + 1 sandforge.ai config-change listener
    // + 1 sandforge.forge.graphView config-change listener
    // + outputChannel + sidebarRegistration + sidebarProvider
    // + openOrgInBrowser command + AI token budget reset command
    // + the two Frozen dataset salt commands (copy, use)
    // + statusBar + panelManager + stateSync + backgroundRegistry + orgChange unsub
    // + orgManager + offlineManager + liveOperationTracker
    // + performanceTracker + sandbox refresh detection + pipeline triggers
    // + the context the walkthrough's Connect step completes on = 39
    expect(context.subscriptions.length).toBe(39);
  });

  it('tells the editor at activation that no org is registered yet, which Get Started reads', async () => {
    activate(createContext());
    const vscode = await import('vscode');

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'sandforge.hasOrg',
      false,
    );
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

describe('what an activation costs before a SandForge view opens', () => {
  /** Lets every promise chain the activation started run to its end. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  let spies: MockInstance[] = [];
  /** Org ids unique across the file: the connection pool and circuit breakers outlive a test. */
  let orgSeq = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    await deactivate();
    activationCost.processes.length = 0;
    activationCost.identityCalls.length = 0;
    // Hermetic: the CLI's default org is read from this variable before any
    // file, so the machine's own configuration is never read.
    vi.stubEnv('SF_TARGET_ORG', 'nobody@example.invalid');
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    vi.unstubAllEnvs();
  });

  /** Registers `count` orgs, each with a token every org will refuse. */
  function registerOrgs(count: number): void {
    const orgs = Array.from({ length: count }, (_, index) => ({
      id: `org-${++orgSeq}`,
      alias: `org${index}`,
      username: `admin${index}@example.com`,
      instanceUrl: `https://org${index}.my.salesforce.com`,
      orgType: 'Sandbox',
      status: 'connected',
      metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    })) as unknown as ReturnType<OrgManager['getAllOrgs']>;
    spies.push(
      vi.spyOn(OrgManager.prototype, 'getAllOrgs').mockReturnValue(orgs),
      vi
        .spyOn(OrgManager.prototype, 'getOrg')
        .mockImplementation((id: string) => orgs.find((org) => org.id === id)),
      vi.spyOn(OrgRegistry.prototype, 'getCredentials').mockImplementation(async (id: string) => ({
        loginUrl: 'https://login.salesforce.com',
        accessToken: `token-${id}`,
        instanceUrl: orgs.find((org) => org.id === id)?.instanceUrl,
      })),
    );
  }

  async function openSidebar(): Promise<void> {
    const vscode = await import('vscode');
    const provider = vi.mocked(vscode.window.registerWebviewViewProvider).mock
      .calls[0][1] as unknown as SidebarViewProvider;
    provider.resolveWebviewView(
      {
        webview: {
          options: undefined,
          html: '',
          cspSource: 'https://test.csp.source',
          onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
          postMessage: vi.fn(),
          asWebviewUri: vi.fn((uri: { toString: () => string }) => ({
            toString: () => String(uri),
          })),
        },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      undefined,
      undefined,
    );
  }

  const logged = (): string[] => mockOutputChannel.appendLine.mock.calls.map((c) => String(c[0]));

  it('starts no process and calls no org when no org is registered', async () => {
    activate(createContext());
    await settle();

    expect(activationCost.processes).toEqual([]);
    expect(activationCost.identityCalls).toEqual([]);
  });

  it('starts no process and calls no org with three orgs registered, until a view opens', async () => {
    registerOrgs(3);
    activate(createContext());
    await settle();

    expect(activationCost.processes).toEqual([]);
    expect(activationCost.identityCalls).toEqual([]);
    expect(logged().some((line) => line.includes('Validating 3 registered org(s)'))).toBe(false);

    await openSidebar();
    await vi.waitFor(() => expect(activationCost.identityCalls).toHaveLength(3));
    await settle();

    // Each refused token is still taken to the CLI, as before; only when has
    // moved. Every process is one of those refreshes: the default org is read
    // from the CLI's files, not by running it.
    expect(activationCost.identityCalls).toEqual([
      'https://org0.my.salesforce.com',
      'https://org1.my.salesforce.com',
      'https://org2.my.salesforce.com',
    ]);
    const refreshed = new Set(
      activationCost.processes.map((line) => /admin(\d)@example\.com/.exec(line)?.[1]),
    );
    expect(refreshed).toEqual(new Set(['0', '1', '2']));
  });

  it('checks the orgs once per window, however many views open after the first', async () => {
    registerOrgs(2);
    activate(createContext());
    await openSidebar();
    await vi.waitFor(() => expect(activationCost.identityCalls).toHaveLength(2));

    registeredCommands.get('sandforge.openMonitor')?.();
    registeredCommands.get('sandforge.openSeed')?.();
    await openSidebar();
    await settle();

    expect(activationCost.identityCalls).toHaveLength(2);
  });

  it('wires Forge, Autopilot and the analysis modules with the first view, not at activation', async () => {
    activate(createContext());
    await settle();
    const wired = (): string[] =>
      logged().filter((line) =>
        /Forge v2 module initialized|Autopilot module initialized|Rule-based analysis modules initialized/.test(
          line,
        ),
      );
    expect(wired()).toEqual([]);

    registeredCommands.get('sandforge.openMonitor')?.();
    await vi.waitFor(() => expect(wired()).toHaveLength(3), { timeout: 10_000 });
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

  it('falls back to the bare org count, and opens Organizations, when there are no orgs', () => {
    expect(buildStatusBarLabel([], undefined)).toEqual({
      text: '$(flame) SandForge: 0 orgs',
      tooltip: 'SandForge — Click to connect an org in Organizations',
      command: 'sandforge.openOrgs',
    });
  });

  it('keeps the bare count when no org is selected and none is connected', () => {
    const label = buildStatusBarLabel([expiredOrg], undefined);
    expect(label.text).toBe('$(flame) SandForge: 1 org');
    expect(label.tooltip).toBe('SandForge — Click to open Home');
    expect(label.command).toBe('sandforge.openHome');
  });

  it('opens Home, not Monitor, once an org is registered', () => {
    expect(buildStatusBarLabel([connectedOrg], 'o1').command).toBe('sandforge.openHome');
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

/** A packaged locales folder holding the error catalogue's rowLocked action in English and French. */
function writeLocales(root: string): string {
  const dir = join(root, 'webview-dist', 'locales');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'en.json'),
    JSON.stringify({ errors: { rowLocked: { action: 'Run again in a moment.' } } }),
  );
  writeFileSync(
    join(dir, 'fr.json'),
    JSON.stringify({ errors: { rowLocked: { action: 'Relancez dans un instant.' } } }),
  );
  return dir;
}

describe('localizedFixSuggestion', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fix-suggestion-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('says what the catalogue says to do in the words the panel’s hint uses, in its language', async () => {
    // The host's own table was in English, other advice than the panel's
    // hint gave under the same failure.
    const dir = writeLocales(root);

    const line = await localizedFixSuggestion(
      { source: 'catalogue', code: 'UNABLE_TO_LOCK_ROW', actionKey: 'errors.rowLocked.action' },
      dir,
      'fr',
    );

    expect(line).toBe('Relancez dans un instant.');
  });

  it('leaves a model answer alone — it is already written in the UI language', async () => {
    const line = await localizedFixSuggestion(
      { source: 'model', text: 'reduce the batch size' },
      root,
      'fr',
    );

    expect(line).toBe('reduce the batch size');
  });

  it('says nothing when the catalogue’s text cannot be read', async () => {
    const line = await localizedFixSuggestion(
      { source: 'catalogue', code: 'UNABLE_TO_LOCK_ROW', actionKey: 'errors.rowLocked.action' },
      root,
      'fr',
    );

    expect(line).toBeUndefined();
  });
});

describe('the fix suggestion notification', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await deactivate();
    brokerOptions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'fix-notification-'));
    writeLocales(root);
  });

  afterEach(async () => {
    mockL10nT.mockImplementation(substituteL10n);
    const vscode = await import('vscode');
    (vscode.env as { language?: string }).language = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** Activates in a French editor whose extension folder holds the packaged locales. */
  async function activateInFrench() {
    const vscode = await import('vscode');
    (vscode.env as { language?: string }).language = 'fr';
    const context = createContext();
    (context as { extensionUri: unknown }).extensionUri = {
      fsPath: root,
      toString: () => `file://${root}`,
    };
    activate(context);
    mockL10nT.mockImplementation(
      (message: string, ...args: unknown[]) => `[fr] ${substituteL10n(message, ...args)}`,
    );
    expect(brokerOptions.at(-1)?.showFixSuggestion).toBeTypeOf('function');
    return {
      notify: brokerOptions.at(-1)?.showFixSuggestion,
      shown: vi.mocked(vscode.window.showInformationMessage),
    };
  }

  it('shows a code the catalogue explains in the panels’ language', async () => {
    const { notify, shown } = await activateInFrench();

    notify?.({
      source: 'catalogue',
      code: 'UNABLE_TO_LOCK_ROW',
      actionKey: 'errors.rowLocked.action',
    });

    await vi.waitFor(() =>
      expect(shown).toHaveBeenCalledWith(
        '[fr] SandForge: suggested fix for a known Salesforce error — Relancez dans un instant.',
      ),
    );
  });

  it('shows a model answer as the model wrote it', async () => {
    const { notify, shown } = await activateInFrench();

    notify?.({ source: 'model', text: 'réduire la taille des lots' });

    await vi.waitFor(() =>
      expect(shown).toHaveBeenCalledWith(
        '[fr] SandForge: fix suggested by the AI model — réduire la taille des lots',
      ),
    );
  });
});
