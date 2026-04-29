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
import { ConfigStore } from './core/storage/ConfigStore';
import { MementoConfigStoreBackend } from './core/storage/MementoConfigStoreBackend';
import { SecretVault } from './core/storage/SecretVault';
import { OrgManager } from './core/connection/OrgManager';
import { OrgRegistry } from './core/connection/OrgRegistry';
import { AuthProvider } from './core/connection/AuthProvider';
import { SfdxBridge } from './core/connection/SfdxBridge';
import { OnboardingService } from './core/onboarding/OnboardingService';
import { HintTracker } from './core/onboarding/HintTracker';
import { OfflineManager } from './core/connection/OfflineManager';
import { PerformanceTracker } from './core/engine/PerformanceTracker';
import { BackgroundOperationRegistry } from './core/engine/BackgroundOperationRegistry';
import { PIIDetector } from './core/precheck/PIIDetector';
import { ProductionGuard } from './core/precheck/ProductionGuard';
import { PipelineMarketplace } from './modules/automation/PipelineMarketplace';
import { AI_CONFIG, AI_PROVIDER } from '@sandforge/shared';
import { createServices } from './services.js';

let router: MessageRouter | undefined;
let broker: MessageBroker | undefined;

/**
 * Called when the extension is activated.
 * Wires up all services: config, secrets, orgs, auth, bridge,
 * tree views (launcher + connected orgs), panel manager, and commands.
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Output channel
  const outputChannel = vscode.window.createOutputChannel('SandForge');
  const log = (msg: string): void => outputChannel.appendLine(msg);
  log('SandForge is now active.');

  // 1b. Composition root — wires core adapters (telemetry, storage, salesforce, fs)
  // and exposes orchestrator factories. Also kicks off SecretStorage migration.
  const services = createServices(context);
  log('Composition root wired.');

  // 2. ConfigStore (backed by VSCode globalState)
  const configBackend = new MementoConfigStoreBackend(context.globalState);
  const configStore = new ConfigStore(configBackend);
  configStore.initialize();

  // 3. SecretVault (wrapping VSCode SecretStorage)
  const secretVault = new SecretVault({
    get: (key: string) => Promise.resolve(context.secrets.get(key)),
    store: (key: string, value: string) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key: string) => Promise.resolve(context.secrets.delete(key)),
  });

  // 4. OrgManager + OrgRegistry
  const orgManager = new OrgManager();
  const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);

  // 5. AuthProvider + SfdxBridge
  const sfdxBridge = new SfdxBridge();
  const authProvider = new AuthProvider();
  authProvider.setSfdxBridge(sfdxBridge);

  // 5b. Onboarding + HintTracker
  const onboardingService = new OnboardingService(context.globalState);
  const hintTracker = new HintTracker(context.globalState);

  // 5c. Infrastructure services (Tier 1)
  const performanceTracker = new PerformanceTracker();
  const productionGuard = new ProductionGuard();
  const offlineManager = new OfflineManager(configStore);
  const piiDetector = new PIIDetector();

  // 5d. Background operation registry (Tier 1)
  const backgroundRegistry = new BackgroundOperationRegistry();

  // 5d. Standalone services (Tier 3)
  const pipelineMarketplace = new PipelineMarketplace();
  const fsReader = { readFile: (filePath: string) => fs.readFile(filePath, 'utf-8') };

  // 6. MessageBroker + MessageRouter + WebviewStateSync
  // Telemetry adapter is injected so Plan 01-04 envelope validation failures
  // emit bridge breadcrumbs + Pino warn entries for observability.
  broker = new MessageBroker({ telemetry: services.telemetry });
  router = new MessageRouter(broker);
  const stateSync = new WebviewStateSync(broker);

  // 7. ExtensionHandlers -- register all message routes
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
  handlers.setOnboardingServices(onboardingService, hintTracker);

  // 7b. Inject infrastructure services (Tier 1)
  handlers.setInfraServices({
    performanceTracker,
    productionGuard,
    offlineManager,
    piiDetector,
  });

  // 7b-bis. Inject BackgroundOperationRegistry into handlers
  handlers.setBackgroundRegistry(backgroundRegistry);

  // 7c. Inject standalone services (Tier 3)
  handlers.setMigrationServices(fsReader);
  handlers.setPipelineMarketplace(pipelineMarketplace);

  // 7c-bis. Wire up Forge orchestrator (Tier 5)
  Promise.all([
    import('./modules/forge/GraphDiscoveryService.js'),
    import('./modules/forge/ForgeExecutor.js'),
    import('./modules/forge/ForgeOrchestrator.js'),
    import('./modules/forge/ForgePlanGenerator.js'),
    import('./modules/forge/ForgeAnonymizer.js'),
    import('./modules/forge/ForgeComplianceService.js'),
    import('./modules/forge/ForgeMetadataDiff.js'),
    import('./modules/forge/ForgeBatchStrategy.js'),
    import('./modules/forge/ForgeTemplateStore.js'),
    import('./modules/forge/ForgeHistoryStore.js'),
    import('./core/connection/ConnectionHelper.js'),
  ]).then(([
    { GraphDiscoveryService },
    { ForgeExecutor },
    { ForgeOrchestrator },
    { ForgePlanGenerator },
    { ForgeAnonymizer },
    { ForgeComplianceService },
    { ForgeMetadataDiff },
    { ForgeBatchStrategy: ForgeBatchStrategyService },
    { ForgeTemplateStore },
    { ForgeHistoryStore },
    { getJsforceConnection },
  ]) => {
    const discoveryService = new GraphDiscoveryService({
      describeObject: async (orgId, objectApiName) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const meta = await conn.describe(objectApiName);
        return {
          name: meta.name,
          fields: meta.fields.map((f) => ({
            name: f.name,
            type: f.type,
            referenceTo: f.referenceTo ?? [],
            relationshipName: f.relationshipName ?? null,
            isMasterDetail: f.cascadeDelete === true,
          })),
          childRelationships: (meta.childRelationships ?? []).map((cr) => ({
            childSObject: cr.childSObject,
            field: cr.field,
            relationshipName: cr.relationshipName ?? cr.field,
            isCascadeDelete: cr.cascadeDelete === true,
          })),
        };
      },
      queryCount: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const result = await conn.query<{ expr0: number }>(soql);
        return result.totalSize;
      },
      detectPII: (fields) => {
        const result = piiDetector.detectPII(
          'unknown',
          fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type })),
        );
        return result.piiFields.map((p) => p.fieldApiName);
      },
      describeGlobal: async (orgId) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const result = await conn.describeGlobal();
        return result.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
      },
    });

    const batchStrategyService = new ForgeBatchStrategyService();
    const anonymizer = new ForgeAnonymizer();

    const executor = new ForgeExecutor({
      queryRecords: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const result = await conn.query<Record<string, unknown>>(soql);
        return result.records;
      },
      insertRecords: async (orgId, objectName, records) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const results = await conn.sobject(objectName).create(records);
        const arr = Array.isArray(results) ? results : [results];
        return arr.map((r) => ({
          id: r.id ?? '',
          success: r.success,
          errors: r.errors?.map((e: { message: string }) => e.message) ?? [],
        }));
      },
      updateRecords: async (orgId, objectName, records) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const results = await conn
          .sobject(objectName)
          .update(records as unknown as { Id: string }[]);
        const arr = Array.isArray(results) ? results : [results];
        return arr.map((r, i) => ({
          id: r.id ?? (records[i]['Id'] as string) ?? '',
          success: r.success,
          errors: r.errors?.map((e: { message: string }) => e.message) ?? [],
        }));
      },
      describeFields: async (orgId, objectName) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const meta = await conn.describe(objectName);
        return meta.fields.map((f) => ({
          name: f.name,
          queryable: true,
          createable: f.createable ?? false,
          isReference: f.type === 'reference',
          referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
          nillable: f.nillable ?? true,
          picklistValues: (f.picklistValues ?? [])
            .filter((p) => p?.active !== false && typeof p?.value === 'string')
            .map((p) => p.value as string),
        }));
      },
      isObjectCreatable: async (orgId, objectName) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const meta = await conn.describe(objectName);
        // Default to true when jsforce omits the flag — only opt out when
        // the org explicitly says false (read-only system entities).
        return meta.createable !== false;
      },
      batchStrategy: batchStrategyService,
      anonymize: (records, objectApiName) => {
        return anonymizer.anonymizeRecords(records, [], anonymizer.getDefaults(), objectApiName);
      },
    });

    const planGenerator = new ForgePlanGenerator();
    const complianceService = new ForgeComplianceService();

    const metadataDiff = new ForgeMetadataDiff({
      describeObject: async (orgId, objectApiName) => {
        const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
        const meta = await conn.describe(objectApiName);
        return {
          fields: meta.fields.map((f) => ({
            name: f.name,
            type: f.type,
            createable: f.createable ?? false,
          })),
        };
      },
    });

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const templateStore = new ForgeTemplateStore({
      workspacePath,
      readFile: (path) => fs.readFile(path, 'utf-8'),
      writeFile: (path, content) => fs.writeFile(path, content, 'utf-8'),
      mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
    });

    const historyStore = new ForgeHistoryStore({
      get: (key) => configStore.get(key),
      update: (key, value) => Promise.resolve(configStore.set(key, value)),
    });

    const forgeOrchestrator = new ForgeOrchestrator({ discoveryService, executor, planGenerator });

    handlers.setForgeOrchestrator(forgeOrchestrator, {
      planGenerator,
      complianceService,
      metadataDiff,
      templateStore,
      historyStore,
    });
    log('Forge v2 module initialized.');
  }).catch((err) => log(`Failed to init Forge module: ${String(err)}`));

  // 7d. Wire up AI assistant if API key is configured
  const initAI = async (): Promise<void> => {
    const apiKey = await secretVault.getSecret('ai-api-key');
    if (!apiKey) return;

    const { AIAssistant } = await import('./modules/ai/AIAssistant.js');

    const aiCallFn: import('./modules/ai/AIAssistant').AICallFn = async (messages, aiConfig) => {
      const start = Date.now();
      const baseUrl = aiConfig.baseUrl ?? AI_CONFIG.BASE_URL;
      if (!baseUrl.startsWith('https://')) {
        throw new Error('AI API requires HTTPS connection. Refusing to send API key over insecure transport.');
      }
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': aiConfig.apiKey,
          'anthropic-version': AI_CONFIG.API_VERSION,
        },
        body: JSON.stringify({
          model: aiConfig.model,
          max_tokens: aiConfig.maxTokens,
          temperature: aiConfig.temperature,
          messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
          system: messages.find(m => m.role === 'system')?.content,
        }),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`AI API request failed (${response.status}): ${errorBody}`);
      }
      const data = await response.json() as { content: Array<{ text: string }>; usage: { output_tokens: number }; model: string };
      return {
        content: data.content[0]?.text ?? '',
        tokenCount: data.usage?.output_tokens ?? 0,
        model: data.model ?? aiConfig.model,
        durationMs: Date.now() - start,
      };
    };

    const aiAssistant = new AIAssistant(aiCallFn, {
      provider: AI_PROVIDER,
      model: AI_CONFIG.MODEL,
      apiKey,
      maxTokens: AI_CONFIG.MAX_TOKENS,
      temperature: AI_CONFIG.TEMPERATURE,
    });
    handlers.setAIAssistant(aiAssistant);
    log('AI Assistant initialized with stored API key.');

    // Wire up AI modules (Tier 2) using the same provider function
    const aiProvider = async (prompt: string): Promise<string> => {
      const result = await aiCallFn(
        [{ role: 'user', content: prompt }],
        { provider: AI_PROVIDER, model: AI_CONFIG.MODEL, apiKey, maxTokens: AI_CONFIG.MAX_TOKENS, temperature: AI_CONFIG.TEMPERATURE },
      );
      return result.content;
    };

    const [
      { NL2SOQL },
      { ErrorResolver },
      { SmartSuggestions },
      { PipelineGenerator },
      { AnomalyDetector },
      { AIPersonaManager },
      { SchemaAdvisor },
    ] = await Promise.all([
      import('./modules/ai/NL2SOQL.js'),
      import('./modules/ai/ErrorResolver.js'),
      import('./modules/ai/SmartSuggestions.js'),
      import('./modules/ai/PipelineGenerator.js'),
      import('./modules/ai/AnomalyDetector.js'),
      import('./modules/ai/AIPersonaManager.js'),
      import('./modules/ai/SchemaAdvisor.js'),
    ]);

    handlers.setAIModules({
      nl2soql: new NL2SOQL(aiProvider),
      errorResolver: new ErrorResolver(aiProvider),
      smartSuggestions: new SmartSuggestions(aiProvider),
      pipelineGenerator: new PipelineGenerator(aiProvider),
      anomalyDetector: new AnomalyDetector(),
      personaManager: new AIPersonaManager(),
      schemaAdvisor: new SchemaAdvisor(),
    });
    log('AI modules (Tier 2) initialized.');
  };
  initAI().catch((err) => log(`Failed to init AI: ${String(err)}`));

  handlers.registerAll(router);

  // 8. PanelManager (creates full-editor webview panels for modules)
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

  // 8b. Wire BackgroundOperationRegistry events to stateSync + native notifications
  backgroundRegistry.onEvent((operationId, type, operation) => {
    if (type === 'completed' || type === 'failed') {
      stateSync.setActiveOperations(backgroundRegistry.getActiveOperations());

      // Native VSCode notification if no SandForge panel is visible
      if (!panelManager.isAnyPanelVisible() && !operation.notifiedNatively) {
        backgroundRegistry.markNotifiedNatively(operationId);
        const label = type === 'completed'
          ? `SandForge: ${operation.module} completed${operation.resultSummary ? ' \u2014 ' + operation.resultSummary : ''}`
          : `SandForge: ${operation.module} failed${operation.resultSummary ? ' \u2014 ' + operation.resultSummary : ''}`;
        vscode.window.showInformationMessage(label, 'Show Details').then((action) => {
          if (action === 'Show Details') {
            panelManager.openPanel({ viewType: 'sandforge-main', title: 'SandForge', column: 1 });
          }
        });
      }
    }
    if (type === 'started' || type === 'progress') {
      stateSync.setActiveOperations(backgroundRegistry.getActiveOperations());
    }
  });

  // 9. SidebarViewProvider (WebView-based sidebar navigation)
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
    sidebarProvider as unknown as vscode.WebviewViewProvider,
  );

  // 10. Register module commands
  const moduleCommands: Array<{ command: string; moduleId: string; title: string }> = [
    { command: 'sandforge.openMonitor', moduleId: 'monitor', title: 'Monitor' },
    { command: 'sandforge.openForge', moduleId: 'forge', title: 'Forge' },
    { command: 'sandforge.openGrappe', moduleId: 'grappe', title: 'Grappe' },
    { command: 'sandforge.openCompare', moduleId: 'compare', title: 'Compare' },
    { command: 'sandforge.openDataOps', moduleId: 'dataops', title: 'DataOps' },
    { command: 'sandforge.openAutomation', moduleId: 'automation', title: 'Automation' },
    { command: 'sandforge.openOrgs', moduleId: 'orgs', title: 'Organizations' },
    { command: 'sandforge.openSettings', moduleId: 'settings', title: 'Settings' },
    { command: 'sandforge.openHelp', moduleId: 'help', title: 'Help' },
  ];

  const currentVersion = '1.0.0';
  let onboardingTriggered = false;

  for (const { command, moduleId, title } of moduleCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        panelManager.openPanel({
          viewType: `sandforge.${moduleId}`,
          title: `SandForge: ${title}`,
          moduleId,
        });
        orgRegistry.loadAll();
        const orgs = orgManager.getAllOrgs();
        stateSync.updateState({
          orgs: orgs as unknown as Record<string, unknown>[],
          extensionReady: true,
        });

        // Trigger onboarding or what's new on first panel open
        if (!onboardingTriggered) {
          onboardingTriggered = true;
          if (onboardingService.shouldShowOnboarding()) {
            panelManager.postToActivePanel({
              type: 'onboarding:show',
              id: `onboarding-${Date.now()}`,
              timestamp: Date.now(),
              payload: {},
            });
            onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
          } else if (onboardingService.shouldShowWhatsNew(currentVersion)) {
            panelManager.postToActivePanel({
              type: 'whats-new:show',
              id: `whatsnew-${Date.now()}`,
              timestamp: Date.now(),
              payload: { version: currentVersion },
            });
            onboardingService.markVersionSeen(currentVersion).catch(() => undefined);
          }
        }
      }),
    );
  }

  // 11. Easter egg command (discoverable via Command Palette but not in menus)
  context.subscriptions.push(
    vscode.commands.registerCommand('sandforge.cheers', () => {
      panelManager.postToActivePanel({ type: 'easter-egg:show' });
    }),
  );

  // 13. StatusBar — shows org count and active state
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
  orgManager.onOrgChange(() => {
    const orgs = orgManager.getAllOrgs();
    stateSync.updateState({
      orgs: orgs as unknown as Record<string, unknown>[],
    });
    const count = orgs.length;
    statusBar.updateText('sandforge.status', `$(flame) SandForge: ${count} org${count !== 1 ? 's' : ''}`);
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
  );
}

/**
 * Called when the extension is deactivated.
 * Cleans up router and broker.
 */
export function deactivate(): void {
  router?.dispose();
  broker?.dispose();
  router = undefined;
  broker = undefined;
  // Infrastructure services with dispose methods are cleaned up via context.subscriptions
}
