import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Every command the manifest contributes must be registered by `activate()`.
 *
 * `contributes.commands` is what VS Code lists in the Command Palette; the
 * registration is what runs when one is picked. The two live in different
 * files and nothing tied them together: a command renamed on one side only
 * still shows in the palette and answers "command not found" when chosen —
 * after the extension has published.
 *
 * VS Code itself refuses a second registration of the same id, so each
 * contributed command must also be registered exactly once.
 */

const registrations = vi.hoisted(() => [] as string[]);

vi.mock('vscode', () => {
  const disposable = { dispose: () => undefined };
  const panel = {
    webview: {
      html: '',
      cspSource: 'https://test.csp.source',
      onDidReceiveMessage: () => disposable,
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: unknown) => uri,
    },
    reveal: () => undefined,
    dispose: () => undefined,
    onDidDispose: () => disposable,
    onDidChangeViewState: () => disposable,
  };
  return {
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
      registerWebviewViewProvider: () => disposable,
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      createWebviewPanel: () => panel,
      createTreeView: () => disposable,
      registerTreeDataProvider: () => disposable,
      showInformationMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined),
      showQuickPick: () => Promise.resolve(undefined),
    },
    commands: {
      registerCommand: (command: string) => {
        registrations.push(command);
        return disposable;
      },
      executeCommand: () => Promise.resolve(undefined),
    },
    env: { isTelemetryEnabled: false, openExternal: () => Promise.resolve(true) },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      onDidChangeConfiguration: () => disposable,
      workspaceFolders: undefined,
    },
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
      joinPath: (base: { toString: () => string }, ...segments: string[]) => ({
        toString: () => `${base.toString()}/${segments.join('/')}`,
      }),
    },
    l10n: { t: (message: string) => message },
    EventEmitter: class {
      event = () => disposable;
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    TreeItem: class {
      constructor(
        readonly label: string,
        readonly collapsibleState: number,
      ) {}
    },
  };
});

import type { ExtensionContext, Memento } from 'vscode';
import { activate, deactivate } from '../extension';

interface Manifest {
  contributes: { commands: Array<{ command: string }> };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as Manifest;

function memento(): Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T): T => (store.has(key) ? store.get(key) : fallback) as T,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function context(): ExtensionContext {
  return {
    extensionUri: { fsPath: '/test', toString: () => 'file:///test' },
    globalStorageUri: { fsPath: '/test/global', toString: () => 'file:///test/global' },
    extension: { id: 'sandforge.sandforge', packageJSON: { version: '0.0.0' } },
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    globalState: memento(),
    workspaceState: memento(),
  } as unknown as ExtensionContext;
}

describe('contributed commands', () => {
  const contributed = manifest.contributes.commands.map((c) => c.command);

  beforeEach(() => {
    registrations.length = 0;
    activate(context());
  });

  afterEach(async () => {
    await deactivate();
  });

  it('reads a manifest that contributes commands', () => {
    // Guard the guard: an empty list would make every check below vacuous.
    expect(contributed.length).toBeGreaterThan(0);
    expect(registrations.length).toBeGreaterThan(0);
  });

  it('registers every command the manifest contributes', () => {
    const unregistered = contributed.filter((id) => !registrations.includes(id));

    expect(unregistered).toEqual([]);
  });

  // The only way to start the AI token count over without reloading the window.
  it('contributes and registers the command that resets the AI token budget', () => {
    expect(contributed).toContain('sandforge.ai.resetTokenBudget');
    expect(registrations).toContain('sandforge.ai.resetTokenBudget');
  });

  it('registers each contributed command exactly once', () => {
    const repeated = contributed.filter(
      (id) => registrations.filter((registered) => registered === id).length !== 1,
    );

    expect(repeated).toEqual([]);
  });
});
