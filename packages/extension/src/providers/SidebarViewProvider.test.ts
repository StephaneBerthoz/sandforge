import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import {
  LAST_CHECKPOINT_CACHE_MS,
  SidebarViewProvider,
  type SidebarLastCheckpoint,
} from './SidebarViewProvider';
import { SIDEBAR_ROUTE_COMMANDS } from '../composition/moduleCommands';
import { MessageBroker } from '../bridge/MessageBroker';

describe('SidebarViewProvider', () => {
  // Partial mock: Uri used only as an opaque value (localResourceRoots + joinPath base)
  const extensionUri = { toString: () => '/ext' } as unknown as vscode.Uri;
  const uriJoinPath = (base: unknown, ...segments: string[]) =>
    // Partial mock: only toString() exercised by buildHtml
    ({ toString: () => `${String(base)}/${segments.join('/')}` }) as unknown as vscode.Uri;
  const executeCommand = vi.fn().mockResolvedValue(undefined);

  let provider: SidebarViewProvider;
  let mockWebview: Record<string, unknown>;
  let mockWebviewView: Record<string, unknown>;
  let messageHandler: ((msg: Record<string, unknown>) => void) | undefined;
  let disposeHandler: (() => void) | undefined;

  function createMockView(): Record<string, unknown> {
    const webview = {
      options: {},
      cspSource: 'https://test',
      asWebviewUri: (uri: unknown) => uri,
      html: '',
      onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn(),
    };
    return {
      webview,
      onDidDispose: vi.fn((handler: () => void) => {
        disposeHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = undefined;
    disposeHandler = undefined;

    mockWebviewView = createMockView();
    mockWebview = mockWebviewView.webview as Record<string, unknown>;

    provider = new SidebarViewProvider(extensionUri, uriJoinPath, executeCommand);
  });

  it('sets webview HTML with sidepanel module on resolve', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect(mockWebview.html).toContain('__SANDFORGE_MODULE__="sidepanel"');
    expect(mockWebview.html).toContain('sidepanel.js');
    expect(mockWebview.html).toContain('sidepanel.css');
    // One classic file: the sidebar loads no page on demand.
    expect(mockWebview.html).not.toContain('type="module"');
  });

  it('enables scripts and limits local resource roots to the webview bundle', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect((mockWebview.options as Record<string, unknown>).enableScripts).toBe(true);
    const roots = (mockWebview.options as { localResourceRoots: unknown[] }).localResourceRoots;
    expect(roots.map(String)).toEqual(['/ext/webview-dist']);
  });

  it('announces the VS Code display language to the sidebar shell', () => {
    const withLanguage = new SidebarViewProvider(
      extensionUri,
      uriJoinPath,
      executeCommand,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'ja',
    );
    withLanguage.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect(mockWebview.html).toContain('window.__SANDFORGE_EDITOR_LANGUAGE__="ja"');
  });

  it('executes correct command on sidebar:navigate message', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect(messageHandler).toBeDefined();

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'monitor' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openMonitor');

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'forge' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openForge');

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'grappe' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openGrappe');

    // Routes that used to fall back to Monitor now have their own commands.
    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'seed' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openSeed');

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'sync' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openSync');

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'autopilot' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openAutopilot');

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'migration' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openMigration');
  });

  it('executes the mapped command for every known sidebar route', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    for (const [route, command] of Object.entries(SIDEBAR_ROUTE_COMMANDS)) {
      executeCommand.mockClear();
      messageHandler!({ type: 'sidebar:navigate', payload: { route } });
      expect(executeCommand).toHaveBeenCalledWith(command);
    }
  });

  it('opens Home for a route it does not know', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'does-not-exist' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openHome');
    expect(executeCommand).not.toHaveBeenCalledWith('sandforge.openMonitor');
  });

  it('opens Home, not Monitor, for Open Full UI', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    messageHandler!({ type: 'sidebar:openFull' });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openHome');
    expect(executeCommand).not.toHaveBeenCalledWith('sandforge.openMonitor');
  });

  it("passes the launcher's first-card intent to the command, and refuses any other", () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({
      type: 'sidebar:navigate',
      payload: { route: 'orgs', intent: { orgAction: 'import-cli' } },
    });
    expect(executeCommand).toHaveBeenLastCalledWith('sandforge.openOrgs', {
      orgAction: 'import-cli',
    });

    messageHandler!({
      type: 'sidebar:navigate',
      payload: { route: 'orgs', intent: { orgAction: 'import-cli', extra: 1 } },
    });
    expect(executeCommand).toHaveBeenLastCalledWith('sandforge.openOrgs');
  });

  it('routes home to a command of its own', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'home' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openHome');
  });

  it('executes sandforge.openOrgInBrowser with the orgId on sidebar:openOrgInBrowser', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:openOrgInBrowser', payload: { orgId: 'org-42' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openOrgInBrowser', 'org-42');
  });

  it('ignores sidebar:openOrgInBrowser without an orgId', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:openOrgInBrowser', payload: {} });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('answers sidebar:requestSettings with the settings blob when a getter is wired', () => {
    const settingsGetter = vi.fn(() => ({ settings: { language: 'fr' } }));
    const settingsProvider = new SidebarViewProvider(
      extensionUri,
      uriJoinPath,
      executeCommand,
      undefined,
      undefined,
      undefined,
      settingsGetter,
    );
    settingsProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:requestSettings' });

    expect(settingsGetter).toHaveBeenCalledTimes(1);
    expect(mockWebview.postMessage).toHaveBeenCalledWith({
      type: 'settings:response',
      payload: { settings: { settings: { language: 'fr' } }, grappeEnabled: false },
    });
  });

  it('tells the launcher whether Grappe is on, with the settings', () => {
    const grappeProvider = new SidebarViewProvider(
      extensionUri,
      uriJoinPath,
      executeCommand,
      undefined,
      undefined,
      undefined,
      () => ({}),
      undefined,
      undefined,
      undefined,
      () => true,
    );
    grappeProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:requestSettings' });

    expect(mockWebview.postMessage).toHaveBeenCalledWith({
      type: 'settings:response',
      payload: { settings: {}, grappeEnabled: true },
    });
  });

  it('says how many orgs the CLI holds while no org is registered, and asks nothing once one is', async () => {
    const counter = vi.fn(() => Promise.resolve(4));
    const registered: Record<string, unknown>[] = [];
    const cliProvider = new SidebarViewProvider(
      extensionUri,
      uriJoinPath,
      executeCommand,
      () => registered,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      counter,
    );
    cliProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:requestOrgs' });
    await vi.waitFor(() =>
      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'sidebar:cliOrgs',
        payload: { count: 4 },
      }),
    );

    registered.push({ id: 'org-1' });
    messageHandler!({ type: 'sidebar:requestOrgs' });
    expect(counter).toHaveBeenCalledTimes(1);
  });

  it('ignores sidebar:requestSettings when no settings getter is wired', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    messageHandler!({ type: 'sidebar:requestSettings' });
    expect(mockWebview.postMessage).not.toHaveBeenCalled();
  });

  it('posts message to webview when visible', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    const settings = { type: 'settings:response', payload: { settings: {} } } as const;
    provider.postMessage(settings);
    expect(mockWebview.postMessage).toHaveBeenCalledWith(settings);
  });

  it('does nothing when posting before resolve', () => {
    // No resolveWebviewView called
    expect(() =>
      provider.postMessage({ type: 'settings:response', payload: { settings: {} } }),
    ).not.toThrow();
  });

  it('has correct static viewType', () => {
    expect(SidebarViewProvider.viewType).toBe('sandforge.sidebarView');
  });

  describe('broker registration (outbound-only)', () => {
    let broker: MessageBroker;
    let brokeredProvider: SidebarViewProvider;

    beforeEach(() => {
      broker = new MessageBroker();
      brokeredProvider = new SidebarViewProvider(
        extensionUri,
        uriJoinPath,
        executeCommand,
        undefined,
        undefined,
        broker,
      );
    });

    it('registers the view with the broker on resolve, without inbound subscription', () => {
      brokeredProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

      expect(broker.panelCount).toBe(1);
      // Only the provider's own raw subscription exists (navigation/org
      // messages) — the broker must not add a second, validating one.
      expect(mockWebview.onDidReceiveMessage).toHaveBeenCalledTimes(1);

      // Broadcasts reach the sidebar webview.
      const broadcast = { id: 'b-1', type: 'operation:started', timestamp: Date.now() };
      broker.postToWebview(broadcast as never);
      expect(mockWebview.postMessage).toHaveBeenCalledWith(broadcast);
    });

    it('releases the broker registration when the view is disposed', () => {
      brokeredProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
      expect(broker.panelCount).toBe(1);

      // VSCode destroys WebviewViews when they are hidden.
      disposeHandler!();

      expect(broker.panelCount).toBe(0);
      // The dead view no longer receives direct posts either.
      brokeredProvider.postMessage({ type: 'org:list:response', payload: { orgs: [] } });
      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    it('disposes the previous registration when the view is re-resolved', () => {
      brokeredProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
      const secondView = createMockView();

      brokeredProvider.resolveWebviewView(secondView as never, {} as never, {} as never);

      // Exactly one live registration: the re-resolved view, not both.
      expect(broker.panelCount).toBe(1);

      const broadcast = { id: 'b-2', type: 'operation:completed', timestamp: Date.now() };
      broker.postToWebview(broadcast as never);
      expect((secondView.webview as Record<string, unknown>).postMessage).toHaveBeenCalledWith(
        broadcast,
      );
      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    it('releases the registration on provider dispose()', () => {
      brokeredProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
      expect(broker.panelCount).toBe(1);

      brokeredProvider.dispose();

      expect(broker.panelCount).toBe(0);
    });
  });

  describe('the line under Checkpoints', () => {
    const CHECKPOINT: SidebarLastCheckpoint = {
      checkpointId: 'ck-20261028-120000-0001',
      name: 'Before UAT',
      takenAt: '2026-10-28T12:00:00.000Z',
    };
    /** What the store holds, by registered org: a take or a deletion changes it. */
    let held: Map<string, SidebarLastCheckpoint>;
    let getter: ReturnType<
      typeof vi.fn<(orgId: string) => Promise<SidebarLastCheckpoint | undefined>>
    >;
    let lineProvider: SidebarViewProvider;

    /** A provider whose line is read by `read`. */
    function providerReading(
      read: (orgId: string) => Promise<SidebarLastCheckpoint | undefined>,
    ): SidebarViewProvider {
      return new SidebarViewProvider(
        extensionUri,
        uriJoinPath,
        executeCommand,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        read,
      );
    }

    /** The answers the view `view` was posted for the line, in order. */
    function answers(view: Record<string, unknown> = mockWebview): unknown[] {
      return vi
        .mocked(view.postMessage as (message: { type: string; payload: unknown }) => void)
        .mock.calls.map(([message]) => message)
        .filter((message) => message.type === 'sidebar:lastCheckpoint')
        .map((message) => message.payload);
    }

    /** Ask the line of `orgId` as the sidebar does, and give back the answer it gets. */
    async function ask(orgId: string, view: Record<string, unknown> = mockWebview) {
      const before = answers(view).length;
      messageHandler!({ type: 'sidebar:requestLastCheckpoint', payload: { orgId } });
      await vi.waitFor(() => expect(answers(view)).toHaveLength(before + 1));
      return answers(view)[before];
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-10-28T14:00:00.000Z'));
      held = new Map();
      getter = vi.fn((orgId: string) => Promise.resolve(held.get(orgId)));
      lineProvider = providerReading(getter);
      lineProvider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers the org’s latest checkpoint the store holds, and no checkpoint for an org with none', async () => {
      held.set('org-1', CHECKPOINT);

      expect(await ask('org-1')).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      expect(await ask('org-2')).toEqual({ orgId: 'org-2' });
      expect(getter.mock.calls.map(([orgId]) => orgId)).toEqual(['org-1', 'org-2']);

      // A request that names no org reads nothing.
      messageHandler!({ type: 'sidebar:requestLastCheckpoint', payload: {} });
      messageHandler!({ type: 'sidebar:requestLastCheckpoint', payload: { orgId: 7 } });
      expect(getter).toHaveBeenCalledTimes(2);
    });

    it('answers from what it read within the minute, and reads the store again once the minute is over', async () => {
      // The clock as the read begins: waiting for an answer moves it on.
      const readAt = Date.now();
      expect(await ask('org-1')).toEqual({ orgId: 'org-1' });
      // A take from the command line: this window is told nothing of it.
      held.set('org-1', CHECKPOINT);

      vi.setSystemTime(readAt + LAST_CHECKPOINT_CACHE_MS - 1);
      expect(await ask('org-1')).toEqual({ orgId: 'org-1' });
      expect(getter).toHaveBeenCalledTimes(1);

      vi.setSystemTime(readAt + LAST_CHECKPOINT_CACHE_MS);
      expect(await ask('org-1')).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      expect(getter).toHaveBeenCalledTimes(2);
      expect(LAST_CHECKPOINT_CACHE_MS).toBe(60_000);
    });

    it('reads again at once, and tells the org the sidebar shows, when the checkpoints change in this window', async () => {
      // Nothing asked yet: nothing to tell, nothing read.
      lineProvider.checkpointsChanged();
      expect(getter).not.toHaveBeenCalled();
      expect(answers()).toEqual([]);

      await ask('org-2');
      expect(await ask('org-1')).toEqual({ orgId: 'org-1' });
      held.set('org-1', CHECKPOINT);

      lineProvider.checkpointsChanged();

      // Told without asking, within the minute what was read would last.
      await vi.waitFor(() => expect(answers()).toHaveLength(3));
      expect(answers()[2]).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      // The other org's read is let go too: asked again, it is read again.
      await ask('org-2');
      expect(getter.mock.calls.map(([orgId]) => orgId)).toEqual([
        'org-2',
        'org-1',
        'org-1',
        'org-2',
      ]);
    });

    it('keeps what it read across views: VS Code recreates the view at each reveal', async () => {
      held.set('org-1', CHECKPOINT);
      await ask('org-1');

      const revealed = createMockView();
      lineProvider.resolveWebviewView(revealed as never, {} as never, {} as never);

      const view = revealed.webview as Record<string, unknown>;
      expect(await ask('org-1', view)).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it('neither keeps nor answers a read the checkpoints changed under: the read the change began answers', async () => {
      let finishStale: (checkpoint: SidebarLastCheckpoint | undefined) => void = () => undefined;
      getter.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStale = resolve;
          }),
      );
      messageHandler!({ type: 'sidebar:requestLastCheckpoint', payload: { orgId: 'org-1' } });
      await vi.waitFor(() => expect(getter).toHaveBeenCalledTimes(1));
      // A take kept while the store was being listed.
      held.set('org-1', CHECKPOINT);
      lineProvider.checkpointsChanged();
      await vi.waitFor(() => expect(answers()).toHaveLength(1));
      expect(answers()[0]).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });

      // The read begun before the take ends now, on the store before it.
      finishStale(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(answers()).toHaveLength(1);

      expect(await ask('org-1')).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      expect(getter).toHaveBeenCalledTimes(2);
    });

    it('answers no checkpoint when the store cannot be read, and reads it again the next time', async () => {
      held.set('org-1', CHECKPOINT);
      getter.mockRejectedValueOnce(new Error('The checkpoints cannot be kept in the store'));

      expect(await ask('org-1')).toEqual({ orgId: 'org-1' });
      expect(await ask('org-1')).toEqual({ orgId: 'org-1', checkpoint: CHECKPOINT });
      expect(getter).toHaveBeenCalledTimes(2);
    });
  });

  describe('the language the sidebar asks for', () => {
    it('answers with the namespaces the sidebar renders, not the whole catalogue', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sidebar-locale-'));
      try {
        await mkdir(join(root, 'webview-dist', 'locales'), { recursive: true });
        const catalogue = {
          sidePanel: { noOrg: 'Aucune org connectée' },
          nav: { seed: 'Seed' },
          common: { dateUnknown: 'Date inconnue' },
          errorBoundary: { title: 'Un problème est survenu' },
          home: { opStatus: { success: 'Réussi' } },
          forge: { title: 'Forge', huge: 'x'.repeat(10_000) },
          onboarding: { welcome: 'Bienvenue' },
        };
        await writeFile(
          join(root, 'webview-dist', 'locales', 'fr.json'),
          JSON.stringify(catalogue),
        );
        const located = new SidebarViewProvider(
          { fsPath: root, toString: () => root } as unknown as vscode.Uri,
          uriJoinPath,
          executeCommand,
        );
        located.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

        messageHandler!({ payload: { type: 'i18n:locale', id: 'req-1', payload: { lng: 'fr' } } });

        await vi.waitFor(() => expect(mockWebview.postMessage).toHaveBeenCalled());
        const answer = vi.mocked(mockWebview.postMessage as (m: unknown) => void).mock
          .calls[0][0] as {
          type: string;
          correlationId: string;
          payload: { lng: string; bundle: Record<string, unknown> };
        };
        expect(answer.type).toBe('i18n:locale:response');
        expect(answer.correlationId).toBe('req-1');
        expect(answer.payload.lng).toBe('fr');
        expect(Object.keys(answer.payload.bundle).sort()).toEqual([
          'common',
          'errorBoundary',
          'home',
          'nav',
          'sidePanel',
        ]);
        expect(answer.payload.bundle.sidePanel).toEqual({ noOrg: 'Aucune org connectée' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
