import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    it('should include localResourceRoots when extensionUri is set', () => {
      managerWithUri.openPanel({ viewType: 'test', title: 'Test' });

      expect(factory).toHaveBeenCalledWith('test', 'Test', 1, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mockExtensionUri],
      });
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

  describe('onVisibilityChange callback', () => {
    it('should fire on visibility transitions', () => {
      const callback = vi.fn();
      manager.onVisibilityChange = callback;

      manager.openPanel({ viewType: 'test', title: 'Test' });

      const changeCallback = lastCreatedPanel.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;

      changeCallback({ webviewPanel: { visible: false } });
      expect(callback).toHaveBeenCalledWith(false);

      changeCallback({ webviewPanel: { visible: true } });
      expect(callback).toHaveBeenCalledWith(true);

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should not throw when no callback is set', () => {
      manager.openPanel({ viewType: 'test', title: 'Test' });

      const changeCallback = lastCreatedPanel.onDidChangeViewState.mock.calls[0][0] as (e: {
        webviewPanel: { visible: boolean };
      }) => void;
      expect(() => changeCallback({ webviewPanel: { visible: false } })).not.toThrow();
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
