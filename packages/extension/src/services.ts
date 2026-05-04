import type * as vscode from 'vscode';

import {
  SalesforceAdapter,
  TelemetryAdapter,
  StorageAdapter,
  FsAdapter,
} from './adapters/index.js';
import type { ConfigStore } from './core/storage/ConfigStore.js';

import { MonitorOrchestrator } from './modules/monitor/MonitorOrchestrator.js';
import type { MonitorDependencies } from './modules/monitor/MonitorOrchestrator.js';
import { SeedOrchestrator } from './modules/seed/SeedOrchestrator.js';
import type { SeedOrchestratorDependencies } from './modules/seed/SeedOrchestrator.js';
import { SyncOrchestrator } from './modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from './modules/sync/SyncOrchestrator.js';
import { CompareOrchestrator } from './modules/compare/CompareOrchestrator.js';
import type { CompareDependencies } from './modules/compare/CompareOrchestrator.js';
import { PipelineOrchestrator } from './modules/automation/PipelineOrchestrator.js';
import type { PipelineOrchestratorDependencies } from './modules/automation/PipelineOrchestrator.js';

/**
 * CoreServices — the cross-cutting adapter bundle.
 * Every orchestrator and handler receives this subset via constructor
 * injection so telemetry, storage, and jsforce IO stay centralised.
 */
export interface CoreServices {
  /** The active VSCode extension context (used by adapters that need it). */
  context: vscode.ExtensionContext;
  /** Storage facade (globalState / workspaceState / SecretStorage). */
  storage: StorageAdapter;
  /** Telemetry + structured logger facade. */
  telemetry: TelemetryAdapter;
  /** jsforce gateway with concurrency gate + retry. */
  salesforce: SalesforceAdapter;
  /** Safe filesystem wrapper constrained to workspace root. */
  fs: FsAdapter;
  /**
   * VS Code-globalState-backed config store. Optional — populated by
   * extension.ts after both `services` and the ConfigStore are created
   * (legacy ordering). Modules that need it should branch on its presence.
   */
  configStore?: ConfigStore;
}

/**
 * Factory signatures for orchestrators.
 *
 * Orchestrators are NOT eagerly constructed by `createServices` because their
 * per-operation dependencies (jsforce connection, runtime callbacks) are only
 * known when a webview message arrives. Instead, factories capture the
 * adapters and build fully-wired orchestrators on demand from handlers.
 */
export interface OrchestratorFactories {
  monitorOrchestrator: (deps: MonitorDependencies) => MonitorOrchestrator;
  seedOrchestrator: (deps: SeedOrchestratorDependencies) => SeedOrchestrator;
  syncOrchestrator: (deps: SyncOrchestratorDeps) => SyncOrchestrator;
  compareOrchestrator: (deps: CompareDependencies) => CompareOrchestrator;
  /** DataOps currently has no single orchestrator — reserved for Phase 03+. */
  dataopsOrchestrator: null;
  automationOrchestrator: (deps: PipelineOrchestratorDependencies) => PipelineOrchestrator;
}

/**
 * Services — the complete composition root result.
 *
 * Combines cross-cutting adapters with lazily-constructed orchestrator factories.
 * Every module in the extension should receive this object (or a subset) via
 * constructor injection rather than instantiating dependencies inline.
 */
export interface Services extends CoreServices, OrchestratorFactories {}

/**
 * Compose the full service graph for the extension host.
 *
 * Construction order is a pure DAG:
 *   telemetry (no deps)
 *     → storage (no deps)
 *       → salesforce (storage, telemetry)
 *         → fs (telemetry)
 *           → orchestrator factories (capture the above)
 *
 * After wiring, `runSecretMigration` is invoked (fire-and-forget) to silently
 * move any legacy globalState credentials into SecretStorage.
 *
 * @param context - The VSCode extension context.
 * @returns A fully wired Services object ready to be passed to handlers.
 */
export function createServices(context: vscode.ExtensionContext): Services {
  const telemetry = new TelemetryAdapter(context);
  const storage = new StorageAdapter(context);
  const salesforce = new SalesforceAdapter(storage, telemetry);
  const fs = new FsAdapter(telemetry);

  const services: Services = {
    context,
    storage,
    telemetry,
    salesforce,
    fs,
    monitorOrchestrator: (deps) => new MonitorOrchestrator(deps),
    seedOrchestrator: (deps) => new SeedOrchestrator(deps),
    syncOrchestrator: (deps) => new SyncOrchestrator(deps),
    compareOrchestrator: (deps) => new CompareOrchestrator(deps),
    dataopsOrchestrator: null,
    automationOrchestrator: (deps) => new PipelineOrchestrator(deps),
  };

  // Fire-and-forget: do not block activation on keychain IO.
  void runSecretMigration(storage, telemetry, context);

  return services;
}

/** Shape of a per-org record persisted in globalState under `sandforge.orgs`. */
interface LegacyOrgRecord {
  orgId: string;
  [key: string]: unknown;
}

/**
 * Silently move legacy credentials from `globalState` into `SecretStorage`.
 *
 * Targets:
 *  - `ai.apiKey` → `sandforge.ai.anthropic.key`
 *  - `sandforge.${orgId}.accessToken` → same key in SecretStorage
 *  - `sandforge.${orgId}.refreshToken` → same key in SecretStorage
 *
 * Idempotent: keys already migrated (i.e. absent in globalState) are skipped
 * without failure. Emits a single telemetry breadcrumb summarising the run.
 *
 * @param storage - StorageAdapter instance.
 * @param telemetry - TelemetryAdapter for breadcrumb emission.
 * @param context - Extension context (used to enumerate org identifiers).
 * @returns `{ count, success }` — count is the number of keys migrated.
 */
export async function runSecretMigration(
  storage: StorageAdapter,
  telemetry: TelemetryAdapter,
  context: vscode.ExtensionContext,
): Promise<{ count: number; success: boolean }> {
  let count = 0;
  let success = true;

  try {
    if (await storage.migrateLegacyKey('ai.apiKey', 'sandforge.ai.anthropic.key', true)) {
      count++;
    }

    const orgIds = collectOrgIds(context);
    for (const orgId of orgIds) {
      const accessKey = `sandforge.${orgId}.accessToken`;
      const refreshKey = `sandforge.${orgId}.refreshToken`;
      if (await storage.migrateLegacyKey(accessKey, accessKey, true)) {
        count++;
      }
      if (await storage.migrateLegacyKey(refreshKey, refreshKey, true)) {
        count++;
      }
    }
  } catch (err) {
    success = false;
    telemetry.captureException(err, { stage: 'secret_migration' });
  }

  telemetry.addBreadcrumb(
    `secret_migration count=${count} success=${success}`,
    'storage',
    success ? 'info' : 'error',
  );

  // Also log to Pino so operators see migration stats in Output → SandForge
  // regardless of whether Sentry is enabled. Safe: no key material logged.
  try {
    telemetry
      .getLogger()
      .info({ event: 'secret_migration', count, success }, 'secret migration complete');
  } catch {
    // logger unavailable in degraded test envs — swallow.
  }

  return { count, success };
}

/**
 * Collect org identifiers from legacy globalState shapes.
 * Checks `sandforge.orgs` (preferred) then falls back to `orgs` for older installs.
 */
function collectOrgIds(context: vscode.ExtensionContext): string[] {
  const ids = new Set<string>();
  const candidates: unknown[] = [
    context.globalState.get('sandforge.orgs'),
    context.globalState.get('orgs'),
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue;
    for (const entry of raw as LegacyOrgRecord[]) {
      if (entry && typeof entry === 'object' && typeof entry.orgId === 'string') {
        ids.add(entry.orgId);
      }
    }
  }
  return [...ids];
}
