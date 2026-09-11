import type { SyncScheduleEntry } from '@sandforge/shared';
import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  syncScheduleUpsertPayloadSchema,
  syncScheduleTogglePayloadSchema,
  syncScheduleIdPayloadSchema,
} from '../validatePayload.js';
import { SyncScheduleExecutor } from '../../modules/sync/SyncScheduleExecutor.js';
import { SyncScheduleStore } from '../../modules/sync/SyncScheduleStore.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';

/** Message types handled by SyncScheduleHandler. */
const SYNC_SCHEDULE_TYPES = new Set([
  'sync:schedule:list',
  'sync:schedule:upsert',
  'sync:schedule:toggle',
  'sync:schedule:delete',
]);

/**
 * Domain handler for sync schedule CRUD webview-to-extension messages.
 *
 * Delegates persistence and cron next-run computation to SyncScheduleExecutor
 * (backed by SyncScheduleStore over ConfigStore). Response payloads are a
 * superset of the shared message types (`success`, `schedule`) plus the flat
 * fields the current webview store reads (`scheduleId`, `enabled`).
 *
 * The 60 s tick loop that actually *executes* due schedules is started by the
 * composition root: extension.ts calls `ExtensionHandlers.startSyncScheduler()`
 * which injects the real execution bridge ({@link startScheduler}) delegating
 * to `SyncOpsHandler.executeScheduled`. Until then the CRUD surface works but
 * due schedules reject with a "not wired" error.
 */
export class SyncScheduleHandler implements DomainHandler {
  private executor?: SyncScheduleExecutor;

  /**
   * Real execution bridge injected by the composition root. Undefined until
   * `startScheduler` is called (tests, partial wiring).
   */
  private executeBridge?: (config: SyncConfig) => Promise<SyncExecutionResult>;

  /** Number of scheduled executions currently in flight (concurrency cap). */
  private inFlight = 0;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SYNC_SCHEDULE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'sync:schedule:list':
        this.handleList(msg);
        return true;
      case 'sync:schedule:upsert':
        this.handleUpsert(msg);
        return true;
      case 'sync:schedule:toggle':
        this.handleToggle(msg);
        return true;
      case 'sync:schedule:delete':
        this.handleDelete(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Lazily create the executor and hydrate its in-memory map from the store.
   *
   * `start()` loads persisted entries and begins the tick loop; the immediate
   * `stop()` tears the loop down again so only the hydration side effect is
   * kept (the tick loop is started by the composition root via
   * {@link startScheduler}, not by message handling).
   */
  private getExecutor(): SyncScheduleExecutor {
    if (!this.executor) {
      const executor = new SyncScheduleExecutor({
        scheduleStore: new SyncScheduleStore(this.deps.configStore),
        configStore: new SyncConfigStore(this.deps.configStore),
        onExecute: (config) => this.executeDue(config),
        notificationCenter: {
          notify: (level: string, title: string, message: string) => {
            this.deps.log(`[SyncSchedule] ${level}: ${title} — ${message}`);
          },
        },
        log: this.deps.log,
      });
      executor.start();
      executor.stop();
      this.executor = executor;
    }
    return this.executor;
  }

  /**
   * Bridge from SyncScheduleExecutor to the sync engine.
   *
   * Rejects while the composition root has not wired the real bridge
   * (`startScheduler`), and caps concurrent scheduled executions at the
   * `sandforge.sync.maxConcurrentOps` setting — a tick that fires while a
   * previous scheduled run is still in flight skips the new run instead of
   * stacking Bulk API jobs.
   */
  private async executeDue(config: SyncConfig): Promise<SyncExecutionResult> {
    if (!this.executeBridge) {
      throw new Error('Scheduled sync execution is not wired to the sync engine yet');
    }
    const maxConcurrent =
      this.deps.services?.getSandforgeSetting?.('sync.maxConcurrentOps', 3) ?? 3;
    if (this.inFlight >= maxConcurrent) {
      throw new Error(
        `Scheduled sync skipped: ${this.inFlight} execution(s) already in flight (max ${maxConcurrent})`,
      );
    }
    this.inFlight++;
    try {
      return await this.executeBridge(config);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Wire the real sync execution bridge and start the 60 s tick loop.
   * Called once from the composition root (`ExtensionHandlers.startSyncScheduler`).
   * Idempotent — SyncScheduleExecutor.start() is a no-op when already running.
   *
   * @param execute - Executes a due schedule's sync config (SyncOpsHandler.executeScheduled).
   */
  startScheduler(execute: (config: SyncConfig) => Promise<SyncExecutionResult>): void {
    this.executeBridge = execute;
    this.getExecutor().start();
    this.deps.log('[SyncScheduleHandler] scheduler started (tick loop running)');
  }

  /**
   * Stop the tick loop. Idempotent; safe to call from extension deactivate.
   * In-flight executions are not aborted — they complete on their own.
   */
  stopScheduler(): void {
    this.executor?.stop();
  }

  /** List all sync schedules. */
  private handleList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const schedules = this.getExecutor().getSchedules();
      const response = buildResponse(this.deps, msg, 'sync:schedule:list:response', {
        schedules: schedules as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:schedule:list', 'sync:schedule:error', msg, err);
    }
  }

  /**
   * Create or update a schedule.
   * Payload: { schedule: Omit<SyncScheduleEntry, 'nextRunAt'|'lastRunAt'|'lastResult'> }
   */
  private handleUpsert(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncScheduleUpsertPayloadSchema,
      msg,
      'sync:schedule:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const entry = this.getExecutor().upsert(
        parsed.schedule as Omit<SyncScheduleEntry, 'nextRunAt' | 'lastRunAt' | 'lastResult'>,
      );
      const response = buildResponse(this.deps, msg, 'sync:schedule:upsert:response', {
        success: true,
        schedule: entry as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:schedule:upsert', 'sync:schedule:error', msg, err);
    }
  }

  /**
   * Enable or pause a schedule.
   * Payload: { scheduleId, enabled }
   */
  private handleToggle(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncScheduleTogglePayloadSchema,
      msg,
      'sync:schedule:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const entry = this.getExecutor().toggle(parsed.scheduleId, parsed.enabled);
      if (!entry) {
        sendHandlerError(
          this.deps,
          'sync:schedule:toggle',
          'sync:schedule:error',
          msg,
          new Error(`Schedule not found: ${parsed.scheduleId}`),
          { code: 'NOT_FOUND' },
        );
        return;
      }
      const response = buildResponse(this.deps, msg, 'sync:schedule:toggle:response', {
        success: true,
        schedule: entry as unknown as Record<string, unknown>,
        scheduleId: parsed.scheduleId,
        enabled: parsed.enabled,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:schedule:toggle', 'sync:schedule:error', msg, err);
    }
  }

  /**
   * Delete a schedule permanently.
   * Payload: { scheduleId }
   */
  private handleDelete(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncScheduleIdPayloadSchema,
      msg,
      'sync:schedule:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const existed = this.getExecutor().delete(parsed.scheduleId);
      const response = buildResponse(this.deps, msg, 'sync:schedule:delete:response', {
        success: existed,
        scheduleId: parsed.scheduleId,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:schedule:delete', 'sync:schedule:error', msg, err);
    }
  }
}
