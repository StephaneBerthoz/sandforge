import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { SidebarViewProvider } from './SidebarViewProvider';
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
  });

  it('enables scripts and sets local resource roots', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect((mockWebview.options as Record<string, unknown>).enableScripts).toBe(true);
    expect((mockWebview.options as Record<string, unknown>).localResourceRoots).toEqual([
      extensionUri,
    ]);
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

  it('falls back to openMonitor for unknown routes', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);

    messageHandler!({ type: 'sidebar:navigate', payload: { route: 'does-not-exist' } });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openMonitor');
  });

  it('executes openMonitor on sidebar:openFull message', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    messageHandler!({ type: 'sidebar:openFull' });
    expect(executeCommand).toHaveBeenCalledWith('sandforge.openMonitor');
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
      payload: { settings: { settings: { language: 'fr' } } },
    });
  });

  it('ignores sidebar:requestSettings when no settings getter is wired', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    messageHandler!({ type: 'sidebar:requestSettings' });
    expect(mockWebview.postMessage).not.toHaveBeenCalled();
  });

  it('posts message to webview when visible', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    provider.postMessage({ type: 'test' });
    expect(mockWebview.postMessage).toHaveBeenCalledWith({ type: 'test' });
  });

  it('does nothing when posting before resolve', () => {
    // No resolveWebviewView called
    expect(() => provider.postMessage({ type: 'test' })).not.toThrow();
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
      brokeredProvider.postMessage({ type: 'org:list:response' });
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
});
