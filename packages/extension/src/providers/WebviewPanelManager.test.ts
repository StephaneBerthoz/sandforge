import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { MessageBroker } from '../bridge/MessageBroker';
import { WebviewPanelManager } from './WebviewPanelManager';
import type { WebviewPanelFactory, PanelConfig, UriJoinPath } from './WebviewPanelManager';

interface MockWebviewPanel {
  webview: {
    html: string;
    cspSource: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: ReturnType<typeof vi.fn>;
  };
  visible: boolean;
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  onDidChangeViewState: ReturnType<typeof vi.fn>;
}

function createMockWebviewPanel(): MockWebviewPanel {
  return {
    webview: {
      html: '',
      cspSource: 'https://test.csp.source',
      onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      postMessage: vi.fn(),
      asWebviewUri: vi.fn().mockImplementation((uri: { toString: () => string }) => ({
        toString: () => `vscode-webview://test/${String(uri)}`,
      })),
    },
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeViewState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  };
}

describe('WebviewPanelManager', () => {
  let broker: MessageBroker;
  let manager: WebviewPanelManager;
  let factory: ReturnType<typeof vi.fn>;
  let lastCreatedPanel: MockWebviewPanel;

  beforeEach(() => {
    broker = new MessageBroker();
    factory = vi.fn().mockImplementation(() => {
      lastCreatedPanel = createMockWebviewPanel();
      return lastCreatedPanel;
    });
    manager = new WebviewPanelManager(broker, factory as WebviewPanelFactory);
  });

  describe('openPanel (backward compatible, no extensionUri)', () => {
    it('should create a new panel via the factory with retainContextWhenHidden', () => {
      const config: PanelConfig = {
        viewType: 'sandforge.seed',
        title: 'Seed',
      };

      manager.openPanel(config);

      expect(factory).toHaveBeenCalledWith('sandforge.seed', 'Seed', 1, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: undefined,
      });
    });

    it('should use the provided column', () => {
      manager.openPanel({
        viewType: 'sandforge.compare',
        title: 'Compare',
        column: 2,
      });

      expect(factory).toHaveBeenCalledWith('sandforge.compare', 'Compare', 2, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: undefined,
      });
    });

    it('should register the panel with the broker', () => {
      const registerSpy = vi.spyOn(broker, 'registerPanel');

      manager.openPanel({ viewType: 'test', title: 'Test' });

      expect(registerSpy).toHaveBeenCalledWith(lastCreatedPanel);
    });

    it('should track the panel for subsequent lookups', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      expect(manager.hasPanel('test')).toBe(true);
      expect(manager.getOpenPanels()).toContain('test');
    });

    it('should reveal an existing panel instead of creating a new one', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });
      const firstPanel = lastCreatedPanel;

      const returned = manager.openPanel({
        viewType: 'test',
        title: 'Test',
        column: 2,
        preserveFocus: true,
      });

      expect(factory).toHaveBeenCalledOnce();
      expect(firstPanel.reveal).toHaveBeenCalledWith(2, true);
      expect(returned).toBe(firstPanel);
    });

    it('should register an onDidDispose handler that removes the panel', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      expect(lastCreatedPanel.onDidDispose).toHaveBeenCalledOnce();

      const disposeCallback = lastCreatedPanel.onDidDispose.mock.calls[0][0] as () => void;
      disposeCallback();

      expect(manager.hasPanel('test')).toBe(false);
    });

    it('should return the created panel', () => {
      const panel = manager.openPanel({ viewType: 'test', title: 'Test' });
      expect(panel).toBe(lastCreatedPanel);
    });

    it('should not set HTML when no extensionUri is provided', () => {
      manager.openPanel({ viewType: 'test', title: 'Test', moduleId: 'monitor' });

      expect(lastCreatedPanel.webview.html).toBe('');
    });
  });

  describe('openPanel (with extensionUri and uriJoinPath)', () => {
    let managerWithUri: WebviewPanelManager;
    const mockExtensionUri = { toString: () => 'file:///ext' };
    const mockUriJoinPath: UriJoinPath = vi
      .fn()
      .mockImplementation((_base: unknown, ...segments: string[]) => ({
        toString: () => `file:///ext/${segments.join('/')}`,
      }));

    beforeEach(() => {
      managerWithUri = new WebviewPanelManager(
        broker,
        factory as WebviewPanelFactory,
        mockExtensionUri,
        mockUriJoinPath,
      );
    });

    it('should limit localResourceRoots to the webview bundle when extensionUri is set', () => {
      managerWithUri.openPanel({ viewType: 'test', title: 'Test' });

      expect(factory).toHaveBeenCalledWith('test', 'Test', 1, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [expect.anything()],
      });
      const options = factory.mock.calls[0][3] as {
        localResourceRoots: { toString(): string }[];
      };
      expect(options.localResourceRoots.map(String)).toEqual(['file:///ext/webview-dist']);
    });

    it('should announce the VS Code display language to the panel shell', () => {
      const withLanguage = new WebviewPanelManager(
        broker,
        factory as WebviewPanelFactory,
        mockExtensionUri,
        mockUriJoinPath,
        () => undefined,
        () => 'de',
      );

      withLanguage.openPanel({
        viewType: 'sandforge.monitor',
        title: 'Monitor',
        moduleId: 'monitor',
      });

      expect(lastCreatedPanel.webview.html).toContain('window.__SANDFORGE_EDITOR_LANGUAGE__="de"');
    });

    it('should generate HTML with moduleId injection when moduleId is provided', () => {
      managerWithUri.openPanel({
        viewType: 'sandforge.monitor',
        title: 'Monitor',
        moduleId: 'monitor',
      });

      const html = lastCreatedPanel.webview.html;
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain('window.__SANDFORGE_MODULE__="monitor"');
      expect(html).toContain('SandForge: monitor');
    });

    it('loads the panel bundle as a module script, which imports each page when it is shown', () => {
      managerWithUri.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });

      expect(lastCreatedPanel.webview.html).toMatch(
        /<script nonce="[^"]+" type="module" src="[^"]*index\.js"/,
      );
    });

    it('should include a CSP meta tag with a nonce', () => {
      managerWithUri.openPanel({
        viewType: 'sandforge.seed',
        title: 'Seed',
        moduleId: 'seed',
      });

      const html = lastCreatedPanel.webview.html;
      expect(html).toContain('Content-Security-Policy');
      // base64url alphabet: A-Z, a-z, 0-9, `-`, `_` (24 random bytes → 32 chars)
      expect(html).toMatch(/nonce-[A-Za-z0-9_-]{32}/);
    });

    it('should call uriJoinPath to resolve script and style URIs', () => {
      managerWithUri.openPanel({
        viewType: 'sandforge.sync',
        title: 'Sync',
        moduleId: 'sync',
      });

      expect(mockUriJoinPath).toHaveBeenCalledWith(
        mockExtensionUri,
        'webview-dist',
        'assets',
        'index.js',
      );
      expect(mockUriJoinPath).toHaveBeenCalledWith(
        mockExtensionUri,
        'webview-dist',
        'assets',
        'style.css',
      );
    });

    it('should call asWebviewUri for script and style resources', () => {
      managerWithUri.openPanel({
        viewType: 'sandforge.compare',
        title: 'Compare',
        moduleId: 'compare',
      });

      expect(lastCreatedPanel.webview.asWebviewUri).toHaveBeenCalledTimes(2);
    });

    it('should not generate HTML when moduleId is omitted', () => {
      managerWithUri.openPanel({ viewType: 'test', title: 'Test' });

      expect(lastCreatedPanel.webview.html).toBe('');
    });
  });

  describe('a module panel’s title in the panels’ language', () => {
    /** A panel's title, which the mock panel does not declare. */
    const titleOfPanel = (panel: MockWebviewPanel): unknown =>
      (panel as MockWebviewPanel & { title?: string }).title;

    it('takes the title read for its module once it is read, on opening and on reopening', async () => {
      const titles = ['SandForge: Vergleich', 'SandForge: Comparaison'];
      const titleOf = vi.fn(() => Promise.resolve(titles.shift()));
      manager.setTitleOf(titleOf);

      manager.openPanel({
        viewType: 'sandforge.compare',
        title: 'Compare Org',
        moduleId: 'compare',
      });
      const panel = lastCreatedPanel;
      expect(factory).toHaveBeenCalledWith(
        'sandforge.compare',
        'Compare Org',
        1,
        expect.anything(),
      );
      await vi.waitFor(() => expect(titleOfPanel(panel)).toBe('SandForge: Vergleich'));

      // The panels' language changed meanwhile: reopened, the panel says it in that one.
      manager.openPanel({
        viewType: 'sandforge.compare',
        title: 'Compare Org',
        moduleId: 'compare',
      });
      await vi.waitFor(() => expect(titleOfPanel(panel)).toBe('SandForge: Comparaison'));
      expect(titleOf).toHaveBeenCalledWith('compare');
    });

    it('keeps the title it opened with when none is read, and titles no panel without a module', async () => {
      const titleOf = vi.fn((moduleId: string) =>
        moduleId === 'broken'
          ? Promise.reject(new Error('unreadable'))
          : Promise.resolve(undefined),
      );
      manager.setTitleOf(titleOf);

      manager.openPanel({ viewType: 'sandforge.broken', title: 'Opened', moduleId: 'broken' });
      const unread = lastCreatedPanel;
      manager.openPanel({ viewType: 'sandforge.unknown', title: 'Opened', moduleId: 'unknown' });
      const unnamed = lastCreatedPanel;
      manager.openPanel({ viewType: 'plain', title: 'Plain' });
      await Promise.resolve();
      await Promise.resolve();

      expect(titleOfPanel(unread)).toBeUndefined();
      expect(titleOfPanel(unnamed)).toBeUndefined();
      expect(titleOf).toHaveBeenCalledTimes(2);
    });

    it('does not title a panel closed before its title was read', async () => {
      let answer: (title: string) => void = () => undefined;
      manager.setTitleOf(
        () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
      );
      manager.openPanel({ viewType: 'sandforge.seed', title: 'Seed', moduleId: 'seed' });
      const closed = lastCreatedPanel;
      manager.closePanel('sandforge.seed');
      // The close reaches the manager through the panel's dispose event.
      const onDispose = closed.onDidDispose.mock.calls[0][0] as () => void;
      onDispose();

      answer('SandForge: Seed');
      await Promise.resolve();

      expect(titleOfPanel(closed)).toBeUndefined();
    });
  });

  describe('closePanel', () => {
    it('should dispose the panel and remove it from tracking', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });
      const panel = lastCreatedPanel;

      manager.closePanel('test');

      expect(panel.dispose).toHaveBeenCalledOnce();
      expect(manager.hasPanel('test')).toBe(false);
    });

    it('should do nothing for a non-existent viewType', () => {
      expect(() => manager.closePanel('nonexistent')).not.toThrow();
    });
  });

  describe('hasPanel', () => {
    it('should return false when no panel exists for the viewType', () => {
      expect(manager.hasPanel('nonexistent')).toBe(false);
    });

    it('should return true when a panel exists for the viewType', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      expect(manager.hasPanel('test')).toBe(true);
    });
  });

  describe('getOpenPanels', () => {
    it('should return an empty array when no panels are open', () => {
      expect(manager.getOpenPanels()).toEqual([]);
    });

    it('should return the viewTypes of all open panels', () => {
      manager.openPanel({ viewType: 'panel-a', title: 'A' });
      manager.openPanel({ viewType: 'panel-b', title: 'B' });

      const open = manager.getOpenPanels();
      expect(open).toHaveLength(2);
      expect(open).toContain('panel-a');
      expect(open).toContain('panel-b');
    });
  });

  describe('dispose', () => {
    it('should dispose all open panels and clear the registry', () => {
      manager.openPanel({ viewType: 'panel-a', title: 'A' });
      const panelA = lastCreatedPanel;
      manager.openPanel({ viewType: 'panel-b', title: 'B' });
      const panelB = lastCreatedPanel;

      manager.dispose();

      expect(panelA.dispose).toHaveBeenCalledOnce();
      expect(panelB.dispose).toHaveBeenCalledOnce();
      expect(manager.getOpenPanels()).toEqual([]);
    });

    it('should handle dispose when no panels are open', () => {
      expect(() => manager.dispose()).not.toThrow();
    });

    it('should clear visiblePanels on dispose', () => {
      manager.openPanel({ viewType: 'panel-a', title: 'A' });
      expect(manager.isAnyPanelVisible()).toBe(true);

      manager.dispose();
      expect(manager.isAnyPanelVisible()).toBe(false);
    });
  });

  describe('isAnyPanelVisible', () => {
    it('should return true when a panel is open and visible', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      expect(manager.isAnyPanelVisible()).toBe(true);
    });

    it('should return false when no panels are open', () => {
      expect(manager.isAnyPanelVisible()).toBe(false);
    });

    it('should return false when panel is hidden via onDidChangeViewState', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });
      expect(manager.isAnyPanelVisible()).toBe(true);

      // Simulate panel becoming hidden
      const changeCallback = lastCreatedPanel.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;
      changeCallback({ webviewPanel: { visible: false } });

      expect(manager.isAnyPanelVisible()).toBe(false);
    });

    it('should return true again when panel becomes visible', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      const changeCallback = lastCreatedPanel.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;
      changeCallback({ webviewPanel: { visible: false } });
      expect(manager.isAnyPanelVisible()).toBe(false);

      changeCallback({ webviewPanel: { visible: true } });
      expect(manager.isAnyPanelVisible()).toBe(true);
    });
  });

  describe('panel visibility', () => {
    it('tells the panel VS Code hid or showed, and no other', () => {
      manager.openPanel({ viewType: 'monitor', title: 'Monitor' });
      const monitor = lastCreatedPanel;
      manager.openPanel({ viewType: 'seed', title: 'Seed' });
      const seed = lastCreatedPanel;
      const changeCallback = monitor.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;

      changeCallback({ webviewPanel: { visible: false } });
      changeCallback({ webviewPanel: { visible: true } });

      const sent = monitor.webview.postMessage.mock.calls.map(
        ([message]) => message as { type: string; payload: { visible: boolean } },
      );
      expect(sent.map((m) => [m.type, m.payload.visible])).toEqual([
        ['panel:visibility', false],
        ['panel:visibility', true],
      ]);
      expect(seed.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('a page released while hidden', () => {
    const extensionUri = { toString: () => 'file:///ext' };
    const joinPath: UriJoinPath = (_base: unknown, ...segments: string[]) => ({
      toString: () => `file:///ext/${segments.join('/')}`,
    });
    let released: WebviewPanelManager;

    beforeEach(() => {
      released = new WebviewPanelManager(
        broker,
        factory as WebviewPanelFactory,
        extensionUri,
        joinPath,
      );
    });

    /** Show or hide a panel as VS Code does. */
    const setVisible = (panel: MockWebviewPanel, visible: boolean): void => {
      const change = panel.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;
      change({ webviewPanel: { visible } });
    };

    /** What the panel's page says it shows, as `ExtensionHandlers` hands it over. */
    const pageShows = (payload: { moduleId: string; route: string; overlay: boolean }): void => {
      released.notePageShown({
        id: `route-${payload.route}`,
        type: 'panel:route',
        timestamp: 1,
        payload,
      } as BaseMessage);
    };

    it('releases a hidden Help panel, and brings it back with its page when it is shown', () => {
      released.openPanel({ viewType: 'sandforge.help', title: 'Help', moduleId: 'help' });
      const help = lastCreatedPanel;
      const shell = help.webview.html;
      expect(shell).toContain('window.__SANDFORGE_MODULE__="help"');

      setVisible(help, false);

      // The page and its bundle are let go: what the panel holds runs nothing.
      expect(help.webview.html).not.toContain('<script');
      expect(help.webview.html).toContain("default-src 'none'");
      expect(released.isLive('sandforge.help')).toBe(false);
      expect(released.hasPanel('sandforge.help')).toBe(true);

      setVisible(help, true);

      expect(help.webview.html).toContain('window.__SANDFORGE_MODULE__="help"');
      expect(help.webview.html).toMatch(/<script nonce="[^"]+" type="module" src="[^"]*index\.js"/);
      expect(released.isLive('sandforge.help')).toBe(true);
    });

    it('releases a hidden Reports panel too', () => {
      released.openPanel({ viewType: 'sandforge.reports', title: 'Reports', moduleId: 'reports' });
      const reports = lastCreatedPanel;

      setVisible(reports, false);

      expect(reports.webview.html).not.toContain('<script');
      expect(released.isLive('sandforge.reports')).toBe(false);
    });

    it('keeps the page of a module that runs or edits something, hidden or not', () => {
      for (const moduleId of ['seed', 'sync', 'forge', 'orgs', 'settings', 'ai']) {
        released.openPanel({ viewType: `sandforge.${moduleId}`, title: moduleId, moduleId });
        const panel = lastCreatedPanel;
        const shell = panel.webview.html;

        setVisible(panel, false);

        expect(panel.webview.html).toBe(shell);
        expect(released.isLive(`sandforge.${moduleId}`)).toBe(true);
      }
    });

    it('keeps a Help panel whose page routed to another module', () => {
      // The shortcuts, the palette and Help's own link route inside the
      // panel: a Settings page shown there holds its unsaved edits.
      released.openPanel({ viewType: 'sandforge.help', title: 'Help', moduleId: 'help' });
      const help = lastCreatedPanel;
      const shell = help.webview.html;
      pageShows({ moduleId: 'help', route: 'settings', overlay: false });

      setVisible(help, false);

      expect(help.webview.html).toBe(shell);
      expect(released.isLive('sandforge.help')).toBe(true);
    });

    it('keeps a Help panel with the welcome tour open, and releases it once it is back on Help', () => {
      released.openPanel({ viewType: 'sandforge.help', title: 'Help', moduleId: 'help' });
      const help = lastCreatedPanel;
      const shell = help.webview.html;
      pageShows({ moduleId: 'help', route: 'help', overlay: true });

      setVisible(help, false);
      expect(help.webview.html).toBe(shell);

      setVisible(help, true);
      pageShows({ moduleId: 'help', route: 'help', overlay: false });
      setVisible(help, false);
      expect(help.webview.html).not.toContain('<script');
    });

    it('rebuilds the page on its own module, whatever it showed before', () => {
      released.openPanel({ viewType: 'sandforge.help', title: 'Help', moduleId: 'help' });
      const help = lastCreatedPanel;
      setVisible(help, false);
      setVisible(help, true);
      // The rebuilt page shows Help again until it says otherwise.
      setVisible(help, false);

      expect(help.webview.html).not.toContain('<script');
    });

    it('ignores what a page says in a shape it does not know', () => {
      released.openPanel({ viewType: 'sandforge.help', title: 'Help', moduleId: 'help' });
      const help = lastCreatedPanel;
      released.notePageShown({
        id: 'bad',
        type: 'panel:route',
        timestamp: 1,
        payload: { route: 7 },
      } as unknown as BaseMessage);

      setVisible(help, false);

      expect(help.webview.html).not.toContain('<script');
    });
  });

  describe('a page that could not load a part of itself', () => {
    const extensionUri = { toString: () => 'file:///ext' };
    const joinPath: UriJoinPath = (_base: unknown, ...segments: string[]) => ({
      toString: () => `file:///ext/${segments.join('/')}`,
    });
    let reloading: WebviewPanelManager;

    beforeEach(() => {
      reloading = new WebviewPanelManager(
        broker,
        factory as WebviewPanelFactory,
        extensionUri,
        joinPath,
      );
    });

    /** The page's request for its shell, as `ExtensionHandlers` hands it over. */
    const reloadAsked = (payload: unknown): void => {
      reloading.reloadPage({
        id: 'reload-1',
        type: 'panel:reload',
        timestamp: 1,
        payload,
      } as BaseMessage);
    };

    it("sets the shell of the module's panel again, a new document with a new nonce", () => {
      // React keeps a part whose file failed to load failed for as long as the
      // document lives: the page's Recover drew the same failure again, and
      // only closing the tab, and the Forge graph with it, got out of it.
      reloading.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });
      const forge = lastCreatedPanel;
      reloading.openPanel({ viewType: 'sandforge.sync', title: 'Sync', moduleId: 'sync' });
      const sync = lastCreatedPanel;
      const forgeShell = forge.webview.html;
      const syncShell = sync.webview.html;

      reloadAsked({ moduleId: 'forge' });

      expect(forge.webview.html).not.toBe(forgeShell);
      expect(forge.webview.html).toContain('window.__SANDFORGE_MODULE__="forge"');
      expect(forge.webview.html).toMatch(
        /<script nonce="[^"]+" type="module" src="[^"]*index\.js"/,
      );
      expect(sync.webview.html).toBe(syncShell);
    });

    it('ignores a module with no panel open, a closed one, and a payload of another shape', () => {
      reloading.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });
      const forge = lastCreatedPanel;
      const shell = forge.webview.html;

      reloadAsked({ moduleId: 'monitor' });
      reloadAsked({ moduleId: 7 });
      reloadAsked(undefined);
      expect(forge.webview.html).toBe(shell);

      reloading.closePanel('sandforge.forge');
      reloadAsked({ moduleId: 'forge' });
      expect(forge.webview.html).toBe(shell);
    });
  });

  describe("the page's chunks, linked in its shell", () => {
    const extensionUri = { toString: () => 'file:///ext' };
    const joinPath: UriJoinPath = (_base: unknown, ...segments: string[]) => ({
      toString: () => `file:///ext/${segments.join('/')}`,
    });
    const LIST = JSON.stringify({
      forge: ['assets/chunks/ForgePage-a1.js', 'assets/chunks/Button-b2.js'],
      home: ['assets/chunks/HomePage-c3.js'],
    });
    const manager = (): WebviewPanelManager =>
      new WebviewPanelManager(broker, factory as WebviewPanelFactory, extensionUri, joinPath);

    it("links the files the build lists for the panel's page, read once from webview-dist", () => {
      const reads: string[] = [];
      const preloading = manager();
      preloading.setFileReader((uri) => {
        reads.push(String(uri));
        return LIST;
      });

      preloading.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });
      const forge = lastCreatedPanel.webview.html;
      preloading.openPanel({ viewType: 'sandforge.home', title: 'Home', moduleId: 'home' });
      const home = lastCreatedPanel.webview.html;

      expect(reads).toEqual(['file:///ext/webview-dist/assets/preload.json']);
      expect(forge).toContain('rel="modulepreload" nonce="');
      expect(forge).toContain(
        'href="vscode-webview://test/file:///ext/webview-dist/assets/chunks/ForgePage-a1.js"',
      );
      expect(forge).toContain('webview-dist/assets/chunks/Button-b2.js');
      expect(forge).not.toContain('HomePage-c3.js');
      expect(home).toContain('webview-dist/assets/chunks/HomePage-c3.js');
    });

    it('links nothing without a reader, for a list it cannot read, or for a module the list leaves out', () => {
      const bare = manager();
      bare.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });
      expect(lastCreatedPanel.webview.html).not.toContain('modulepreload');

      const unreadable = manager();
      unreadable.setFileReader(() => {
        throw new Error('ENOENT');
      });
      unreadable.openPanel({ viewType: 'sandforge.forge', title: 'Forge', moduleId: 'forge' });
      expect(lastCreatedPanel.webview.html).not.toContain('modulepreload');
      expect(lastCreatedPanel.webview.html).toContain('window.__SANDFORGE_MODULE__="forge"');

      const listed = manager();
      listed.setFileReader(() => LIST);
      listed.openPanel({ viewType: 'sandforge.sync', title: 'Sync', moduleId: 'sync' });
      expect(lastCreatedPanel.webview.html).not.toContain('modulepreload');
    });
  });

  describe('closePanel removes from visiblePanels', () => {
    it('should remove from visible set on close', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });
      expect(manager.isAnyPanelVisible()).toBe(true);

      manager.closePanel('test');
      expect(manager.isAnyPanelVisible()).toBe(false);
    });
  });

  describe('broker panel registration', () => {
    it('should unregister the panel from the broker when the panel is disposed', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });
      expect(broker.panelCount).toBe(1);

      const disposeCallback = lastCreatedPanel.onDidDispose.mock.calls[0][0] as () => void;
      disposeCallback();

      expect(broker.panelCount).toBe(0);
    });

    it('should unregister all panels from the broker on manager dispose', () => {
      manager.openPanel({ viewType: 'panel-a', title: 'A' });
      manager.openPanel({ viewType: 'panel-b', title: 'B' });
      expect(broker.panelCount).toBe(2);

      // panel.dispose() is mocked here, so onDidDispose never fires — this
      // exercises the safety-net loop in dispose().
      manager.dispose();

      expect(broker.panelCount).toBe(0);
    });

    it('should tolerate double-dispose of the broker registration disposable', () => {
      const registerSpy = vi.spyOn(broker, 'registerPanel');
      manager.openPanel({ viewType: 'test', title: 'Test' });

      const registration = registerSpy.mock.results[0]?.value as { dispose(): void };
      registration.dispose();

      expect(() => registration.dispose()).not.toThrow();
      expect(broker.panelCount).toBe(0);
    });
  });
});
