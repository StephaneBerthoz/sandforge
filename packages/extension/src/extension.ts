import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { MessageBroker } from './bridge/MessageBroker';
import type { FixSuggestion } from './bridge/MessageBroker';
import { MessageRouter } from './bridge/MessageRouter';
import { WebviewStateSync } from './bridge/WebviewStateSync';
import { ExtensionHandlers } from './bridge/ExtensionHandlers';
import { StatusBarProvider } from './providers/StatusBarProvider';
import { WebviewPanelManager } from './providers/WebviewPanelManager';
import type { UriJoinPath } from './providers/WebviewPanelManager';
import { SidebarViewProvider } from './providers/SidebarViewProvider';
import { readConfiguredLanguage } from './providers/webviewHtml';
import { postGrappeEvent, readGrappeConfig } from './bridge/handlers/HandlerTypes';
import { PipelineMarketplace } from './modules/automation/PipelineMarketplace';
import { LiveOperationTracker } from './modules/monitor/LiveOperationTracker';
import { BackupRecordStore } from './modules/dataops/BackupRecordStore';
import { createServices } from './services.js';
import type { Services } from './services.js';
import { logger } from './logger.js';
import { createCoreComposition } from './composition/coreComposition';
import {
  createBackgroundComposition,
  startOfflineProbing,
  wireBackgroundNotifications,
  wireOfflineNotifications,
  wireOfflineReplay,
} from './composition/backgroundComposition';
import { initForgeComposition } from './composition/forgeComposition';
import { initAutopilotComposition } from './composition/autopilotComposition';
import {
  createAIReinit,
  initAIComposition,
  registerAIConfigListener,
  registerTokenBudgetReset,
  wireBudgetReporting,
} from './composition/aiComposition';
import { applyLateServices } from './composition/lateServices';
import { registerModuleCommands } from './composition/commandsComposition';
import { wireSandboxRefreshDetection } from './composition/sandboxRefreshComposition';
import { validateOrgsOnStartup } from './core/connection/startupValidation';
import { extractErrorMessage } from './core/common/extractErrorMessage.js';
import { knownErrorTexts } from './core/common/errorKnowledgeBase.js';
import { parseHttpsUrl } from './core/common/parseHttpsUrl.js';
import { formatPinoLine } from './adapters/telemetry/formatPinoLine.js';

let router: MessageRouter | undefined;
let broker: MessageBroker | undefined;
let servicesRef: Services | undefined;
let handlersRef: ExtensionHandlers | undefined;

/** Org fields the status bar label needs (structural subset of SalesforceOrg). */
export interface StatusBarOrg {
  id: string;
  alias: string;
  username: string;
  status: string;
}

/**
 * Build the status bar label + tooltip from the current orgs.
 *
 * Shows the selected org's alias when one is tracked (sidebar `sidebar:selectOrg`
 * → `org:selected` flow); otherwise falls back to the first connected org, and
 * finally to the bare org count. Exported for unit tests.
 *
 * @param orgs - All orgs known to the OrgManager.
 * @param selectedOrgId - The org currently selected in the sidebar, if any.
 */
export function buildStatusBarLabel(
  orgs: StatusBarOrg[],
  selectedOrgId: string | undefined,
): { text: string; tooltip: string } {
  const count = orgs.length;
  const countLabel = `${count} org${count !== 1 ? 's' : ''}`;
  const displayed =
    orgs.find((org) => org.id === selectedOrgId) ?? orgs.find((org) => org.status === 'connected');
  if (!displayed) {
    return {
      text: `$(flame) SandForge: ${countLabel}`,
      tooltip: 'SandForge — Click to open Monitor',
    };
  }
  return {
    text: `$(flame) SandForge: ${displayed.alias} (${countLabel})`,
    tooltip: `${displayed.alias} — ${displayed.username} (${displayed.status})`,
  };
}

/**
 * The line a fix suggestion is shown with, in the UI language.
 *
 * The table of known Salesforce error codes is written in English, and its
 * sentences reach here already rendered — so a French user read an English
 * paragraph in a French VS Code. The table is keyed on the error code, so the
 * code is what selects the sentence to translate, and `vscode.l10n.t` is keyed
 * on that sentence exactly as `bundle.l10n.json` holds it. A model answer is
 * already written in the UI language and is passed through untouched.
 *
 * Exported for unit tests.
 *
 * @param suggestion - The suggestion the broker decided on.
 */
export function localizedFixSuggestion(suggestion: FixSuggestion): string {
  if (suggestion.source !== 'knowledge-base' || !suggestion.code) return suggestion.text;
  const texts = knownErrorTexts(suggestion.code);
  if (!texts) return suggestion.text;
  return vscode.l10n.t(texts.suggestion ?? texts.explanation);
}

/**
 * Called when the extension is activated.
 *
 * Orchestrates the composition factories under `./composition/` (core,
 * background, forge, ai, commands) — each returns a typed deps object, this
 * function only wires them together. Handler dependencies are injected in two
 * phases (sync setters before `registerAll`, async setters after) — see the
 * late-injection contract in `./composition/lateServices.ts`.
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Output channel
  const outputChannel = vscode.window.createOutputChannel('SandForge');
  const startTs = Date.now();
  const log = (msg: string): void => {
    outputChannel.appendLine(`[+${Date.now() - startTs}ms] ${msg}`);
  };
  // Wire the singleton logger (used across core modules) to the same channel —
  // without this its warn/error lines are silently dropped.
  logger.init(outputChannel);
  log('SandForge is now active.');

  // 1b. Composition root — wires core adapters (telemetry, storage, fs)
  // and exposes orchestrator factories. Also kicks off SecretStorage migration.
  // Pino (telemetry logger) is routed to the OutputChannel instead of stdout,
  // each JSON record rewritten in the channel's `[time] [LEVEL] message` form.
  const services = createServices(context, {
    pinoDestination: {
      write: (chunk: string): void => {
        outputChannel.appendLine(formatPinoLine(chunk));
      },
    },
  });
  servicesRef = services;
  log('Composition root wired.');

  // 2. Core services (config, secrets, orgs, auth, onboarding)
  const {
    configStore,
    secretVault,
    orgManager,
    orgRegistry,
    authProvider,
    sfdxBridge,
    onboardingService,
  } = createCoreComposition({ context, services });
  log('ConfigStore initialized.');

  // 3. Infrastructure services + background operation registry
  const { performanceTracker, productionGuard, offlineManager, piiDetector, backgroundRegistry } =
    createBackgroundComposition({ services, configStore });
  // Enable connectivity probing so the offline queue can drain on reconnect.
  // The probe only ticks while an operation is queued or the network is down.
  // Stopped by offlineManager.dispose().
  startOfflineProbing(offlineManager);

  // 4. Standalone services
  const pipelineMarketplace = new PipelineMarketplace();
  const liveOperationTracker = new LiveOperationTracker();
  const fsReader = {
    readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
    statSize: async (filePath: string) => (await fs.stat(filePath)).size,
  };

  // 5. MessageBroker + MessageRouter + WebviewStateSync
  // Telemetry adapter is injected so envelope validation failures
  // emit bridge breadcrumbs + Pino warn entries for observability.
  broker = new MessageBroker({
    telemetry: services.telemetry,
    // A fix suggestion for a failed operation is shown here, once: posted to
    // the webviews it was repeated in every open panel.
    showFixSuggestion: (suggestion) => {
      const line = localizedFixSuggestion(suggestion);
      void vscode.window.showInformationMessage(
        suggestion.source === 'model'
          ? vscode.l10n.t('SandForge: fix suggested by the AI model — {0}', line)
          : vscode.l10n.t('SandForge: suggested fix for a known Salesforce error — {0}', line),
      );
    },
  });
  router = new MessageRouter(broker);
  const stateSync = new WebviewStateSync(broker);
  log('MessageBroker + Router + StateSync wired.');

  // 6. ExtensionHandlers + synchronous late services. MUST all land before
  // registerAll: setBackgroundRegistry creates the ExecutionHandler that
  // registerAll conditionally routes (see composition/lateServices.ts).
  const handlers = new ExtensionHandlers({
    log,
    broker,
    stateSync,
    orgManager,
    orgRegistry,
    configStore,
    secretVault,
    authProvider,
    sfdxBridge,
    services,
    // The workbench:reload handler needs the commands API.
    executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
    // Lazy i18n loading: packaged webview locale JSONs (copied from the
    // webview build output) served by the I18nHandler.
    localesDir: vscode.Uri.joinPath(context.extensionUri, 'webview-dist', 'locales').fsPath,
  });
  // Backup record payloads go to files under the extension's own storage
  // directory instead of globalState, which VSCode re-serializes in full on
  // every write — a single backup could put megabytes behind every unrelated
  // settings save and behind activation itself.
  const backupRecordStore = new BackupRecordStore({
    storagePath: context.globalStorageUri.fsPath,
    readFile: (p) => fs.readFile(p, 'utf-8'),
    writeFile: (p, content) => fs.writeFile(p, content, 'utf-8'),
    mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
    rm: (p) => fs.rm(p, { force: true }),
  });

  applyLateServices(handlers, {
    onboardingService,
    infraServices: {
      performanceTracker,
      productionGuard,
      offlineManager,
      piiDetector,
      backgroundRegistry,
    },
    backgroundRegistry,
    migrationFileReader: fsReader,
    pipelineMarketplace,
    liveOperationTracker,
    backupRecordStore,
  });
  // Replays operations queued on transport failure once connectivity returns
  // (the queue drains on the offline→online probe transition).
  wireOfflineReplay(offlineManager, handlers);
  // Native notifications for offline-queue lifecycle (queued / restarted /
  // dropped) — the webview has no offline channel, this is the only surface.
  wireOfflineNotifications(offlineManager);
  // A refreshed sandbox is a new org behind the same registered one. Every
  // validated connection says which org it reached, the startup check of
  // each org included, so this is wired before that check runs (step 10b).
  context.subscriptions.push(wireSandboxRefreshDetection(handlers.sandboxRefreshes, orgManager));

  // Start the sync schedule tick loop (wires SyncScheduleHandler.onExecute
  // to SyncOpsHandler.executeScheduled; idempotent, stops in deactivate()).
  handlersRef = handlers;
  handlers.startSyncScheduler();

  // 7. Async compositions — dynamic imports stay off the activation hot path,
  // so these injections resolve AFTER registerAll (handlers guard with
  // NOT_INITIALIZED / AI_NOT_CONFIGURED until then — contract documented in
  // composition/lateServices.ts).
  initForgeComposition({ handlers, orgRegistry, orgManager, configStore, piiDetector, log });
  // The autopilot orchestrator's grappe lifecycle events go straight to the
  // webview (they correlate to no request), so they carry their own id source
  // rather than a handler's response builder. Captured in a const because the
  // closure outlives this statement's narrowing of the module-level `broker`.
  const eventBroker = broker;
  let autopilotEventSeq = 0;
  void initAutopilotComposition({
    handlers,
    log,
    grappeConfig: readGrappeConfig(services),
    onGrappeEvent: (event) =>
      postGrappeEvent(
        { broker: eventBroker, nextId: () => `autopilot-grappe-${++autopilotEventSeq}` },
        event,
      ),
  });
  const runAI = (): Promise<void> =>
    initAIComposition({
      services,
      secretVault,
      handlers,
      broker,
      log,
      disposables: context.subscriptions,
    });
  wireBudgetReporting(services, broker);
  // A saved key must reach the adapter even when sandforge.ai.enabled was
  // already true and writing it raises no configuration event.
  services.reinitAI = createAIReinit({ services, run: runAI, log });
  runAI().catch((err) => log(`Failed to init AI: ${String(err)}`));
  context.subscriptions.push(registerAIConfigListener({ services, run: runAI, log }));
  context.subscriptions.push(registerTokenBudgetReset({ services, log }));

  // 8. Register all message routes
  handlers.registerAll(router);

  // 9. PanelManager (creates full-editor webview panels for modules)
  const panelManager = new WebviewPanelManager(
    broker,
    (viewType, title, column, options) =>
      vscode.window.createWebviewPanel(viewType, title, column, {
        enableScripts: options.enableScripts,
        retainContextWhenHidden: options.retainContextWhenHidden,
        // The manager narrows the roots to webview-dist; it builds them with
        // vscode.Uri.joinPath, passed just below.
        localResourceRoots: options.localResourceRoots as readonly vscode.Uri[] | undefined,
      }),
    context.extensionUri,
    vscode.Uri.joinPath as UriJoinPath,
    // Same settings closure the sidebar gets (step 10) — the panel shell needs
    // it for `<html lang>` on first paint.
    () => readConfiguredLanguage(configStore.getByCategory('settings')),
    // Editor display language, for the `auto` language setting.
    () => vscode.env.language,
  );

  // 9b. Background-operation lifecycle -> stateSync + native notifications
  wireBackgroundNotifications({ backgroundRegistry, stateSync, panelManager });

  // 10. SidebarViewProvider (WebView-based sidebar navigation)
  // Pre-load orgs so they're available when sidebar mounts
  orgRegistry.loadAll();

  // Org selection tracked extension-side (sidebar `sidebar:selectOrg` event,
  // same callback that posts `org:selected` to the active panel) so the status
  // bar can show the selected org's alias. `refreshStatusBar` is declared at
  // step 12 — the callback only fires after activation completes.
  let selectedOrgId: string | undefined;
  const selectOrg = (orgId: string): void => {
    selectedOrgId = orgId;
    refreshStatusBar();
    // Keep the shared state snapshot in sync so panels opened LATER hydrate
    // with the current selection instead of falling back to the first org.
    stateSync.updateState({ selectedOrgId: orgId });
    // Broadcast is intended: every PanelApp is an isolated webview document
    // with its own zustand store — without it, other panels keep the old org.
    panelManager.postToAllPanels({
      type: 'org:selected',
      id: `org-sel-${Date.now()}`,
      timestamp: Date.now(),
      payload: { orgId },
    });
  };

  // Panel org pickers post `org:select` through the broker — the OrgHandler
  // replays the selection through this same closure (late injection: the
  // handlers were constructed at step 6, before selectOrg exists).
  handlers.setOrgSelectionCallback(selectOrg);

  const sidebarProvider = new SidebarViewProvider(
    context.extensionUri,
    vscode.Uri.joinPath,
    vscode.commands.executeCommand,
    () => orgManager.getAllOrgs() as unknown as Record<string, unknown>[],
    selectOrg,
    // Outbound-only broker registration (step 5) so operation lifecycle
    // broadcasts reach the sidebar's Running / Last operation blocks.
    broker,
    // Lets the sidebar sync its UI language on mount (sidebar:requestSettings).
    () => configStore.getByCategory('settings'),
    // Lets a re-resolved sidebar restore the current selection.
    () => selectedOrgId,
    // `<html lang>` on the sidebar shell — same closure the panels get.
    () => readConfiguredLanguage(configStore.getByCategory('settings')),
    () => vscode.env.language,
  );
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    sidebarProvider,
  );

  // 10b. Proactive org validation — refresh expired tokens at every launch so
  // the first operation does not hit an auth wall mid-run. Background-only,
  // per-org isolated, gated by sandforge.orgs.validateOnStartup.
  if (services.getSandforgeSetting('orgs.validateOnStartup', true)) {
    void validateOrgsOnStartup({ orgManager, orgRegistry, log }).catch((err: unknown) => {
      log(`[startup] Org validation crashed: ${extractErrorMessage(err)}`);
    });
  }

  // 10c. Adopt the sf CLI's default org when nothing is selected yet — the
  // CLI already knows which org this workspace targets ("Default Org" in
  // sf org list), so SandForge shouldn't start on a blank or stale pick.
  // Runs in the background; never blocks activation.
  if (!selectedOrgId) {
    void sfdxBridge.getDefaultOrgUsername().then((defaultName) => {
      if (!defaultName || selectedOrgId) return;
      const match = orgManager
        .getAllOrgs()
        .find((o) => o.alias === defaultName || o.username === defaultName);
      if (match) {
        log(`[startup] Adopting CLI default org: ${match.alias}`);
        selectOrg(match.id);
      }
    });
  }

  // Opens an org's instance URL in the system browser. The launcher dropdown
  // passes the org id (the sidebar relays `sidebar:openOrgInBrowser`); from
  // the Command Palette no id comes in, so the user picks the org here.
  const openOrgInBrowserCommand = vscode.commands.registerCommand(
    'sandforge.openOrgInBrowser',
    async (orgId?: string) => {
      let org = typeof orgId === 'string' ? orgManager.getOrg(orgId) : undefined;
      if (!org) {
        const orgs = orgManager.getAllOrgs();
        if (orgs.length === 0) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              'SandForge: no org is registered yet — connect one from the Organizations page first.',
            ),
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(
          orgs.map((candidate) => ({
            label: candidate.alias,
            description: candidate.username,
            orgId: candidate.id,
          })),
          { placeHolder: vscode.l10n.t('Select the org to open in the browser') },
        );
        org = picked ? orgManager.getOrg(picked.orgId) : undefined;
        if (!org) {
          return;
        }
      }
      // instanceUrl comes from stored org state, which is hand-editable and
      // also populated by an sfdx import, and `Uri.parse` accepts `javascript:`
      // and `file:` without throwing. The HTTPS gate every path from org state
      // to the browser shares refuses them (see parseHttpsUrl).
      const parsed = parseHttpsUrl(org.instanceUrl);
      if (!parsed.ok && parsed.reason === 'invalid') {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'SandForge: cannot open "{0}" — invalid instance URL: {1}',
            org.alias,
            org.instanceUrl,
          ),
        );
        return;
      }
      if (!parsed.ok) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'SandForge: refusing to open "{0}" — instance URL must use HTTPS, got "{1}".',
            org.alias,
            parsed.protocol,
          ),
        );
        return;
      }
      // Open the URL that passed the gate, parsed strictly — not the raw
      // stored string, which `Uri.parse` would read leniently again.
      void vscode.env.openExternal(vscode.Uri.parse(parsed.url.toString(), true));
    },
  );

  // 11. Module commands (sandforge.open*) + the cheers easter egg
  registerModuleCommands({
    context,
    panelManager,
    orgRegistry,
    orgManager,
    stateSync,
    onboardingService,
  });

  // 12. StatusBar — org count + selected (or first connected) org alias
  const statusBar = new StatusBarProvider((alignment, priority) =>
    vscode.window.createStatusBarItem(alignment, priority),
  );
  const refreshStatusBar = (): void => {
    const label = buildStatusBarLabel(orgManager.getAllOrgs(), selectedOrgId);
    statusBar.setItem({
      id: 'sandforge.status',
      text: label.text,
      tooltip: label.tooltip,
      command: 'sandforge.openMonitor',
      priority: 200,
    });
  };
  refreshStatusBar();

  // 13. Org changes -> stateSync + statusBar
  const unsubOrgChange = orgManager.onOrgChange(() => {
    const orgs = orgManager.getAllOrgs();
    stateSync.updateState({
      orgs: orgs as unknown as Record<string, unknown>[],
    });
    // Recomputes alias (selection may have been removed/renamed) and tooltip
    // (connection status changes surface via statusChanged events).
    refreshStatusBar();
    // Push updated org list to an open sidebar, with the current selection, so
    // a sidebar that has none yet picks it up from the same message.
    sidebarProvider.postMessage({
      type: 'org:list:response',
      payload: { orgs: orgs as unknown as Record<string, unknown>[], selectedOrgId },
    });
  });

  context.subscriptions.push(
    outputChannel,
    sidebarRegistration,
    // Releases the provider's internal onDidReceiveMessage subscription.
    sidebarProvider,
    openOrgInBrowserCommand,
    statusBar,
    panelManager,
    stateSync,
    // Aborts operations still running, so a sync or seed stops writing when
    // the extension goes away.
    { dispose: () => backgroundRegistry.dispose() },
    { dispose: unsubOrgChange },
    { dispose: () => orgManager.dispose() },
    { dispose: () => offlineManager.dispose() },
    { dispose: () => liveOperationTracker.dispose() },
    { dispose: () => performanceTracker.dispose() },
  );
}

/**
 * Called when the extension is deactivated.
 * Cleans up router, broker, memoised AI adapters, and flushes telemetry.
 */
export async function deactivate(): Promise<void> {
  router?.dispose();
  broker?.dispose();
  router = undefined;
  broker = undefined;
  // Drop memoised AI adapters (they hold SDK clients and in-flight requests).
  servicesRef?.aiClient.invalidate();
  // Flush pending telemetry events before the host tears us down.
  await servicesRef?.telemetry.flush();
  servicesRef = undefined;
  handlersRef?.stopSyncScheduler();
  handlersRef = undefined;
  // Infrastructure services with dispose methods are cleaned up via context.subscriptions
}
