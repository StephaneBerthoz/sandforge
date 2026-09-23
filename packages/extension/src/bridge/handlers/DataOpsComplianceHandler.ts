import { randomBytes } from 'node:crypto';

import type {
  SubjectIdentifierKind,
  SubjectIdentifiers,
  SubjectSearchResult,
} from '@sandforge/shared';
import { SUBJECT_SEARCH_LIMIT } from '@sandforge/shared';

import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { runGuardedRemoval } from './guardedRemoval.js';
import {
  dataOpsPiiInventoryPayloadSchema,
  dataOpsSubjectErasePayloadSchema,
  dataOpsSubjectRequestPayloadSchema,
  dataOpsSubjectSearchPayloadSchema,
  validatePayload,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { AnonymizationEngine } from '../../modules/dataops/AnonymizationEngine.js';
import { describedObjectSchema } from '../../modules/dataops/DataQualityScanner.js';
import { inventoryPersonalData } from '../../modules/dataops/PersonalDataInventory.js';
import type { OrgSession } from '../../modules/dataops/RecordRemoval.js';
import { orgSession, readRecordsById } from '../../modules/dataops/RecordRemoval.js';
import { prepareErasure, runErasure } from '../../modules/dataops/SubjectErasure.js';
import { SubjectRequestLog } from '../../modules/dataops/SubjectRequestLog.js';
import { searchSubject } from '../../modules/dataops/SubjectSearch.js';

/** Message types handled by DataOpsComplianceHandler. */
const COMPLIANCE_TYPES = new Set([
  'dataops:pii-inventory',
  'dataops:dsr:search',
  'dataops:dsr:export',
  'dataops:dsr:erase',
  'dataops:dsr:log',
]);

/**
 * Requests whose found records are held for their export and erasure. Held
 * in memory, for the life of the window: the log keeps no record Id, and a
 * request found in an earlier session is searched again.
 */
const HELD_REQUESTS = 20;

/** The records one request found, per object. */
interface FoundRecords {
  orgId: string;
  objects: Map<string, Set<string>>;
}

/** The kinds of identifier a search was given, never the identifiers. */
function kindsOf(identifiers: SubjectIdentifiers): SubjectIdentifierKind[] {
  return (['email', 'name', 'phone'] as const).filter((kind) => identifiers[kind] !== undefined);
}

/**
 * The Compliance tab of DataOps: the personal-data inventory, and the data
 * subject requests — find one person's records, export them, erase them —
 * with the local log of what was done for each request.
 *
 * Nothing searched for is logged or kept past the request that carried it:
 * the extension log names objects and counts, the subject request log the
 * same, and the records found are held in memory by Id, for the window's
 * life, so an export or an erasure can only ever act on what a search found.
 */
export class DataOpsComplianceHandler implements DomainHandler {
  /** What each recent request found, the oldest first. */
  private readonly found = new Map<string, FoundRecords>();

  /**
   * The key the anonymizer draws made-up values with: one per window, never
   * stored, so an erased record's replacement cannot be traced back to it by
   * anyone who reads the workspace.
   */
  private readonly maskingKey = randomBytes(32).toString('hex');

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

  /** The local log of subject requests. */
  private get requestLog(): SubjectRequestLog {
    return new SubjectRequestLog(this.deps.configStore);
  }

  /** The detector the Seed and Sync pre-flight runs. */
  private get detector(): PIIDetector {
    return this.deps.infraServices?.piiDetector ?? new PIIDetector();
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
    if (!COMPLIANCE_TYPES.has(msg.type)) return false;
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    switch (msg.type) {
      case 'dataops:pii-inventory':
        await this.handleInventory(msg);
        return true;
      case 'dataops:dsr:search':
        await this.handleSearch(msg);
        return true;
      case 'dataops:dsr:export':
        await this.handleExport(msg);
        return true;
      case 'dataops:dsr:erase':
        await this.handleErase(msg);
        return true;
      default:
        this.handleLog(msg);
        return true;
    }
  }

  /**
   * Answer `dataops:pii-inventory`: the fields of each object the detector
   * names, confirmed on a sample. Reads only, so it takes no guard.
   */
  private async handleInventory(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsPiiInventoryPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const session = await this.session(parsed.orgId, 'dataops:pii-inventory');
      const result = await inventoryPersonalData(session, this.detector, parsed);
      const response = buildResponse(this.deps, msg, 'dataops:pii-inventory:response', {
        ...result,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${result.objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:pii-inventory', 'dataops:error', msg, err);
    }
  }

  /**
   * Answer `dataops:dsr:search`. A search opens a request in the log, or adds
   * to the one it names, and holds what it found for the export and the
   * erasure. The log line names the objects, never what was searched for.
   */
  private async handleSearch(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsSubjectSearchPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const { orgId, objects } = parsed;
    const identifiers: SubjectIdentifiers = {
      ...(parsed.email !== undefined ? { email: parsed.email } : {}),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
    };
    try {
      const session = await this.session(orgId, 'dataops:dsr:search');
      const searched = await searchSubject(session, {
        objects,
        identifiers,
        limit: SUBJECT_SEARCH_LIMIT,
      });
      const log = this.requestLog;
      const requestId =
        parsed.requestId !== undefined && log.has(parsed.requestId, orgId)
          ? parsed.requestId
          : crypto.randomUUID();
      const searchedAt = new Date().toISOString();

      const held: FoundRecords = { orgId, objects: new Map() };
      for (const object of searched) {
        if (object.status !== 'searched') continue;
        held.objects.set(object.objectApiName, new Set(object.records.map((r) => r.id)));
      }
      this.hold(requestId, held);
      log.record(requestId, orgId, {
        kind: 'searched',
        at: searchedAt,
        searchedBy: kindsOf(identifiers),
        objects: searched.flatMap((o) =>
          o.status === 'searched'
            ? [{ objectApiName: o.objectApiName, found: o.records.length, truncated: o.truncated }]
            : [],
        ),
      });

      const result: SubjectSearchResult = {
        requestId,
        orgId,
        searchedAt,
        limit: SUBJECT_SEARCH_LIMIT,
        objects: searched,
      };
      const response = buildResponse(this.deps, msg, 'dataops:dsr:search:response', { ...result });
      this.deps.broker.postToWebview(response);
      const total = [...held.objects.values()].reduce((sum, ids) => sum + ids.size, 0);
      this.deps.log(`[TX] ${response.type} id=${response.id} records=${total}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:dsr:search', 'dataops:error', msg, err);
    }
  }

  /** Keep what a request found, dropping the oldest request past the bound. */
  private hold(requestId: string, found: FoundRecords): void {
    this.found.delete(requestId);
    this.found.set(requestId, found);
    while (this.found.size > HELD_REQUESTS) {
      const oldest = this.found.keys().next().value;
      if (oldest === undefined) break;
      this.found.delete(oldest);
    }
  }

  /** What a request found on an org, or why there is nothing to act on. */
  private heldFor(requestId: string, orgId: string): FoundRecords {
    const held = this.found.get(requestId);
    if (!held || held.orgId !== orgId) {
      throw new Error(
        'This request has found nothing in this window. Search again: an export or an ' +
          'erasure only acts on the records a search found.',
      );
    }
    return held;
  }

  /**
   * Answer `dataops:dsr:export`: every field of the records the request found,
   * written to a JSON file the user picks. The records are read and written
   * here and never cross the bridge; the log records the export only once the
   * file is written.
   */
  private async handleExport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsSubjectRequestPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const held = this.heldFor(parsed.requestId, parsed.orgId);
      const session = await this.session(parsed.orgId, 'dataops:dsr:export');
      const objects: Record<string, Array<Record<string, unknown>>> = {};
      let records = 0;
      for (const [objectApiName, ids] of held.objects) {
        if (ids.size === 0) continue;
        const described = describedObjectSchema.parse(await session.describe(objectApiName));
        const read = await readRecordsById(
          session,
          described.name,
          described.fields.map((f) => f.name),
          [...ids],
        );
        objects[objectApiName] = read;
        records += read.length;
      }
      const exportedAt = new Date().toISOString();
      const document = {
        sandforgeSubjectRequestVersion: 1,
        requestId: parsed.requestId,
        orgId: parsed.orgId,
        exportedAt,
        objects,
      };
      const saved = await this.saveDialog.save(
        `sandforge-subject-request-${parsed.requestId.slice(0, 8)}.json`,
        JSON.stringify(document, null, 2),
        ['json'],
      );
      if (saved.status === 'saved') {
        this.requestLog.record(parsed.requestId, parsed.orgId, {
          kind: 'exported',
          at: exportedAt,
          records,
        });
      }
      const response = buildResponse(this.deps, msg, 'dataops:dsr:export:response', {
        requestId: parsed.requestId,
        records,
        saved,
      });
      this.deps.broker.postToWebview(response);
      // Neither the path nor a value: where a person keeps an export is theirs.
      this.deps.log(`[TX] ${response.type} id=${response.id} ${saved.status} records=${records}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:dsr:export', 'dataops:error', msg, err);
    }
  }

  /**
   * Answer `dataops:dsr:erase`: plan the erasure, and — unless it is a dry run
   * — carry it out through Production Guard, recording it in the audit trail
   * and in the request's log entry.
   */
  private async handleErase(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsSubjectErasePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const { orgId, requestId, mode, dryRun } = parsed;
    try {
      const held = this.heldFor(requestId, orgId);
      const strangers = parsed.records.reduce((sum, target) => {
        const found = held.objects.get(target.objectApiName);
        return sum + target.ids.filter((id) => !found?.has(id)).length;
      }, 0);
      if (strangers > 0) {
        throw new Error(
          `${strangers} of the records to erase were not found by this request. Search again, ` +
            'and erase from what the search lists.',
        );
      }

      const session = await this.session(orgId, 'dataops:dsr:erase');
      const prepared = await prepareErasure(session, this.detector, mode, parsed.records);
      const plan = prepared.map((p) => p.plan);
      if (dryRun) {
        const response = buildResponse(this.deps, msg, 'dataops:dsr:erase:response', {
          requestId,
          mode,
          dryRun,
          plan,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} plan objects=${plan.length}`);
        return;
      }

      const acting = plan.filter((p) => !p.refused && p.records > 0);
      const recordCount = acting.reduce((sum, p) => sum + p.records, 0);
      if (recordCount === 0) {
        const reasons = plan.flatMap((p) => (p.refused ? [p.refused] : []));
        throw new Error(
          reasons.length > 0
            ? `Nothing can be erased. ${reasons.join(' ')}`
            : 'Nothing is left to erase: the records found are no longer in the org.',
        );
      }

      const engine = new AnonymizationEngine(undefined, this.maskingKey);
      const result = await runGuardedRemoval(this.deps, {
        orgId,
        operation: mode === 'delete' ? 'delete' : 'update',
        objectNames: acting.map((p) => p.objectApiName),
        recordCount,
        action: 'subject_erase',
        description: `Erase ${recordCount} record(s) of a subject request`,
        origin: 'dataops:dsr:erase',
        run: (onObject) => runErasure(session, engine, prepared, onObject),
      });

      const at = new Date().toISOString();
      if (!result.ran) {
        this.requestLog.record(requestId, orgId, {
          kind: 'erased',
          at,
          mode,
          outcome: 'stopped',
          operationId: result.operationId,
          objects: [],
        });
        sendHandlerError(
          this.deps,
          'dataops:dsr:erase',
          'dataops:error',
          msg,
          new Error(result.message),
          result.code ? { code: result.code } : undefined,
        );
        return;
      }
      this.requestLog.record(requestId, orgId, {
        kind: 'erased',
        at,
        mode,
        outcome: result.outcome.status,
        operationId: result.operationId,
        objects: result.outcome.objects,
      });
      if (result.error !== undefined) {
        // Stopped half way: logged with what it had written, and said as the
        // failure it is.
        sendHandlerError(
          this.deps,
          'dataops:dsr:erase',
          'dataops:error',
          msg,
          new Error(result.error),
        );
        return;
      }
      const response = buildResponse(this.deps, msg, 'dataops:dsr:erase:response', {
        requestId,
        mode,
        dryRun,
        plan,
        outcome: result.outcome,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} ${result.outcome.status} ` +
          `done=${result.outcome.done} failed=${result.outcome.failed}`,
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:dsr:erase', 'dataops:error', msg, err);
    }
  }

  /** Answer `dataops:dsr:log`: every request, the newest first. */
  private handleLog(msg: InboundRequest): void {
    try {
      const entries = this.requestLog.list();
      const response = buildResponse(this.deps, msg, 'dataops:dsr:log:response', { entries });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} entries=${entries.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:dsr:log', 'dataops:error', msg, err);
    }
  }
}
