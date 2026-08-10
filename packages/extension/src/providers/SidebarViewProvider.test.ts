import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { SidebarViewProvider } from './SidebarViewProvider';
import { SIDEBAR_ROUTE_COMMANDS } from '../composition/moduleCommands';

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

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = undefined;

    mockWebview = {
      options: {},
      cspSource: 'https://test',
      asWebviewUri: (uri: unknown) => uri,
      html: '',
      onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
    };

    mockWebviewView = {
      webview: mockWebview,
    };

    provider = new SidebarViewProvider(extensionUri, uriJoinPath, executeCommand);
  });

  it('sets webview HTML with sidepanel module on resolve', () => {
    provider.resolveWebviewView(mockWebviewView as never, {} as never, {} as never);
    expect(mockWebview.html).toContain('__SANDFORGE_MODULE__="sidepanel"');
    expect(mockWebview.html).toContain('index.js');
    expect(mockWebview.html).toContain('style.css');
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
});
