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
  /** No version recorded yet: the extension has never run in this profile. */
  firstLaunch?: boolean;
  /** Onboarding never completed: the flag the wizard used to be shown on. */
  shouldShowOnboarding?: boolean;
  shouldShowWhatsNew?: boolean;
  whatsNewWanted?: boolean;
}) {
  const panel = createFakePanel();
  const panelManager = {
    hasPanel: vi.fn(() => options.panelAlreadyOpen),
    openPanel: vi.fn(() => panel),
    postToAllPanels: vi.fn(),
  };
  const onboardingService = {
    isFirstLaunch: vi.fn(() => options.firstLaunch ?? false),
    shouldShowOnboarding: vi.fn(() => options.shouldShowOnboarding ?? false),
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
    ...(options.whatsNewWanted !== undefined
      ? { whatsNewWanted: () => options.whatsNewWanted }
      : {}),
  } as unknown as ModuleCommandsDeps;
  return { deps, panel, panelManager, onboardingService, context };
}

function invokeFirstModuleCommand(): void {
  const callback = registeredCommands.get(MODULE_COMMANDS[0].command);
  expect(callback).toBeDefined();
  callback?.();
}

describe("commandsComposition What's New delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it('shows no welcome wizard on a first launch, and records the version for the next upgrade', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      firstLaunch: true,
      shouldShowOnboarding: true,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();
    panel.fireIncomingMessage({ type: 'webview:ready' });

    // The walkthrough VS Code opens on install is the first-run script: the
    // wizard covered the page it had sent the user to, every session.
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(panel.webview.onDidReceiveMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).toHaveBeenCalledWith('2.0.0');
  });

  it('shows no welcome wizard to someone who never finished it', () => {
    const { deps, panel } = createDeps({
      panelAlreadyOpen: true,
      shouldShowOnboarding: true,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it("new panel: neither posts What's New nor marks the version seen before the first incoming message", () => {
    const { deps, panel, onboardingService, context } = createDeps({
      panelAlreadyOpen: false,
      shouldShowWhatsNew: true,
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

  it("new panel: posts What's New exactly once on the first incoming message, then marks the version seen", () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      shouldShowWhatsNew: true,
    });
    registerModuleCommands(deps);
    invokeFirstModuleCommand();

    panel.fireIncomingMessage({ type: 'webview:ready' });

    // Targeted to the triggering panel — not broadcast to every open panel.
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    const posted = panel.webview.postMessage.mock.calls[0][0] as { type: string };
    expect(posted.type).toBe('whats-new:show');
    // markVersionSeen only fires once the message can actually be received —
    // before the fix it ran immediately, so a lost message was still recorded
    // as shown and the panel never appeared.
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
      shouldShowWhatsNew: true,
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

  it("turned off in the settings: shows no What's New, and records the upgrade as seen", () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: true,
      shouldShowWhatsNew: true,
      whatsNewWanted: false,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).toHaveBeenCalledWith('2.0.0');
  });

  it('hands a new Organizations panel the import it was opened for, once its bundle is up', () => {
    const { deps, panel } = createDeps({ panelAlreadyOpen: false });
    registerModuleCommands(deps);
    const openOrgs = registeredCommands.get('sandforge.openOrgs');

    openOrgs?.({ orgAction: 'import-cli' });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    panel.fireIncomingMessage({ type: 'org:list' });

    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage.mock.calls[0][0]).toMatchObject({
      type: 'navigation:intent',
      payload: { route: 'orgs', orgAction: 'import-cli' },
    });
  });

  it('hands an open panel its intent at once, and every later command its own', () => {
    const { deps, panel } = createDeps({ panelAlreadyOpen: true });
    registerModuleCommands(deps);
    const openOrgs = registeredCommands.get('sandforge.openOrgs');

    openOrgs?.({ orgAction: 'login-web' });
    openOrgs?.({ orgAction: 'import-cli' });

    const posted = panel.webview.postMessage.mock.calls.map(
      (call) => (call[0] as { payload: { orgAction: string } }).payload.orgAction,
    );
    expect(posted).toEqual(['login-web', 'import-cli']);
  });

  it('hands nothing for an argument the intent schema refuses', () => {
    const { deps, panel } = createDeps({ panelAlreadyOpen: true });
    registerModuleCommands(deps);

    registeredCommands.get('sandforge.openOrgs')?.({ orgAction: 'wipe' });

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('arms nothing and marks nothing when there is no upgrade to tell of', () => {
    const { deps, panel, onboardingService } = createDeps({
      panelAlreadyOpen: false,
      shouldShowWhatsNew: false,
    });
    registerModuleCommands(deps);

    invokeFirstModuleCommand();

    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(onboardingService.markVersionSeen).not.toHaveBeenCalled();
    expect(panel.webview.onDidReceiveMessage).not.toHaveBeenCalled();
  });
});
