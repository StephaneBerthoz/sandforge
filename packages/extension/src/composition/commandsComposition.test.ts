import { describe, it, expect, vi, beforeEach } from 'vitest';

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return { dispose: vi.fn() };
    }),
  },
}));

import { registerModuleCommands } from './commandsComposition';
import type { ModuleCommandsDeps } from './commandsComposition';
import { MODULE_COMMANDS } from './moduleCommands';

/**
 * Fake webview panel with capturable `onDidReceiveMessage` / `onDidDispose`
 * listeners. Disposing the returned handles detaches the listeners (same
 * semantics as a real VS Code disposable) so one-shot behavior can be
 * asserted.
 */
function createFakePanel() {
  let listener: ((msg: unknown) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const listenerDisposable = {
    dispose: vi.fn(() => {
      listener = undefined;
    }),
  };
  const onDidReceiveMessage = vi.fn((cb: (msg: unknown) => void) => {
    listener = cb;
    return listenerDisposable;
  });
  const onDidDispose = vi.fn((cb: () => void) => {
    disposeListener = cb;
    return { dispose: vi.fn() };
  });
  return {
    webview: { postMessage: vi.fn(), onDidReceiveMessage },
    onDidDispose,
    reveal: vi.fn(),
    dispose: vi.fn(),
    listenerDisposable,
    fireIncomingMessage: (msg: unknown): void => listener?.(msg),
    fireDispose: (): void => disposeListener?.(),
  };
}

function createDeps(options: {
  panelAlreadyOpen: boolean;
  shouldShowOnboarding: boolean;
  shouldShowWhatsNew?: boolean;
}) {
  const panel = createFakePanel();
  const panelManager = {
    hasPanel: vi.fn(() => options.panelAlreadyOpen),
    openPanel: vi.fn(() => panel),
    postToAllPanels: vi.fn(),
  };
  const onboardingService = {
    shouldShowOnboarding: vi.fn(() => options.shouldShowOnboarding),
    shouldShowWhatsNew: vi.fn(() => options.shouldShowWhatsNew ?? false),
    markVersionSeen: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    extension: { packageJSON: { version: '2.0.0' } },
    subscriptions: [] as unknown[],
  };
  const deps = {
    context,
    panelManager,
    orgRegistry: { loadAll: vi.fn() },
    orgManager: { getAllOrgs: vi.fn(() => []) },
    stateSync: { updateState: vi.fn() },
    onboardingService,
  } as unknown as ModuleCommandsDeps;
  return { deps, panel, panelManager, onboardingService, context };
}

function invokeFirstModuleCommand(): void {
  const callback = registeredCommands.get(MODULE_COMMANDS[0].command);
  expect(callback).toBeDefined();
  callback?.();
}

describe('commandsComposition onboarding/whats-new delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it('new panel: neither posts nor marks the version seen before the first incoming message', () => {
    const { deps, panel, onboardingService, context } = createDeps({
      panelAlreadyOpen: false,
      shouldShowOnboarding: true,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    // Posting now would race the bundle parse and lose the message.
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).not.toHaveBeenCalled();
    // A readiness listener is armed instead, and tracked for cleanup.
    expect(panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(1);
    expect(context.subscriptions).toContain(panel.listenerDisposable);
  });

  it('new panel: posts exactly once on the first incoming message, then marks the version seen', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      shouldShowOnboarding: true,
    });
    registerModuleCommands(deps);
    invokeFirstModuleCommand();

    panel.fireIncomingMessage({ type: 'webview:ready' });

    // Targeted to the triggering panel — not broadcast to every open panel.
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    const posted = panel.webview.postMessage.mock.calls[0][0] as { type: string };
    expect(posted.type).toBe('onboarding:show');
    // markVersionSeen only fires once the message can actually be received —
    // before the fix it ran immediately, so a lost message was still recorded
    // as shown and the welcome screen never appeared.
    expect(onboardingService.markVersionSeen).toHaveBeenCalledTimes(1);
    expect(onboardingService.markVersionSeen).toHaveBeenCalledWith('2.0.0');

    // One-shot: the listener disposed itself, so later messages do not re-post.
    expect(panel.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    panel.fireIncomingMessage({ type: 'webview:ready' });
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(onboardingService.markVersionSeen).toHaveBeenCalledTimes(1);
  });

  it('new panel: closing the panel before its first message disposes the readiness listener', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      shouldShowOnboarding: true,
    });
    registerModuleCommands(deps);
    invokeFirstModuleCommand();

    panel.fireDispose();

    expect(panel.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    // And no message was ever posted nor marked seen.
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).not.toHaveBeenCalled();
  });

  it('reveal (panel already open): posts immediately without arming a listener', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: true,
      shouldShowOnboarding: false,
      shouldShowWhatsNew: true,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    // Live panel: the bundle is already loaded, so no wait is needed.
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    const posted = panel.webview.postMessage.mock.calls[0][0] as {
      type: string;
      payload: { version: string };
    };
    expect(posted.type).toBe('whats-new:show');
    expect(posted.payload.version).toBe('2.0.0');
    expect(onboardingService.markVersionSeen).toHaveBeenCalledTimes(1);
    expect(onboardingService.markVersionSeen).toHaveBeenCalledWith('2.0.0');
    expect(panel.webview.onDidReceiveMessage).not.toHaveBeenCalled();
  });

  it('arms nothing and marks nothing when neither onboarding nor whats-new applies', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      shouldShowOnboarding: false,
      shouldShowWhatsNew: false,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).not.toHaveBeenCalled();
    expect(panel.webview.onDidReceiveMessage).not.toHaveBeenCalled();
  });
});
