import type { CleanupRecommendation, RemovalPlanObject } from '@sandforge/shared';
import { CLEANUP_ACTION_LIMIT } from '@sandforge/shared';

import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { runGuardedRemoval } from './guardedRemoval.js';
import {
  dataOpsCleanupDeletePayloadSchema,
  dataOpsCleanupExportPayloadSchema,
  dataOpsQualityScanPayloadSchema,
  validatePayload,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { resolveRecommendation, scanCleanup } from '../../modules/dataops/CleanupScanner.js';
import type { OrgSession } from '../../modules/dataops/RecordRemoval.js';
import {
  countRelated,
  deleteRecords,
  orgSession,
  readRecordsById,
  workedObjects,
} from '../../modules/dataops/RecordRemoval.js';

/** Message types handled by DataOpsCleanupHandler. */
const CLEANUP_TYPES = new Set([
  'dataops:cleanup:scan',
  'dataops:cleanup:export',
  'dataops:cleanup:delete',
]);

/** A recommendation in a few words, for the file name and the log: never a value. */
function recommendationTag(recommendation: CleanupRecommendation): string {
  switch (recommendation.kind) {
    case 'stale':
      return `stale-${recommendation.days}d`;
    case 'orphans':
      return `orphans-${recommendation.fieldApiName}`;
    default:
      return `duplicates-${recommendation.keyField}`;
  }
}

/**
 * The Cleanup tab of DataOps: what a cleanup would look at — stale records,
 * orphans of a lookup the business relies on, repeated values of a key — and
 * the export and the delete of the records one recommendation names.
 *
 * The scan counts; an export reads; a delete goes through Production Guard,
 * after a dry run that says how many records it takes and what the org
 * deletes along with them, and is recorded in the audit trail.
 */
export class DataOpsCleanupHandler implements DomainHandler {
  private readonly saveDialog: SaveDialogAdapter;

  /**
   * @param deps - Injected handler dependencies.
   * @param saveDialog - Injected for tests; defaults to the real VS Code dialog.
   */
  constructor(
    private readonly deps: HandlerDeps,
    saveDialog?: SaveDialogAdapter,
  ) {
    this.saveDialog = saveDialog ?? new SaveDialogAdapter();
  }

  private async session(orgId: string, context: string): Promise<OrgSession> {
    const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
    return orgSession(conn, context);
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!CLEANUP_TYPES.has(msg.type)) return false;
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    switch (msg.type) {
      case 'dataops:cleanup:scan':
        await this.handleScan(msg);
        return true;
      case 'dataops:cleanup:export':
        await this.handleExport(msg);
        return true;
      default:
        await this.handleDelete(msg);
        return true;
    }
  }

  /**
   * Answer `dataops:cleanup:scan`: counts only, so it takes no guard. The
   * request is the quality scan's own — the objects, a duplicate key each,
   * the staleness threshold — and is held to the same schema.
   */
  private async handleScan(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsQualityScanPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const session = await this.session(parsed.orgId, 'dataops:cleanup:scan');
      const result = await scanCleanup(session, parsed);
      const response = buildResponse(this.deps, msg, 'dataops:cleanup:scan:response', {
        ...result,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${result.objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:cleanup:scan', 'dataops:error', msg, err);
    }
  }

  /**
   * Answer `dataops:cleanup:export`: every field of the records one
   * recommendation names — at most {@link CLEANUP_ACTION_LIMIT} — written to a
   * JSON file the user picks. A copy to keep before a delete.
   */
  private async handleExport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsCleanupExportPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const session = await this.session(parsed.orgId, 'dataops:cleanup:export');
      const resolved = await resolveRecommendation(
        session,
        parsed.objectApiName,
        parsed.recommendation,
        CLEANUP_ACTION_LIMIT,
      );
      const records = await readRecordsById(
        session,
        resolved.object.name,
        resolved.object.fields.map((f) => f.name),
        resolved.ids,
      );
      const exportedAt = new Date().toISOString();
      const document = {
        sandforgeCleanupVersion: 1,
        orgId: parsed.orgId,
        objectApiName: resolved.object.name,
        recommendation: parsed.recommendation,
        exportedAt,
        recommended: resolved.total,
        records,
      };
      const saved = await this.saveDialog.save(
        `sandforge-cleanup-${resolved.object.name}-${recommendationTag(parsed.recommendation)}.json`,
        JSON.stringify(document, null, 2),
        ['json'],
      );
      const response = buildResponse(this.deps, msg, 'dataops:cleanup:export:response', {
        objectApiName: parsed.objectApiName,
        records: records.length,
        truncated: resolved.truncated,
        saved,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} ${saved.status} records=${records.length}`,
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:cleanup:export', 'dataops:error', msg, err);
    }
  }

  /**
   * Answer `dataops:cleanup:delete`. The dry run reads the records the
   * recommendation names and counts what the org would delete along with
   * them; the run reads them again — the org may have changed since — and
   * deletes them through Production Guard.
   */
  private async handleDelete(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsCleanupDeletePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const { orgId, recommendation, dryRun } = parsed;
    try {
      const session = await this.session(orgId, 'dataops:cleanup:delete');
      const resolved = await resolveRecommendation(
        session,
        parsed.objectApiName,
        recommendation,
        CLEANUP_ACTION_LIMIT,
      );
      const { object, ids } = resolved;
      if (object.deletable !== true) {
        throw new Error(`The connected user may not delete ${object.label} records.`);
      }

      if (dryRun) {
        const related = await countRelated(session, object, ids, await workedObjects(session));
        const plan: RemovalPlanObject = {
          objectApiName: object.name,
          label: object.label,
          records: ids.length,
          related: related.related,
          uncounted: related.uncounted,
        };
        const response = buildResponse(this.deps, msg, 'dataops:cleanup:delete:response', {
          objectApiName: parsed.objectApiName,
          dryRun,
          plan,
          truncated: resolved.truncated,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} plan records=${ids.length}`);
        return;
      }

      if (ids.length === 0) {
        throw new Error(`No ${object.label} record is left to delete for this recommendation.`);
      }
      const plan: RemovalPlanObject = {
        objectApiName: object.name,
        label: object.label,
        records: ids.length,
      };
      const result = await runGuardedRemoval(this.deps, {
        orgId,
        operation: 'delete',
        objectNames: [object.name],
        recordCount: ids.length,
        action: 'cleanup_delete',
        description: `Delete ${ids.length} ${object.name} record(s): ${recommendationTag(recommendation)}`,
        origin: 'dataops:cleanup:delete',
        run: async (onObject) => {
          const counts = await deleteRecords(session, object.name, ids);
          onObject(object.name, counts);
          return [{ objectApiName: object.name, counts }];
        },
      });
      if (!result.ran) {
        sendHandlerError(
          this.deps,
          'dataops:cleanup:delete',
          'dataops:error',
          msg,
          new Error(result.message),
        );
        return;
      }
      if (result.error !== undefined) {
        sendHandlerError(
          this.deps,
          'dataops:cleanup:delete',
          'dataops:error',
          msg,
          new Error(result.error),
        );
        return;
      }
      const response = buildResponse(this.deps, msg, 'dataops:cleanup:delete:response', {
        objectApiName: parsed.objectApiName,
        dryRun,
        plan,
        truncated: resolved.truncated,
        outcome: result.outcome,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} ${result.outcome.status} ` +
          `deleted=${result.outcome.done} failed=${result.outcome.failed}`,
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:cleanup:delete', 'dataops:error', msg, err);
    }
  }
}
