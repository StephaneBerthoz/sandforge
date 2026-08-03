import type { BaseMessage, SyncScheduleEntry } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
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
 * Note: this handler only wires the CRUD surface used by SyncSchedulePanel.
 * The 60s tick loop that would actually *execute* due schedules is not started
 * here — that belongs to the composition root (extension.ts), together with a
 * real `onExecute` bridge to the sync engine.
 */
export class SyncScheduleHandler implements DomainHandler {
  private executor?: SyncScheduleExecutor;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
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
   * kept (the tick loop is composition-root wiring, not handler scope).
   */
  private getExecutor(): SyncScheduleExecutor {
    if (!this.executor) {
      const executor = new SyncScheduleExecutor({
        scheduleStore: new SyncScheduleStore(this.deps.configStore),
        configStore: new SyncConfigStore(this.deps.configStore),
        onExecute: () =>
          Promise.reject(new Error('Scheduled sync execution is not wired to the sync engine yet')),
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

  /** List all sync schedules. */
  private handleList(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const schedules = this.getExecutor().getSchedules();
      const response = buildResponse(this.deps, msg, 'sync:schedule:list:response', {
        schedules: schedules as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:schedule:list', 'sync:schedule:error', err);
    }
  }

  /**
   * Create or update a schedule.
   * Payload: { schedule: Omit<SyncScheduleEntry, 'nextRunAt'|'lastRunAt'|'lastResult'> }
   */
  private handleUpsert(msg: BaseMessage): void {
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
      sendHandlerError(this.deps, 'sync:schedule:upsert', 'sync:schedule:error', err);
    }
  }

  /**
   * Enable or pause a schedule.
   * Payload: { scheduleId, enabled }
   */
  private handleToggle(msg: BaseMessage): void {
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
          new Error(`Schedule not found: ${parsed.scheduleId}`),
          'NOT_FOUND',
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
      sendHandlerError(this.deps, 'sync:schedule:toggle', 'sync:schedule:error', err);
    }
  }

  /**
   * Delete a schedule permanently.
   * Payload: { scheduleId }
   */
  private handleDelete(msg: BaseMessage): void {
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
      sendHandlerError(this.deps, 'sync:schedule:delete', 'sync:schedule:error', err);
    }
  }
}
