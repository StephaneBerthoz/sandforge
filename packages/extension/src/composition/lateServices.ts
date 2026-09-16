import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { InfraServices, MigrationFileReader } from '../bridge/ExtensionHandlers';
import type { OnboardingService } from '../core/onboarding/OnboardingService';
import type { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import type { PipelineMarketplace } from '../modules/automation/PipelineMarketplace';
import type { LiveOperationTracker } from '../modules/monitor/LiveOperationTracker';
import type { BackupRecordStore } from '../modules/dataops/BackupRecordStore.js';

/**
 * LateServices — the dependencies injected into `ExtensionHandlers` through
 * setters instead of the constructor.
 *
 * ## Late-injection contract (two-phase construction)
 *
 * `ExtensionHandlers` is built in two phases, on purpose:
 *
 * 1. **Construction + sync setters** (this object) run BEFORE
 *    `handlers.registerAll(router)`. ORDER MATTERS: `setBackgroundRegistry`
 *    constructs the `ExecutionHandler`, which `registerAll` only routes when
 *    it exists — moving that setter after `registerAll` silently drops the
 *    `execution:*` routes. Keep the call order in `applyLateServices`.
 *
 * 2. **Async setters** — `setForgeOrchestrator` (see `./forgeComposition.ts`),
 *    `setAutopilotOrchestrator` (see `./autopilotComposition.ts`),
 *    `setAIAssistant` / `setAIModules` (see
 *    `./aiComposition.ts`) — resolve AFTER `registerAll`, because they depend
 *    on dynamic imports deliberately kept off the activation hot path.
 *
 * Consequence: domain handlers MUST resolve late dependencies at call time,
 * never at registration time, and answer honestly until injection lands
 * (e.g. `NOT_INITIALIZED` / `AI_NOT_CONFIGURED` guards inside the bridge
 * handlers). This is what makes `registerAll`-before-injection safe.
 */
export interface LateServices {
  /** Onboarding for the settings handler. */
  onboardingService: OnboardingService;
  /** Infrastructure services shared via the mutable HandlerDeps. */
  infraServices: InfraServices;
  /**
   * Background registry — also constructs the ExecutionHandler, which is why
   * it is passed here as well as inside `infraServices`. A handler that only
   * needs to register a run reads it from `infraServices`; this entry is the
   * construction step, and nothing else performs it.
   */
  backgroundRegistry: BackgroundOperationRegistry;
  /** Migration file reader. */
  migrationFileReader: MigrationFileReader;
  /** Pipeline marketplace. */
  pipelineMarketplace: PipelineMarketplace;
  /** Live operation tracker serving monitor:live-operations polls. */
  liveOperationTracker: LiveOperationTracker;
  /**
   * File-backed store for backup record payloads, keeping megabytes of SOQL
   * results out of globalState — VSCode re-serializes that memento in full on
   * every write.
   */
  backupRecordStore: BackupRecordStore;
}

/**
 * Apply the synchronous late services to `ExtensionHandlers`.
 * MUST be called before `handlers.registerAll(router)` — see the contract on
 * {@link LateServices}. Call order below is load-bearing.
 */
export function applyLateServices(handlers: ExtensionHandlers, late: LateServices): void {
  handlers.setOnboardingService(late.onboardingService);
  handlers.setInfraServices(late.infraServices);
  // Must precede registerAll: creates the ExecutionHandler that registerAll
  // conditionally routes (execution:abort).
  handlers.setBackgroundRegistry(late.backgroundRegistry);
  handlers.setMigrationServices(late.migrationFileReader);
  handlers.setPipelineMarketplace(late.pipelineMarketplace);
  handlers.setLiveOperationTracker(late.liveOperationTracker);
  handlers.setBackupRecordStore(late.backupRecordStore);
}
