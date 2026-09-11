import type { MessageBroker } from './MessageBroker.js';
import type { MessageRouter } from './MessageRouter.js';
import type { WebviewStateSync } from './WebviewStateSync.js';
import type { BaseMessage, ErrorBoundaryReport } from '@sandforge/shared';
import type { QueuedOperation } from '../core/connection/OfflineManager.js';
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
import type { BackupRecordStore } from '../modules/dataops/BackupRecordStore.js';
import type {
  HandlerDeps,
  DomainHandler,
  InboundRequest,
  InfraServices,
} from './handlers/HandlerTypes.js';
import { syntheticRequest } from './handlers/HandlerTypes.js';
import { OrgHandler } from './handlers/OrgHandler.js';
import { SettingsHandler } from './handlers/SettingsHandler.js';
import { MonitorOpsHandler } from './handlers/MonitorOpsHandler.js';
import { SeedOpsHandler } from './handlers/SeedOpsHandler.js';
import { SeedCloneHandler } from './handlers/SeedCloneHandler.js';
import { SeedCsvHandler } from './handlers/SeedCsvHandler.js';
import { SyncOpsHandler } from './handlers/SyncOpsHandler.js';
import { SyncHistoryHandler } from './handlers/SyncHistoryHandler.js';
import { SyncHistoryStore } from '../modules/sync/SyncHistoryStore.js';
import { SyncExecutionLogger } from '../modules/sync/SyncExecutionLogger.js';
import { CompareHandler } from './handlers/CompareHandler.js';
import { DataOpsHandler } from './handlers/DataOpsHandler.js';
import { AutomationHandler } from './handlers/AutomationHandler.js';
import { AIHandler } from './handlers/AIHandler.js';
import type { AIModules } from './handlers/AIHandler.js';
import type { AIDiagnoseHandler } from './handlers/ai/AIDiagnoseHandler.js';
import { AutopilotHandler } from './handlers/AutopilotHandler.js';
import { ForgeHandler } from './handlers/ForgeHandler.js';
import type { ForgeServices } from './handlers/ForgeHandler.js';
import { FrozenDatasetHandler } from './handlers/FrozenDatasetHandler.js';
import { MigrationHandler } from './handlers/MigrationHandler.js';
import type { MigrationFileReader } from './handlers/MigrationHandler.js';
import { ConfigHandler } from './handlers/ConfigHandler.js';
import { GovernanceOpsHandler } from './handlers/GovernanceOpsHandler.js';
import { QuickSyncHandler } from './handlers/QuickSyncHandler.js';
import { SyncScheduleHandler } from './handlers/SyncScheduleHandler.js';
import { NoOpHandler } from './handlers/NoOpHandler.js';
import { CacheHandler as CacheDomainHandler } from './handlers/CacheHandler.js';
import { FileHandler } from './handlers/FileHandler.js';
import { ReportsHandler } from './handlers/ReportsHandler.js';
import { SmartActionHandler } from './handlers/SmartActionHandler.js';
import { ExecutionHandler } from './handlers/ExecutionHandler.js';
import { I18nHandler } from './handlers/I18nHandler.js';
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
  /**
   * Directory holding the packaged webview locale JSONs
   * (`<extension>/webview-dist/locales`), served by the I18nHandler for lazy
   * i18n loading. Optional so tests that construct ExtensionHandlers with the
   * legacy shape continue to compile; requests then answer with an error
   * payload.
   */
  localesDir?: string;
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
  private readonly seedCloneHandler: SeedCloneHandler;
  private readonly seedCsvHandler: SeedCsvHandler;
  private readonly syncHandler: SyncOpsHandler;
  private readonly syncHistoryHandler: SyncHistoryHandler;
  private readonly compareHandler: CompareHandler;
  private readonly dataOpsHandler: DataOpsHandler;
  private readonly automationHandler: AutomationHandler;
  private readonly aiHandler: AIHandler;
  private readonly autopilotHandler: AutopilotHandler;
  private readonly forgeHandler: ForgeHandler;
  private readonly frozenHandler: FrozenDatasetHandler;
  private readonly migrationHandler: MigrationHandler;
  private readonly configHandler: ConfigHandler;
  private readonly governanceHandler: GovernanceOpsHandler;
  private readonly quickSyncHandler: QuickSyncHandler;
  private readonly syncScheduleHandler: SyncScheduleHandler;
  private readonly noOpHandler: NoOpHandler;
  private readonly cacheHandler: CacheDomainHandler;
  private readonly fileHandler: FileHandler;
  private readonly reportsHandler: ReportsHandler;
  private readonly smartActionHandler: SmartActionHandler;
  private readonly i18nHandler: I18nHandler;
  private readonly syncHistoryStore: SyncHistoryStore;
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
    this.seedCloneHandler = new SeedCloneHandler(this.handlerDeps);
    this.seedCsvHandler = new SeedCsvHandler(this.handlerDeps);
    this.syncHandler = new SyncOpsHandler(this.handlerDeps);
    // Sync execution history: one shared store — SyncOpsHandler writes via
    // SyncExecutionLogger, SyncHistoryHandler serves the read surface and
    // ExecutionHandler replays failed runs from it (execution:manual-retry).
    this.syncHistoryStore = new SyncHistoryStore(deps.configStore);
    this.syncHandler.setHistoryLogger(new SyncExecutionLogger(this.syncHistoryStore));
    this.syncHistoryHandler = new SyncHistoryHandler(
      this.handlerDeps,
      this.syncHistoryStore,
      this.syncHandler,
    );
    this.compareHandler = new CompareHandler(this.handlerDeps);
    this.dataOpsHandler = new DataOpsHandler(this.handlerDeps);
    this.automationHandler = new AutomationHandler(this.handlerDeps);
    this.aiHandler = new AIHandler(this.handlerDeps);
    this.autopilotHandler = new AutopilotHandler(this.handlerDeps);
    this.forgeHandler = new ForgeHandler(this.handlerDeps);
    this.frozenHandler = new FrozenDatasetHandler(this.handlerDeps);
    this.migrationHandler = new MigrationHandler(this.handlerDeps);
    this.configHandler = new ConfigHandler(this.handlerDeps);
    this.governanceHandler = new GovernanceOpsHandler(
      this.handlerDeps,
      this.monitorHandler.getAlertEngine(),
    );
    this.quickSyncHandler = new QuickSyncHandler(this.handlerDeps);
    this.syncScheduleHandler = new SyncScheduleHandler(this.handlerDeps);
    this.noOpHandler = new NoOpHandler(this.handlerDeps);
    this.cacheHandler = new CacheDomainHandler(this.handlerDeps);
    this.fileHandler = new FileHandler(this.handlerDeps);
    this.reportsHandler = new ReportsHandler(this.handlerDeps);
    this.smartActionHandler = new SmartActionHandler(this.handlerDeps);
    this.i18nHandler = new I18nHandler(this.handlerDeps, deps.localesDir);
  }

  /** Inject live operation tracker for monitor:live-operations messages. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.monitorHandler.setLiveOperationTracker(tracker);
    // Producers: seed/sync executions register progress + completion so the
    // Monitor "live operations" panel is actually fed.
    this.seedHandler.setLiveOperationTracker(tracker);
    this.syncHandler.setLiveOperationTracker(tracker);
  }

  /** Inject masking template service for dataops:masking-templates-by-object messages. */
  setBackupRecordStore(store: BackupRecordStore): void {
    this.dataOpsHandler.setBackupRecordStore(store);
  }

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
   * Late-inject the org-selection callback (status bar + broadcast). The
   * selection closure is defined in extension.ts AFTER the handlers are
   * constructed — same mutation pattern as setInfraServices.
   */
  setOrgSelectionCallback(callback: (orgId: string) => void): void {
    this.handlerDeps.onOrgSelected = callback;
  }

  /**
   * Inject BackgroundOperationRegistry into handlers that support background execution.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setBackgroundRegistry(registry: BackgroundOperationRegistry): void {
    this.syncHandler.setRegistry(registry);
    this.seedHandler.setRegistry(registry);
    // Clone, CSV import and frozen-dataset loads run through BulkDataWriter
    // too. Without the registry they passed a throwaway AbortController, so
    // execution:abort answered "Operation not found" and the run continued.
    this.seedCloneHandler.setRegistry(registry);
    this.seedCsvHandler.setRegistry(registry);
    this.frozenHandler.setRegistry(registry);
    // The sync history store + sync handler turn execution:manual-retry into a
    // real replay for failed sync runs (rerunFromSnapshot path).
    this.executionHandler = new ExecutionHandler(
      this.handlerDeps,
      registry,
      this.syncHistoryStore,
      this.syncHandler,
    );
  }

  /**
   * Replay an operation queued while offline (OfflineManager drain callback,
   * wired from composition via `wireOfflineReplay`).
   *
   * Replays go through the same entry points as user-triggered reruns, so
   * payload re-validation, production guard and history logging all re-apply:
   * - `sync` → SyncOpsHandler.rerunFromSnapshot (config snapshot re-validated);
   * - `seed` → SeedOpsHandler seed:execute (payload re-validated).
   *
   * Note: nothing enqueues `seed` operations anymore (inserts are not
   * idempotent — auto-replay could duplicate records; the failure payload
   * carries `offlineReplayAvailable: false` instead). The `seed` case stays so
   * queue entries persisted by earlier versions still drain instead of being
   * rejected as unsupported.
   *
   * Execution failures are reported on the usual `<domain>:error` /
   * `operation:failed` channels rather than thrown, so a failed replay is
   * consumed from the queue (OfflineManager counts it executed) and surfaced
   * to the user through the normal error surface.
   *
   * @param operation - The queued operation to replay.
   */
  async replayQueuedOperation(operation: QueuedOperation): Promise<void> {
    // The request that queued this operation is long gone: the replay's
    // origin is a listed synthetic request, never a hand-built message.
    const msg = syntheticRequest('offline-replay', operation.id, `${operation.type}:execute`);
    switch (operation.type) {
      case 'sync':
        await this.syncHandler.rerunFromSnapshot(msg, operation.payload.config);
        return;
      case 'seed': {
        // Bridge messages carry their payload structurally (BaseMessage has no
        // payload field) — same shape the webview sends for seed:execute.
        const seedMsg: InboundRequest & { payload: Record<string, unknown> } = {
          ...msg,
          payload: operation.payload,
        };
        await this.seedHandler.handle(seedMsg);
        return;
      }
      default:
        throw new Error(`Unsupported queued operation type: ${operation.type}`);
    }
  }

  /**
   * Start the sync schedule executor tick loop with a real execution bridge.
   *
   * Wires `SyncScheduleExecutor.onExecute` to `SyncOpsHandler.executeScheduled`
   * so due `sync:schedule:*` entries actually run (60 s tick). Call once from
   * extension.ts after service injection (setBackgroundRegistry & co.).
   * Pair with {@link stopSyncScheduler} on extension deactivate.
   */
  startSyncScheduler(): void {
    this.syncScheduleHandler.startScheduler((config) => this.syncHandler.executeScheduled(config));
  }

  /** Stop the sync schedule executor tick loop. Call from extension deactivate(). */
  stopSyncScheduler(): void {
    this.syncScheduleHandler.stopScheduler();
  }

  /** Inject AI modules (Tier 2). */
  setAIModules(modules: AIModules): void {
    this.aiHandler.setAIModules(modules);
  }

  /**
   * Inject the concrete AI diagnose handler (Tier 2, plan 04-04).
   *
   * Wired from extension.ts only when the AI stack is enabled; until then the
   * AIDiagnoseAdapter answers ai:diagnose / ai:approve-action with an explicit
   * AI_NOT_CONFIGURED response instead of dropping the message.
   */
  setAIDiagnoseHandler(handler: AIDiagnoseHandler): void {
    this.aiHandler.setDiagnoseHandler(handler);
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
    // The wrapper MUST return/await the handler promise: MessageBroker's
    // rejection safety-net (continueDispatch) only catches promises it can
    // see — a fire-and-forget wrapper would bypass it and drop rejections.
    const route = (types: string[], handler: DomainHandler) => {
      for (const type of types) {
        router.route(type, async (msg) => {
          await handler.handle(msg);
        });
      }
    };

    // Org
    route(['org:list', 'org:connect', 'org:disconnect', 'org:select'], this.orgHandler);

    // Settings & infrastructure
    route(
      [
        'settings:get',
        'settings:update',
        'onboarding:complete',
        'onboarding:reset',
        'hint:dismiss',
        'telemetry:status',
        'telemetry:toggle',
        'connectivity:status',
      ],
      this.settingsHandler,
    );

    // i18n (lazy locale loading — packaged locale JSONs served over the bridge)
    route(['i18n:locale'], this.i18nHandler);

    // Seed
    route(
      [
        'seed:execute',
        'seed:describe-global',
        'seed:describe-object',
        'seed:template:save',
        'seed:template:load',
        'seed:template:list',
        'seed:template:delete',
        'seed:list-personas',
        'seed:create-persona',
      ],
      this.seedHandler,
    );

    // Seed — record clone wizard (useClone)
    route(
      ['seed:clone:describe-source', 'seed:clone:preview', 'seed:clone:execute'],
      this.seedCloneHandler,
    );

    // Seed — CSV import wizard (useCsvImport)
    route(['seed:csv:validate', 'seed:csv:execute'], this.seedCsvHandler);

    // Sync
    route(
      [
        'sync:execute',
        'sync:describe-global',
        'sync:describe-fields',
        'sync:config:save',
        'sync:config:load',
        'sync:config:list',
        'sync:config:delete',
      ],
      this.syncHandler,
    );

    // Sync execution history (useSyncHistoryStore)
    route(
      ['sync:history:list', 'sync:history:detail', 'sync:history:rerun', 'sync:history:export'],
      this.syncHistoryHandler,
    );

    // Sync schedules (CRUD backed by SyncScheduleExecutor + SyncScheduleStore)
    route(
      [
        'sync:schedule:list',
        'sync:schedule:upsert',
        'sync:schedule:toggle',
        'sync:schedule:delete',
      ],
      this.syncScheduleHandler,
    );

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
        'monitor:alerts',
        'monitor:alert:acknowledge',
        'monitor:alert:dismiss',
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
        'backup:list',
        'backup:export',
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
        'ai:conversation:list',
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
        'ai:diagnose',
        'ai:approve-action',
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
        'forge:target-preflight:request',
      ],
      this.forgeHandler,
    );

    // Frozen Reference Dataset
    route(
      [
        'frozen:config:get',
        'frozen:config:save',
        'frozen:select',
        'frozen:extract',
        'frozen:manifest:get',
        'frozen:load',
        'frozen:verify',
        'frozen:status',
      ],
      this.frozenHandler,
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
    route(['file:save'], this.fileHandler);
    route(['reports:list'], this.reportsHandler);

    // Execution lifecycle (abort/status/list/manual-retry)
    if (this.executionHandler) {
      route(
        ['execution:abort', 'execution:status', 'execution:list', 'execution:manual-retry'],
        this.executionHandler,
      );
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

    // Webview crash reports (React ErrorBoundary). Fire-and-forget: logged
    // to the output channel so render crashes are diagnosable in the wild.
    router.route('error:boundary', (msg: BaseMessage) => {
      const { payload } = msg as ErrorBoundaryReport;
      this.handlerDeps.log(
        `[ERR] Webview crash (error:boundary): ${payload?.message ?? 'unknown error'}` +
          (payload?.stack ? `\n${payload.stack}` : ''),
      );
    });
  }

  private nextId(): string {
    return `ext-${++this.idCounter}`;
  }
}
