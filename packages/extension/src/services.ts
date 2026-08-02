import * as vscode from 'vscode';

import {
  SalesforceAdapter,
  TelemetryAdapter,
  StorageAdapter,
  FsAdapter,
} from './adapters/index.js';
import {
  createAIClientFactory,
  type AIClientFactory,
  type AIProviderType,
} from './adapters/ai/index.js';
import { SessionBudget, type BudgetBroker } from './adapters/ai/tokenBudget/index.js';
import type { ConfigStore } from './core/storage/ConfigStore.js';
import type { TelemetryAdapterOptions } from './adapters/telemetry/TelemetryAdapter.js';

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
  /**
   * AI client factory, memoised per provider. The first call constructs
   * an `AnthropicAdapter` and lazily reads `sandforge.ai.anthropic.key`
   * from SecretStorage on its first SDK request — never at activate.
   * Call `aiClient.invalidate()` when `sandforge.ai.*` settings change so
   * the next call rebuilds adapters from the current provider/model.
   */
  aiClient: AIClientFactory;
  /**
   * True when AI features are enabled via the `sandforge.ai.enabled`
   * setting (default false). Read at call time so setting changes take
   * effect without a reload.
   */
  isAIEnabled: () => boolean;
  /**
   * Read a `sandforge.*` VS Code setting (e.g. `'safety.auditLogging'`)
   * with the manifest default as fallback. Read at call time so setting
   * changes take effect without a reload. Handlers and core services use
   * this instead of importing `vscode` themselves (keeps them testable).
   */
  getSandforgeSetting: <T>(key: string, fallback: T) => T;
  /**
   * Build a fresh `SessionBudget` for an AI panel session. Caller is
   * responsible for attaching it to the adapter
   * (`services.aiClient().budget = sessionBudget`) on panel-open and
   * calling `sessionBudget.dispose()` on panel-close. Reads the current
   * `sandforge.ai.tokenBudgetMaxPerSession` setting at construction.
   */
  createSessionBudget: (sessionId: string, broker?: BudgetBroker) => SessionBudget;
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
 * move legacy credentials (globalState and legacy SecretStorage AI keys) into
 * their unified SecretStorage locations.
 *
 * @param context - The VSCode extension context.
 * @param opts - Optional TelemetryAdapter options (e.g. a Pino destination
 *   routed to the extension's OutputChannel instead of stdout).
 * @returns A fully wired Services object ready to be passed to handlers.
 */
export function createServices(
  context: vscode.ExtensionContext,
  opts?: TelemetryAdapterOptions,
): Services {
  const telemetry = new TelemetryAdapter(context, opts);
  const storage = new StorageAdapter(context);
  // `sandforge.api.retryAttempts` (manifest default 3) bounds p-retry attempts
  // on retriable Salesforce errors. Read once at composition; a reload picks
  // up changes (the adapter holds no per-call config).
  const apiRetryAttempts = vscode.workspace
    .getConfiguration('sandforge.api')
    .get<number>('retryAttempts', 3);
  const salesforce = new SalesforceAdapter(storage, telemetry, { retries: apiRetryAttempts });
  const fs = new FsAdapter(telemetry);

  const aiClient = createAIClientFactory({
    storage,
    telemetry,
    logger: telemetry.getLogger(),
    getProvider: () => {
      const cfg = vscode.workspace.getConfiguration('sandforge.ai');
      return (cfg.get<AIProviderType>('provider') ?? 'anthropic') as AIProviderType;
    },
    getModel: () => {
      const cfg = vscode.workspace.getConfiguration('sandforge.ai');
      return cfg.get<string>('model');
    },
  });

  const services: Services = {
    context,
    storage,
    telemetry,
    salesforce,
    fs,
    aiClient,
    isAIEnabled: () =>
      vscode.workspace.getConfiguration('sandforge.ai').get<boolean>('enabled', false),
    getSandforgeSetting: <T>(key: string, fallback: T): T =>
      vscode.workspace.getConfiguration('sandforge').get<T>(key, fallback),
    createSessionBudget: (sessionId, broker) => {
      const budget = vscode.workspace
        .getConfiguration('sandforge.ai')
        .get<number>('tokenBudgetMaxPerSession', 50_000);
      return new SessionBudget({
        sessionId,
        budget,
        broker,
        logger: telemetry.getLogger(),
      });
    },
    monitorOrchestrator: (deps) =>
      new MonitorOrchestrator({
        // `sandforge.monitor.persistTimeSeries` (manifest default off) feeds
        // TimeSeriesStore disk persistence. An explicit caller value wins.
        persistTimeSeries: vscode.workspace
          .getConfiguration('sandforge.monitor')
          .get<boolean>('persistTimeSeries', false),
        ...deps,
      }),
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

/** Unified SecretStorage key for the Anthropic API key (read by AnthropicAdapter). */
const AI_SECRET_KEY = 'sandforge.ai.anthropic.key';

/** Legacy globalState key holding the AI API key. */
const AI_SECRET_KEY_LEGACY_GLOBALSTATE = 'ai.apiKey';

/** Legacy SecretStorage keys holding the AI API key (migrated to AI_SECRET_KEY). */
const AI_SECRET_KEYS_LEGACY = ['sandforge.ai-api-key', 'sandforge.ai:apiKey', 'ai:apiKey'];

/**
 * Move a legacy SecretStorage key to the unified AI key.
 * Never overwrites an existing target value; the legacy key is deleted either
 * way so the migration is idempotent.
 *
 * @returns true when a legacy value existed (and was migrated or superseded).
 */
async function migrateLegacySecretKey(
  context: vscode.ExtensionContext,
  oldKey: string,
  newKey: string,
): Promise<boolean> {
  const value = await context.secrets.get(oldKey);
  if (value === undefined || value === null) {
    return false;
  }
  const existing = await context.secrets.get(newKey);
  if (existing === undefined || existing === null) {
    await context.secrets.store(newKey, value);
  }
  await context.secrets.delete(oldKey);
  return true;
}

/**
 * Silently move legacy credentials from `globalState` into `SecretStorage`.
 *
 * Targets:
 *  - `ai.apiKey` (globalState) → `sandforge.ai.anthropic.key`
 *  - legacy AI secret keys (`sandforge.ai-api-key`, `sandforge.ai:apiKey`,
 *    `ai:apiKey`) → `sandforge.ai.anthropic.key`
 *  - `sandforge.${orgId}.accessToken` → same key in SecretStorage
 *  - `sandforge.${orgId}.refreshToken` → same key in SecretStorage
 *
 * Idempotent: keys already migrated (i.e. absent in globalState / SecretStorage)
 * are skipped without failure. Emits a single telemetry breadcrumb summarising
 * the run.
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
    if (await storage.migrateLegacyKey(AI_SECRET_KEY_LEGACY_GLOBALSTATE, AI_SECRET_KEY, true)) {
      count++;
    }

    // Legacy SecretStorage AI keys. `sandforge.ai-api-key` was written through
    // SecretVault (prefix `sandforge.` + `ai-api-key`); `sandforge.ai:apiKey`
    // is the prefixed form of the `ai:apiKey` key SeedOpsHandler used to read.
    for (const oldKey of AI_SECRET_KEYS_LEGACY) {
      if (await migrateLegacySecretKey(context, oldKey, AI_SECRET_KEY)) {
        count++;
      }
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
