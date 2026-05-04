import type { MessageBroker } from './MessageBroker.js';
import type { MessageRouter } from './MessageRouter.js';
import type { WebviewStateSync } from './WebviewStateSync.js';
import type { OrgManager } from '../core/connection/OrgManager.js';
import type { OrgRegistry } from '../core/connection/OrgRegistry.js';
import type { ConfigStore } from '../core/storage/ConfigStore.js';
import type { SecretVault } from '../core/storage/SecretVault.js';
import type { AuthProvider } from '../core/connection/AuthProvider.js';
import type { SfdxBridge } from '../core/connection/SfdxBridge.js';
import type { OnboardingService } from '../core/onboarding/OnboardingService.js';
import type { HintTracker } from '../core/onboarding/HintTracker.js';
import type { AIAssistant } from '../modules/ai/AIAssistant.js';
import type { PipelineMarketplace } from '../modules/automation/PipelineMarketplace.js';
import type { AutopilotOrchestrator } from '../modules/autopilot/AutopilotOrchestrator.js';
import type { ForgeOrchestrator } from '../modules/forge/ForgeOrchestrator.js';
import type { Services } from '../services.js';

import type { LiveOperationTracker } from '../modules/monitor/LiveOperationTracker.js';
import type { MaskingTemplateService } from '../modules/dataops/templates/MaskingTemplateService.js';
import type { HandlerDeps, DomainHandler, InfraServices } from './handlers/HandlerTypes.js';
import { OrgHandler } from './handlers/OrgHandler.js';
import { SettingsHandler } from './handlers/SettingsHandler.js';
import { MonitorOpsHandler } from './handlers/MonitorOpsHandler.js';
import { SeedOpsHandler } from './handlers/SeedOpsHandler.js';
import { SyncOpsHandler } from './handlers/SyncOpsHandler.js';
import { CompareHandler } from './handlers/CompareHandler.js';
import { DataOpsHandler } from './handlers/DataOpsHandler.js';
import { AutomationHandler } from './handlers/AutomationHandler.js';
import { AIHandler } from './handlers/AIHandler.js';
import type { AIModules } from './handlers/AIHandler.js';
import { AutopilotHandler } from './handlers/AutopilotHandler.js';
import { ForgeHandler } from './handlers/ForgeHandler.js';
import type { ForgeServices } from './handlers/ForgeHandler.js';
import { MigrationHandler } from './handlers/MigrationHandler.js';
import type { MigrationFileReader } from './handlers/MigrationHandler.js';
import { ConfigHandler } from './handlers/ConfigHandler.js';
import { GovernanceOpsHandler } from './handlers/GovernanceOpsHandler.js';
import { QuickSyncHandler } from './handlers/QuickSyncHandler.js';
import { NoOpHandler } from './handlers/NoOpHandler.js';
import { CacheHandler as CacheDomainHandler } from './handlers/CacheHandler.js';
import { SmartActionHandler } from './handlers/SmartActionHandler.js';
import { ExecutionHandler } from './handlers/ExecutionHandler.js';
import type { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry.js';

/**
 * Thenable-returning command executor — mirrors `vscode.commands.executeCommand`
 * without importing vscode directly (keeps this module testable in mocked envs).
 */
export type CommandExecutor = (command: string, ...args: unknown[]) => PromiseLike<unknown>;

// Re-export interfaces for backward compatibility
export type { InfraServices } from './handlers/HandlerTypes.js';
export type { AIModules } from './handlers/AIHandler.js';
export type { MigrationFileReader } from './handlers/MigrationHandler.js';

/** Dependencies injected into ExtensionHandlers. */
export interface ExtensionHandlersDeps {
  log: (msg: string) => void;
  broker: MessageBroker;
  stateSync: WebviewStateSync;
  orgManager: OrgManager;
  orgRegistry: OrgRegistry;
  configStore: ConfigStore;
  secretVault: SecretVault;
  authProvider: AuthProvider;
  sfdxBridge: SfdxBridge;
  /**
   * Composition-root Services bundle (4 core adapters + orchestrator factories).
   * Optional so tests that construct ExtensionHandlers with the legacy shape
   * continue to compile; production extension.ts wires it eagerly.
   */
  services?: Services;
  /**
   * Injected executor for VSCode commands. Used by the `workbench:reload`
   * handler (Plan 01-04-11) to trigger `workbench.action.reloadWindow` when
   * the protocol-mismatch banner's Reload button is clicked. Defaults to a
   * no-op in tests that don't provide one.
   */
  executeCommand?: CommandExecutor;
}

/**
 * Central message handler registry for all WebView-to-Extension messages.
 *
 * Delegates message handling to domain-specific handlers, each responsible
 * for a cohesive set of message types. This class manages handler lifecycle
 * (registration, DI injection) and routes messages to the correct domain.
 */
export class ExtensionHandlers {
  private readonly handlerDeps: HandlerDeps;
  private readonly executeCommand: CommandExecutor;
  private idCounter = 0;

  // Domain handlers
  private readonly orgHandler: OrgHandler;
  private readonly settingsHandler: SettingsHandler;
  private readonly monitorHandler: MonitorOpsHandler;
  private readonly seedHandler: SeedOpsHandler;
  private readonly syncHandler: SyncOpsHandler;
  private readonly compareHandler: CompareHandler;
  private readonly dataOpsHandler: DataOpsHandler;
  private readonly automationHandler: AutomationHandler;
  private readonly aiHandler: AIHandler;
  private readonly autopilotHandler: AutopilotHandler;
  private readonly forgeHandler: ForgeHandler;
  private readonly migrationHandler: MigrationHandler;
  private readonly configHandler: ConfigHandler;
  private readonly governanceHandler: GovernanceOpsHandler;
  private readonly quickSyncHandler: QuickSyncHandler;
  private readonly noOpHandler: NoOpHandler;
  private readonly cacheHandler: CacheDomainHandler;
  private readonly smartActionHandler: SmartActionHandler;
  private executionHandler?: ExecutionHandler;

  constructor(deps: ExtensionHandlersDeps) {
    // Default to a no-op executor so tests that don't care about the reload
    // command can still construct ExtensionHandlers without wiring vscode.
    this.executeCommand = deps.executeCommand ?? (() => Promise.resolve());
    // Shared mutable deps object — infraServices is set later via setInfraServices
    this.handlerDeps = {
      log: deps.log,
      broker: deps.broker,
      stateSync: deps.stateSync,
      orgManager: deps.orgManager,
      orgRegistry: deps.orgRegistry,
      configStore: deps.configStore,
      secretVault: deps.secretVault,
      authProvider: deps.authProvider,
      sfdxBridge: deps.sfdxBridge,
      services: deps.services,
      nextId: () => this.nextId(),
    };

    this.orgHandler = new OrgHandler(this.handlerDeps);
    this.settingsHandler = new SettingsHandler(this.handlerDeps);
    this.monitorHandler = new MonitorOpsHandler(this.handlerDeps);
    this.seedHandler = new SeedOpsHandler(this.handlerDeps);
    this.syncHandler = new SyncOpsHandler(this.handlerDeps);
    this.compareHandler = new CompareHandler(this.handlerDeps);
    this.dataOpsHandler = new DataOpsHandler(this.handlerDeps);
    this.automationHandler = new AutomationHandler(this.handlerDeps);
    this.aiHandler = new AIHandler(this.handlerDeps);
    this.autopilotHandler = new AutopilotHandler(this.handlerDeps);
    this.forgeHandler = new ForgeHandler(this.handlerDeps);
    this.migrationHandler = new MigrationHandler(this.handlerDeps);
    this.configHandler = new ConfigHandler(this.handlerDeps);
    this.governanceHandler = new GovernanceOpsHandler(
      this.handlerDeps,
      this.monitorHandler.getAlertEngine(),
    );
    this.quickSyncHandler = new QuickSyncHandler(this.handlerDeps);
    this.noOpHandler = new NoOpHandler(this.handlerDeps);
    this.cacheHandler = new CacheDomainHandler(this.handlerDeps);
    this.smartActionHandler = new SmartActionHandler(this.handlerDeps);
  }

  /** Inject live operation tracker for monitor:live-operations messages. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.monitorHandler.setLiveOperationTracker(tracker);
  }

  /** Inject masking template service for dataops:masking-templates-by-object messages. */
  setMaskingTemplateService(service: MaskingTemplateService): void {
    this.dataOpsHandler.setMaskingTemplateService(service);
  }

  /** Inject AI assistant service. */
  setAIAssistant(ai: AIAssistant): void {
    this.aiHandler.setAIAssistant(ai);
  }

  /** Inject onboarding services. */
  setOnboardingServices(onboarding: OnboardingService, hints: HintTracker): void {
    this.settingsHandler.setOnboardingServices(onboarding, hints);
  }

  /** Inject infrastructure services (Tier 1). */
  setInfraServices(services: InfraServices): void {
    // Mutate the shared deps object so all handlers see the update
    this.handlerDeps.infraServices = services;
  }

  /**
   * Inject BackgroundOperationRegistry into handlers that support background execution.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setBackgroundRegistry(registry: BackgroundOperationRegistry): void {
    this.syncHandler.setRegistry(registry);
    this.seedHandler.setRegistry(registry);
    this.executionHandler = new ExecutionHandler(this.handlerDeps, registry);
  }

  /** Inject AI modules (Tier 2). */
  setAIModules(modules: AIModules): void {
    this.aiHandler.setAIModules(modules);
  }

  /** Inject migration file reader (Tier 3). */
  setMigrationServices(fileReader: MigrationFileReader): void {
    this.migrationHandler.setFileReader(fileReader);
  }

  /** Inject pipeline marketplace (Tier 3). */
  setPipelineMarketplace(marketplace: PipelineMarketplace): void {
    this.automationHandler.setPipelineMarketplace(marketplace);
  }

  /** Inject autopilot orchestrator (Tier 4). */
  setAutopilotOrchestrator(orchestrator: AutopilotOrchestrator): void {
    this.autopilotHandler.setOrchestrator(orchestrator);
  }

  /**
   * Inject forge orchestrator and optional v2 services (Tier 5).
   *
   * @param orchestrator - The ForgeOrchestrator instance.
   * @param services - Optional additional Forge v2 services.
   */
  setForgeOrchestrator(orchestrator: ForgeOrchestrator, services?: ForgeServices): void {
    this.forgeHandler.setForgeOrchestrator(orchestrator, services);
  }

  /**
   * Register all message handlers on the router.
   *
   * Each message type is mapped directly to its domain handler,
   * preserving synchronous execution where possible.
   */
  registerAll(router: MessageRouter): void {
    const route = (types: string[], handler: DomainHandler) => {
      for (const type of types) {
        router.route(type, (msg) => {
          handler.handle(msg);
        });
      }
    };

    // Org
    route(['org:list', 'org:connect', 'org:disconnect'], this.orgHandler);

    // Settings & infrastructure
    route(
      [
        'settings:get',
        'settings:update',
        'onboarding:complete',
        'onboarding:reset',
        'hint:dismiss',
        'plugins:list',
        'plugins:load',
        'plugins:unload',
        'telemetry:status',
        'telemetry:toggle',
        'connectivity:status',
      ],
      this.settingsHandler,
    );

    // Seed
    route(['seed:execute', 'seed:describe-global', 'seed:describe-object'], this.seedHandler);

    // Sync
    route(['sync:execute', 'sync:describe-global', 'sync:describe-fields'], this.syncHandler);

    // Quick Sync
    route(
      [
        'quicksync:suggest-objects',
        'quicksync:detect-relationships',
        'quicksync:preview',
        'quicksync:execute',
      ],
      this.quickSyncHandler,
    );

    // Monitor
    route(
      [
        'monitor:refresh',
        'monitor:start',
        'monitor:trends',
        'monitor:abort-job',
        'monitor:live-operations',
        'monitor:health-score',
        'monitor:storage',
        'monitor:deployments',
        'monitor:api-usage',
        'monitor:error-logs',
        'monitor:sessions',
        'monitor:apex-insights',
        'monitor:sandbox-refresh',
      ],
      this.monitorHandler,
    );

    // Governance
    route(
      [
        'governance:policies:list',
        'governance:policy:get',
        'governance:policy:save',
        'governance:policy:delete',
        'governance:policies:export',
        'governance:policies:import',
        'governance:evaluate',
        'governance:templates',
      ],
      this.governanceHandler,
    );

    // Compare
    route(
      [
        'compare:execute',
        'compare:start',
        'compare:permissions',
        'compare:snapshots',
        'compare:drift',
      ],
      this.compareHandler,
    );

    // DataOps
    route(
      [
        'backup:execute',
        'dataops:backup',
        'dataops:rollback',
        'dataops:anonymize',
        'dataops:anonymization-templates',
        'dataops:masking-templates-by-object',
        'precheck:pii-scan',
      ],
      this.dataOpsHandler,
    );

    // Automation
    route(
      [
        'pipeline:run',
        'pipeline:execute',
        'pipeline:templates',
        'pipeline:list',
        'pipeline:history',
        'pipeline:save',
        'operation:cancel',
        'operation:pause',
        'operation:resume',
        'marketplace:list',
        'marketplace:install',
      ],
      this.automationHandler,
    );

    // AI
    route(
      [
        'ai:chat',
        'ai:conversation:create',
        'ai:conversation:load',
        'ai:conversation:delete',
        'ai:status',
        'ai:save-key',
        'ai:nl2soql',
        'ai:resolve-error',
        'ai:personas',
        'ai:anomaly-scan',
        'ai:suggestions',
        'ai:generate-pipeline',
        'ai:schema-advice',
      ],
      this.aiHandler,
    );

    // Autopilot
    route(
      [
        'autopilot:scan-schema',
        'autopilot:generate-plan',
        'autopilot:execute',
        'autopilot:pause',
        'autopilot:resume',
        'autopilot:skip-node',
        'autopilot:compliance-report',
      ],
      this.autopilotHandler,
    );

    // Forge
    route(
      [
        'forge:preview',
        'forge:discover',
        'forge:execute',
        'forge:pause',
        'forge:resume',
        'forge:abort',
        'forge:templates:list',
        'forge:templates:save',
        'forge:templates:delete',
        'forge:history:list',
        'forge:plan:request',
        'forge:compliance:request',
        'forge:metadata-diff:request',
      ],
      this.forgeHandler,
    );

    // Migration
    route(['migration:import', 'migration:import-sfdmu'], this.migrationHandler);

    // Config profiles
    route(
      ['config:export', 'config:import', 'config:categories', 'config:validate'],
      this.configHandler,
    );

    // Cache management
    route(['cache:invalidate-all', 'cache:get-stats'], this.cacheHandler);

    // Smart Action
    route(['smart-action:analyze'], this.smartActionHandler);

    // Execution lifecycle (abort/status/list)
    if (this.executionHandler) {
      route(['execution:abort', 'execution:status', 'execution:list'], this.executionHandler);
    }

    // No-op handlers for ghost features (Scheduler v1.2, RealTime CDC v2.0)
    route(
      [
        'scheduler:list',
        'scheduler:upsert',
        'scheduler:delete',
        'scheduler:toggle',
        'realtime:start',
        'realtime:stop',
        'realtime:status',
        'realtime:metrics',
        'realtime:resolve-conflict',
      ],
      this.noOpHandler,
    );

    // Bridge protocol-mismatch reload (Plan 01-04-11). Triggered by the
    // ProtocolMismatchBanner in the webview when the user clicks "Reload".
    router.route('workbench:reload', () => {
      void this.executeCommand('workbench.action.reloadWindow');
    });
  }

  private nextId(): string {
    return `ext-${++this.idCounter}`;
  }
}
