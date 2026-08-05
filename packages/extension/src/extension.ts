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
import { PipelineMarketplace } from './modules/automation/PipelineMarketplace';
import { CacheManager } from './core/cache/CacheManager';
import { createServices } from './services.js';
import type { Services } from './services.js';
import { logger } from './logger.js';
import { createCoreComposition } from './composition/coreComposition';
import {
  createBackgroundComposition,
  wireBackgroundNotifications,
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

  // 4. Standalone services (Tier 3)
  const pipelineMarketplace = new PipelineMarketplace();
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
  });

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

  const sidebarProvider = new SidebarViewProvider(
    context.extensionUri,
    vscode.Uri.joinPath,
    vscode.commands.executeCommand,
    () => orgManager.getAllOrgs() as unknown as Record<string, unknown>[],
    (orgId: string) => {
      panelManager.postToActivePanel({
        type: 'org:selected',
        id: `org-sel-${Date.now()}`,
        timestamp: Date.now(),
        payload: { orgId },
      });
    },
  );
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    sidebarProvider,
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

  // 12. StatusBar — shows org count and active state
  const statusBar = new StatusBarProvider((alignment, priority) =>
    vscode.window.createStatusBarItem(alignment, priority),
  );
  const orgCount = orgManager.getAllOrgs().length;
  statusBar.setItem({
    id: 'sandforge.status',
    text: `$(flame) SandForge: ${orgCount} org${orgCount !== 1 ? 's' : ''}`,
    tooltip: 'SandForge — Click to open Monitor',
    command: 'sandforge.openMonitor',
    priority: 200,
  });

  // 13. Org changes -> stateSync + statusBar
  const unsubOrgChange = orgManager.onOrgChange(() => {
    const orgs = orgManager.getAllOrgs();
    stateSync.updateState({
      orgs: orgs as unknown as Record<string, unknown>[],
    });
    const count = orgs.length;
    statusBar.updateText(
      'sandforge.status',
      `$(flame) SandForge: ${count} org${count !== 1 ? 's' : ''}`,
    );
    // Push updated org list to sidebar webview
    sidebarProvider.postMessage({
      type: 'org:list:response',
      payload: { orgs: orgs as unknown as Record<string, unknown>[] },
    });
  });

  context.subscriptions.push(
    outputChannel,
    sidebarRegistration,
    statusBar,
    panelManager,
    { dispose: () => backgroundRegistry.dispose() },
    { dispose: unsubOrgChange },
    { dispose: () => orgManager.dispose() },
    { dispose: () => offlineManager.dispose() },
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
