import type { CleanupRecommendation, RemovalPlanObject } from '@sandforge/shared';
import { CLEANUP_ACTION_LIMIT, guardTierOf } from '@sandforge/shared';

import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { runGuardedRemoval } from './guardedRemoval.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
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
import {
  dataOpsAutomationOrgOf,
  dataOpsStop,
  holdDataOpsMute,
  readDataOpsAct,
} from '../../modules/dataops/dataOpsAutomation.js';
import { muteLines, type MuteLeaseOptions } from '../../modules/forge/AutomationMuteLease.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';

/** How long the read of what the org runs may take before a delete: Seed's and Forge's bound. */
const AUTOMATION_TIMEOUT_MS = 60_000;

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
  /** The Monitor's Live Operations, which list a delete while it runs, with its Cancel. */
  private liveTracker?: LiveOperationTracker;

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

  /** Inject the tracker the Monitor's Live Operations lists runs from. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Reads what the org runs as a cleanup deletes its records: a reader of
   * the handler's own over its connections, as Forge reads it, loaded on its
   * first read.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };

  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

  /** Where and how a delete that mutes keeps its lease, when not the home directory's. */
  private muteLeases: MuteLeaseOptions = {};

  /** Another reader of what the org runs than the handler's own. */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** Where and how a delete that mutes keeps its lease, in place of the home directory's. */
  setMuteLeases(options: MuteLeaseOptions): void {
    this.muteLeases = options;
  }

  /** The handler's own reader of the org's automation, as Forge reads it. */
  private ownReader(): Promise<TargetAutomationReader> {
    this.reader ??= import('../../modules/forge/TargetAutomationReader.js').then(
      ({ TargetAutomationReader, targetAutomationQueries }) =>
        new TargetAutomationReader(
          targetAutomationQueries((orgId) =>
            getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager),
          ),
        ),
    );
    return this.reader;
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
      // What the org runs as the records go — a flow before a delete, a
      // trigger after it, the emails they send — read before the guard is
      // asked and before anything is deleted, and refused unless the page's
      // question answered it: a cleanup fired them with no question asked.
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const target = this.deps.orgManager.getOrg(orgId)?.alias ?? orgId;
      const reader = this.targetAutomation;
      const gated = await readDataOpsAct({
        act: 'cleanup',
        target,
        objects: [{ objectApiName: object.name, records: ids.length }],
        org: dataOpsAutomationOrgOf(
          conn,
          (names) =>
            new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('dataops automation', () =>
              reader.read(orgId, names),
            ),
          guardTierOf(this.deps.orgManager.getOrg(orgId)) === 'production',
        ),
        accord: parsed,
        mayMute: true,
        muteLeases: this.muteLeases,
      });
      const refused = dataOpsStop(gated.answer);
      if (refused) {
        sendHandlerError(
          this.deps,
          'dataops:cleanup:delete',
          'dataops:error',
          msg,
          new Error(refused.message),
          { code: refused.code },
        );
        return;
      }
      // The mute's lease, held from before the guard's question to the end
      // of the delete, given back however it ends.
      const holding = await holdDataOpsMute(gated, msg.id, parsed.acceptEmails === true);
      if ('refused' in holding) {
        sendHandlerError(
          this.deps,
          'dataops:cleanup:delete',
          'dataops:error',
          msg,
          new Error(holding.refused.message),
          { code: holding.refused.code },
        );
        return;
      }
      const held = holding.held;
      const plan: RemovalPlanObject = {
        objectApiName: object.name,
        label: object.label,
        records: ids.length,
      };
      const result = await runGuardedRemoval(
        this.deps,
        {
          orgId,
          operation: 'delete',
          objectNames: [object.name],
          recordCount: ids.length,
          action: 'cleanup_delete',
          description: `Delete ${ids.length} ${object.name} record(s): ${recommendationTag(recommendation)}`,
          origin: 'dataops:cleanup:delete',
          run: async (onObject, signal) => {
            const counts = await deleteRecords(session, object.name, ids, signal);
            onObject(object.name, counts);
            return [{ objectApiName: object.name, counts }];
          },
        },
        this.liveTracker,
      ).finally(async () => {
        if (!held) return;
        const released = await held.release();
        for (const line of muteLines(released, target)) this.deps.log(`[INFO] ${line}`);
      });
      if (!result.ran) {
        sendHandlerError(
          this.deps,
          'dataops:cleanup:delete',
          'dataops:error',
          msg,
          new Error(result.message),
          result.code ? { code: result.code } : undefined,
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
          result.cancelled ? { code: RUN_CANCELLED } : undefined,
        );
        return;
      }
      const response = buildResponse(this.deps, msg, 'dataops:cleanup:delete:response', {
        objectApiName: parsed.objectApiName,
        dryRun,
        plan,
        truncated: resolved.truncated,
        outcome: result.outcome,
        ...(held ? { mutedAutomation: held.outcome } : {}),
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
