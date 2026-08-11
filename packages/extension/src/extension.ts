import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { MessageBroker } from './bridge/MessageBroker';
import { MessageRouter } from './bridge/MessageRouter';
import { WebviewStateSync } from './bridge/WebviewStateSync';
import { ExtensionHandlers } from './bridge/ExtensionHandlers';
import { StatusBarProvider } from './providers/StatusBarProvider';
import { WebviewPanelManager } from './providers/WebviewPanelManager';
import type { UriJoinPath } from './providers/WebviewPanelManager';
import { SidebarViewProvider } from './providers/SidebarViewProvider';
import { OrgsTreeProvider } from './providers/OrgsTreeProvider';
import type { OrgTreeItem } from './providers/OrgsTreeProvider';
import { PipelineMarketplace } from './modules/automation/PipelineMarketplace';
import { LiveOperationTracker } from './modules/monitor/LiveOperationTracker';
import { MaskingTemplateService } from './modules/dataops/templates/MaskingTemplateService';
import { CacheManager } from './core/cache/CacheManager';
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
import { initAIComposition, registerAIConfigListener } from './composition/aiComposition';
import { applyLateServices } from './composition/lateServices';
import { registerModuleCommands } from './composition/commandsComposition';

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

  // 1b. Composition root — wires core adapters (telemetry, storage, salesforce, fs)
  // and exposes orchestrator factories. Also kicks off SecretStorage migration.
  // Pino (telemetry logger) is routed to the OutputChannel instead of stdout.
  const services = createServices(context, {
    pinoDestination: {
      write: (chunk: string): void => {
        outputChannel.appendLine(chunk.replace(/\n$/, ''));
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
    hintTracker,
  } = createCoreComposition({ context, services });
  log('ConfigStore initialized.');

  // 3. Infrastructure services (Tier 1) + background operation registry
  const { performanceTracker, productionGuard, offlineManager, piiDetector, backgroundRegistry } =
    createBackgroundComposition({ services, configStore });
  // Start connectivity probing so connectivity:status reflects reality and the
  // offline queue can drain on reconnect. Stopped by offlineManager.dispose().
  startOfflineProbing(offlineManager);

  // 4. Standalone services (Tier 3)
  const pipelineMarketplace = new PipelineMarketplace();
  const liveOperationTracker = new LiveOperationTracker();
  const maskingTemplateService = new MaskingTemplateService();
  const fsReader = { readFile: (filePath: string) => fs.readFile(filePath, 'utf-8') };

  // 5. MessageBroker + MessageRouter + WebviewStateSync
  // Telemetry adapter is injected so Plan 01-04 envelope validation failures
  // emit bridge breadcrumbs + Pino warn entries for observability.
  broker = new MessageBroker({ telemetry: services.telemetry });
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
    // Plan 01-04-11: workbench:reload handler needs the commands API.
    executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
  });
  applyLateServices(handlers, {
    onboardingService,
    hintTracker,
    infraServices: { performanceTracker, productionGuard, offlineManager, piiDetector },
    backgroundRegistry,
    migrationFileReader: fsReader,
    pipelineMarketplace,
    liveOperationTracker,
    maskingTemplateService,
  });
  // Replays operations queued on transport failure once connectivity returns
  // (the queue drains on the offline→online probe transition).
  wireOfflineReplay(offlineManager, handlers);
  // Native notifications for offline-queue lifecycle (queued / restarted /
  // dropped) — the webview has no offline channel, this is the only surface.
  wireOfflineNotifications(offlineManager);

  // Start the sync schedule tick loop (wires SyncScheduleHandler.onExecute
  // to SyncOpsHandler.executeScheduled; idempotent, stops in deactivate()).
  handlersRef = handlers;
  handlers.startSyncScheduler();

  // 7. Async compositions — dynamic imports stay off the activation hot path,
  // so these injections resolve AFTER registerAll (handlers guard with
  // NOT_INITIALIZED / AI_NOT_CONFIGURED until then — contract documented in
  // composition/lateServices.ts).
  initForgeComposition({ handlers, orgRegistry, orgManager, configStore, piiDetector, log });
  void initAutopilotComposition({ handlers, log });
  const runAI = (): Promise<void> =>
    initAIComposition({ services, secretVault, handlers, broker, orgRegistry, orgManager, log });
  runAI().catch((err) => log(`Failed to init AI: ${String(err)}`));
  context.subscriptions.push(registerAIConfigListener({ services, run: runAI, log }));

  // 8. Register all message routes
  handlers.registerAll(router);

  // 9. PanelManager (creates full-editor webview panels for modules)
  const panelManager = new WebviewPanelManager(
    broker,
    (viewType, title, column, options) =>
      vscode.window.createWebviewPanel(viewType, title, column, {
        enableScripts: options.enableScripts,
        retainContextWhenHidden: options.retainContextWhenHidden,
        localResourceRoots: [context.extensionUri],
      }),
    context.extensionUri,
    vscode.Uri.joinPath as UriJoinPath,
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

  const sidebarProvider = new SidebarViewProvider(
    context.extensionUri,
    vscode.Uri.joinPath,
    vscode.commands.executeCommand,
    () => orgManager.getAllOrgs() as unknown as Record<string, unknown>[],
    (orgId: string) => {
      selectedOrgId = orgId;
      refreshStatusBar();
      panelManager.postToActivePanel({
        type: 'org:selected',
        id: `org-sel-${Date.now()}`,
        timestamp: Date.now(),
        payload: { orgId },
      });
    },
    // Outbound-only broker registration (step 5) so operation lifecycle
    // broadcasts reach the sidebar's Running / Last operation blocks.
    broker,
  );
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    sidebarProvider,
  );

  // 10b. OrgsTreeProvider — native TreeView of registered orgs in the same
  // view container. Registered after step 10's orgRegistry.loadAll() so the
  // first getChildren() already sees the persisted orgs.
  const orgsTreeProvider = new OrgsTreeProvider(orgManager);
  const orgsTreeRegistration = vscode.window.registerTreeDataProvider(
    OrgsTreeProvider.viewType,
    orgsTreeProvider,
  );
  const orgsTreeCommands = [
    vscode.commands.registerCommand('sandforge.orgsView.refresh', () => {
      // Re-pull persisted orgs into the OrgManager (its change events refresh
      // the tree) and poke the provider for good measure.
      orgRegistry.loadAll();
      orgsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('sandforge.openOrgInBrowser', (item?: OrgTreeItem) => {
      const org = item?.org;
      if (!org) {
        void vscode.window.showInformationMessage(
          'SandForge: pick an org in the Organizations view first.',
        );
        return;
      }
      // Uri.parse throws on a malformed instanceUrl (hand-edited storage,
      // partial sfdx import) — fail with a clean message instead of an
      // unhandled command error.
      try {
        void vscode.env.openExternal(vscode.Uri.parse(org.instanceUrl));
      } catch {
        void vscode.window.showErrorMessage(
          `SandForge: cannot open "${org.alias}" — invalid instance URL: ${org.instanceUrl}`,
        );
      }
    }),
  ];

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
    // Push updated org list to sidebar webview
    sidebarProvider.postMessage({
      type: 'org:list:response',
      payload: { orgs: orgs as unknown as Record<string, unknown>[] },
    });
  });

  context.subscriptions.push(
    outputChannel,
    sidebarRegistration,
    // Releases the provider's internal onDidReceiveMessage subscription.
    sidebarProvider,
    // TreeView registration + provider (releases its OrgManager subscription).
    orgsTreeRegistration,
    orgsTreeProvider,
    ...orgsTreeCommands,
    statusBar,
    panelManager,
    { dispose: () => backgroundRegistry.dispose() },
    { dispose: unsubOrgChange },
    { dispose: () => orgManager.dispose() },
    { dispose: () => offlineManager.dispose() },
    { dispose: () => liveOperationTracker.dispose() },
    { dispose: () => performanceTracker.dispose() },
    // Dispose the CacheManager singleton (clears its purge interval) if it was
    // ever instantiated — resetInstance() is a no-op otherwise.
    { dispose: () => CacheManager.resetInstance() },
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
  // Drop memoised AI adapters (they hold SDK clients + budget state).
  servicesRef?.aiClient.invalidate();
  // Flush pending telemetry events before the host tears us down.
  await servicesRef?.telemetry.flush();
  servicesRef = undefined;
  handlersRef?.stopSyncScheduler();
  handlersRef = undefined;
  // Infrastructure services with dispose methods are cleaned up via context.subscriptions
}
