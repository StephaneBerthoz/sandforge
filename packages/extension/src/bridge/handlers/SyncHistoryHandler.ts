import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import type { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import type { SyncOpsHandler } from './SyncOpsHandler.js';
import {
  validatePayload,
  syncHistoryEntryIdPayloadSchema,
  syncHistoryExportPayloadSchema,
} from '../validatePayload.js';

/** Message types handled by SyncHistoryHandler. */
const SYNC_HISTORY_TYPES = new Set([
  'sync:history:list',
  'sync:history:detail',
  'sync:history:rerun',
  'sync:history:export',
]);

/**
 * Domain handler for the sync execution-history read surface.
 *
 * Reads from the shared {@link SyncHistoryStore} (written by SyncOpsHandler
 * via SyncExecutionLogger) and answers the exact channels consumed by
 * `useSyncHistoryStore`:
 *   sync:history:list    -> sync:history:list:response    { entries }
 *   sync:history:detail  -> sync:history:detail:response  { entry | null }
 *   sync:history:export  -> sync:history:export:response  { data, format }
 *   sync:history:rerun   -> delegates to SyncOpsHandler.rerunFromSnapshot
 * Failures are reported on `sync:history:error` (the store reads payload.message).
 */
export class SyncHistoryHandler implements DomainHandler {
  /**
   * @param deps - Injected handler dependencies.
   * @param historyStore - Shared history store (same instance SyncOpsHandler writes to).
   * @param syncOps - Sync handler owning the execution engine (rerun delegation).
   */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly historyStore: SyncHistoryStore,
    private readonly syncOps: SyncOpsHandler,
  ) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SYNC_HISTORY_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'sync:history:list':
        this.handleList(msg);
        return true;
      case 'sync:history:detail':
        this.handleDetail(msg);
        return true;
      case 'sync:history:export':
        this.handleExport(msg);
        return true;
      case 'sync:history:rerun':
        await this.handleRerun(msg);
        return true;
      default:
        return false;
    }
  }

  /** List all history entries (newest first). */
  private handleList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const entries = this.historyStore.list();
      const response = buildResponse(this.deps, msg, 'sync:history:list:response', {
        entries: entries as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} count=${entries.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:history:list', 'sync:history:error', msg, err);
    }
  }

  /** Load a single history entry by ID (null when unknown). */
  private handleDetail(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncHistoryEntryIdPayloadSchema,
      msg,
      'sync:history:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const entry = this.historyStore.load(parsed.entryId) ?? null;
      const response = buildResponse(this.deps, msg, 'sync:history:detail:response', {
        entry: entry as unknown as Record<string, unknown> | null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:history:detail', 'sync:history:error', msg, err);
    }
  }

  /** Export history entries as CSV or JSON (the webview triggers the download). */
  private handleExport(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncHistoryExportPayloadSchema,
      msg,
      'sync:history:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const data =
        parsed.format === 'csv'
          ? this.historyStore.exportAsCsv(parsed.entryIds)
          : this.historyStore.exportAsJson(parsed.entryIds);
      const response = buildResponse(this.deps, msg, 'sync:history:export:response', {
        data,
        format: parsed.format,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} format=${parsed.format}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:history:export', 'sync:history:error', msg, err);
    }
  }

  /**
   * Re-run a sync from a history entry's config snapshot.
   *
   * Delegates to {@link SyncOpsHandler.rerunFromSnapshot}, which re-validates
   * the snapshot and starts a regular (detached) sync execution stamped
   * `triggeredBy: 'rerun'`. Unknown entry ids are answered on the
   * `sync:history:error` channel.
   */
  private async handleRerun(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncHistoryEntryIdPayloadSchema,
      msg,
      'sync:history:error',
      this.deps,
    );
    if (!parsed) return;
    const entry = this.historyStore.load(parsed.entryId);
    if (!entry) {
      sendHandlerError(
        this.deps,
        'sync:history:rerun',
        'sync:history:error',
        msg,
        new Error(`History entry not found: ${parsed.entryId}`),
        { code: 'NOT_FOUND' },
      );
      return;
    }
    await this.syncOps.rerunFromSnapshot(msg, entry.configSnapshot);
  }
}
