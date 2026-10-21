/**
 * Forge's panel path, stood up without the editor.
 *
 * Every run of Forge against an org went through the command line, which
 * builds what it runs by itself (`sandforge-clone`). The panel's path did not:
 * the handler, the journal it keeps under the extension's storage, the
 * history a run stopped part way is kept in, its resume and its removal from
 * there, Production Guard's questions. Removed from the panel's history, a run
 * killed while an insert call was under way left that call's records in the
 * target while the command line's removal took them, and nothing that ran
 * against an org could have said so. Run through this host between two
 * scratch orgs, the same removal also kept as changed since the run every
 * record a killed run wrote past its tenth second: the panel dated it by when
 * its part began.
 *
 * This host builds what the extension builds for Forge, each from its own
 * module and in the order `activate()` calls them: the background composition,
 * which makes Production Guard and the registry of background runs, before
 * the handlers are routed; then the Forge composition, which makes the
 * orchestrator, the executor's deps over the org registry's connections, the
 * run journal and the removal plans under the storage directory, and hands
 * them to the handlers. Both import the editor's API. It is stood in for at
 * the module loader by this host's (`hostVscode`), which is the editor's
 * surfaces alone: a modal's question is answered by the caller (`answer`), a
 * notification and the clipboard go to the log, and no folder is open, as in a
 * window with none — the templates are kept in the config store. Everything
 * else is the product's, and requests reach it as the panel sends them
 * (`panelHost.ts`).
 *
 * The process can be killed and started again over the same directories: the
 * config store is a file, the journals and plans are under `storagePath`. A
 * host started again is a window opened again, which lists a run its last
 * window left under way as interrupted.
 */

import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { createPanelHost } from './panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring } from './panelHost.js';
import type { PIIDetector } from '../src/core/precheck/PIIDetector.js';

/** A question the editor would put in a modal, as this host is asked it. */
export interface HostQuestion {
  /** The modal's title. */
  title: string;
  /** What it says under the title. */
  detail?: string;
  /** Its buttons, but for Cancel, which the editor adds. */
  buttons: string[];
}

/** The button the caller presses on a question, or nothing for Cancel. */
export type HostAnswer = (question: HostQuestion) => string | undefined;

/** What the host's `vscode` reaches: who answers, and where its notifications go. */
interface HostSurfaces {
  answer: HostAnswer;
  log: (line: string) => void;
}

/** The `{0}` of a message, as the editor's `l10n.t` fills them in an English window. */
function formatted(message: string, ...args: unknown[]): string {
  return message.replace(/\{(\d+)\}/g, (_match, index: string) =>
    String(args[Number(index)] ?? ''),
  );
}

/**
 * The editor's API as the compositions Forge needs read it, over `surfaces`:
 * `window.show*Message` — a modal asked of the caller, any other message
 * logged — `l10n.t`, the clipboard, and a workspace with no folder open.
 * Exported so it can be tested.
 */
export function hostVscode(surfaces: () => HostSurfaces) {
  const show =
    (kind: string) =>
    async (message: string, ...rest: unknown[]): Promise<string | undefined> => {
      const [first] = rest;
      const options =
        typeof first === 'object' && first !== null
          ? (first as { modal?: boolean; detail?: string })
          : undefined;
      const buttons = rest.filter((item): item is string => typeof item === 'string');
      const { answer, log } = surfaces();
      if (options?.modal) {
        const chosen = answer({
          title: message,
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
          buttons,
        });
        log(`  question: ${message} -> ${chosen ?? 'Cancel'}`);
        return chosen;
      }
      log(`  notification (${kind}): ${message}`);
      return undefined;
    };
  return {
    l10n: { t: formatted },
    window: {
      showWarningMessage: show('warning'),
      showInformationMessage: show('info'),
      showErrorMessage: show('error'),
    },
    env: {
      language: 'en',
      clipboard: {
        writeText: async (text: string): Promise<void> => surfaces().log(`  clipboard: ${text}`),
      },
    },
    workspace: {
      workspaceFolders: undefined,
      onDidChangeConfiguration: () => ({ dispose: (): void => undefined }),
    },
  };
}

/** Where the module loader finds this host's `vscode`: a key of the process's global object. */
const HOST_VSCODE = Symbol.for('sandforge.forgeHost.vscode');
/** The address the loader gives the module. */
const HOST_VSCODE_URL = 'sandforge-host:vscode';

/** The hooks of the module loader, as Node 22.15 and later take them (`module.registerHooks`). */
interface LoaderHooks {
  resolve: (
    specifier: string,
    context: unknown,
    next: (specifier: string, context: unknown) => unknown,
  ) => unknown;
  load: (
    url: string,
    context: unknown,
    next: (url: string, context: unknown) => unknown,
  ) => unknown;
}

/** Who the host's `vscode` asks now: the last host made in the process. */
let current: HostSurfaces | undefined;

/**
 * Stand the host's `vscode` in for the editor's, once a process, before any
 * module that imports it is loaded: `import 'vscode'` and `require('vscode')`
 * alike resolve to it.
 */
function installHostVscode(surfaces: HostSurfaces): void {
  current = surfaces;
  const global = globalThis as unknown as Record<symbol, unknown>;
  if (global[HOST_VSCODE]) return;
  const register = (nodeModule as unknown as { registerHooks?: (hooks: LoaderHooks) => unknown })
    .registerHooks;
  if (typeof register !== 'function') {
    throw new Error("Forge's host needs Node 22.15 or later: its module loader takes no hooks.");
  }
  global[HOST_VSCODE] = hostVscode(() => {
    if (!current) throw new Error('No Forge host is running.');
    return current;
  });
  register({
    resolve: (specifier, context, next) =>
      specifier === 'vscode'
        ? { url: HOST_VSCODE_URL, shortCircuit: true }
        : next(specifier, context),
    load: (url, context, next) =>
      url === HOST_VSCODE_URL
        ? {
            format: 'commonjs',
            source: "module.exports = globalThis[Symbol.for('sandforge.forgeHost.vscode')];",
            shortCircuit: true,
          }
        : next(url, context),
  });
}

/**
 * The answer that goes on: the first button, Execute, Rehearse or Restore
 * anyway — never the one that copies a command and cancels.
 */
export function goOn(question: HostQuestion): string | undefined {
  return question.buttons[0];
}

/** What the Forge host needs from whoever runs it. */
export interface ForgeHostOptions extends Omit<PanelHostOptions, 'compose'> {
  /**
   * The extension's own storage (its `globalStorageUri`), where the journals
   * of the runs and the plans of their removals are kept. Default:
   * `storage` under `storeDir`.
   */
  storagePath?: string;
  /** Who presses the button of each question a modal would put. Default {@link goOn}. */
  answer?: HostAnswer;
}

/** The host, Forge in it. */
export interface ForgeHost extends PanelHost {
  /** Where the journals of its runs and the plans of their removals are kept. */
  readonly storagePath: string;
}

/**
 * Stand up the host with Forge in it: the panel host, the background
 * composition handed to its handlers before they are routed, and the Forge
 * composition once they are, awaited until it has handed them its
 * orchestrator.
 */
export async function createForgeHost(options: ForgeHostOptions): Promise<ForgeHost> {
  const { log } = options;
  const storagePath = options.storagePath ?? join(options.storeDir, 'storage');
  installHostVscode({ log, answer: options.answer ?? goOn });
  const [{ createBackgroundComposition }, { initForgeComposition }] = await Promise.all([
    import('../src/composition/backgroundComposition.js'),
    import('../src/composition/forgeComposition.js'),
  ]);

  const built: { wiring?: PanelHostWiring & { piiDetector: PIIDetector } } = {};
  const host = createPanelHost({
    ...options,
    compose: (wiring) => {
      const infra = createBackgroundComposition({
        services: wiring.services,
        configStore: wiring.configStore,
        orgNameOf: (orgId) => wiring.orgManager.getOrg(orgId)?.alias,
      });
      wiring.handlers.setInfraServices(infra);
      wiring.handlers.setBackgroundRegistry(infra.backgroundRegistry);
      built.wiring = { ...wiring, piiDetector: infra.piiDetector };
    },
  });
  if (!built.wiring) throw new Error('The host built no handlers.');
  const { handlers, orgRegistry, orgManager, piiDetector } = built.wiring;

  // As the first view of a window starts it: the imports load, and the
  // orchestrator reaches the handlers through their late setter.
  await new Promise<void>((resolve, reject) => {
    const hand = handlers.setForgeOrchestrator.bind(handlers);
    handlers.setForgeOrchestrator = (orchestrator, services) => {
      hand(orchestrator, services);
      resolve();
    };
    void initForgeComposition({
      handlers,
      orgRegistry,
      orgManager,
      piiDetector,
      storagePath,
      log: (line) => {
        log(line);
        if (line.startsWith('Failed to init Forge module')) reject(new Error(line));
      },
    });
  });
  return Object.assign(host, { storagePath });
}
