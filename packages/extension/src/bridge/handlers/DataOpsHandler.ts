import { randomBytes } from 'node:crypto';

import type {
  AnonymizationRuleConfig,
  AnonymizationTemplateRule,
  AuditObjectCounts,
  BackupSummary,
  ListedAnonymizationTemplate,
} from '@sandforge/shared';
import {
  duplicateRuleHeaders,
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
} from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  sendHandlerError,
  PRODUCTION_GUARD_MISSING,
} from './HandlerTypes.js';
import type { Connection } from 'jsforce';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryAll, queryAllBounded } from '../../core/common/soqlQueryHelper.js';
import { CrudFlsGuard } from '../../core/metadata/CrudFlsGuard.js';
import type { ObjectDescribe } from '../../core/metadata/describeTypes.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import {
  validatePayload,
  dataOpsBackupPayloadSchema,
  dataOpsBackupListPayloadSchema,
  dataOpsBackupExportPayloadSchema,
  dataOpsRollbackPayloadSchema,
  dataOpsAnonymizePayloadSchema,
  dataOpsQualityScanPayloadSchema,
  anonymizationTemplateSavePayloadSchema,
  anonymizationTemplateDeletePayloadSchema,
  piiScanPayloadSchema,
} from '../validatePayload.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import type { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { scanDataQuality } from '../../modules/dataops/DataQualityScanner.js';
import { AnonymizationTemplateStore } from '../../modules/dataops/AnonymizationTemplateStore.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { isFilledValue } from '../../modules/dataops/personalDataFields.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { WriteRun } from '../../modules/audit/auditTrail.js';

/**
 * Convert a jsforce DescribeSObjectResult to the ObjectDescribe shape
 * expected by CrudFlsGuard.
 */
function describeToObjectDescribe(desc: Record<string, unknown>): ObjectDescribe {
  const fields = desc.fields as Array<Record<string, unknown>>;
  return {
    name: desc.name as string,
    label: desc.label as string,
    labelPlural: (desc.labelPlural as string) ?? '',
    keyPrefix: (desc.keyPrefix as string | null) ?? null,
    custom: (desc.custom as boolean) ?? false,
    createable: desc.createable as boolean,
    updateable: desc.updateable as boolean,
    deletable: desc.deletable as boolean,
    queryable: desc.queryable as boolean,
    fields: fields.map((f) => ({
      name: f.name as string,
      label: f.label as string,
      type: f.type as string,
      length: (f.length as number) ?? 0,
      nillable: (f.nillable as boolean) ?? false,
      createable: f.createable as boolean,
      updateable: f.updateable as boolean,
      externalId: (f.externalId as boolean) ?? false,
      referenceTo: (f.referenceTo as string[]) ?? [],
      relationshipName: (f.relationshipName as string | null) ?? null,
      picklistValues:
        (f.picklistValues as Array<{
          value: string;
          label: string;
          active: boolean;
          defaultValue: boolean;
        }>) ?? [],
      defaultValue: f.defaultValue ?? null,
      calculated: (f.calculated as boolean) ?? false,
      autoNumber: (f.autoNumber as boolean) ?? false,
      unique: (f.unique as boolean) ?? false,
      permissionable: (f.permissionable as boolean) ?? true,
    })),
    recordTypeInfos:
      (desc.recordTypeInfos as Array<{
        recordTypeId: string;
        name: string;
        developerName: string;
        active: boolean;
        defaultRecordTypeMapping: boolean;
      }>) ?? [],
    childRelationships:
      (desc.childRelationships as Array<{
        childSObject: string;
        field: string;
        relationshipName: string | null;
        cascadeDelete: boolean;
      }>) ?? [],
  };
}

/** Message types handled by DataOpsHandler. */
const DATAOPS_TYPES = new Set([
  'backup:execute',
  'backup:list',
  'backup:export',
  'dataops:rollback',
  'dataops:anonymize',
  'dataops:anonymization-templates',
  'dataops:quality-scan',
  'dataops:anonymization-template:save',
  'dataops:anonymization-template:delete',
  'precheck:pii-scan',
]);

/** How many rejected rows are echoed back: an org repeats a handful of reasons. */
const DML_ERROR_SAMPLE_LIMIT = 10;

/** A Salesforce org id, in its 15- or 18-character form. */
const ORG_ID_PATTERN = /^00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

/**
 * Whether two org ids name the same org: their first 15 characters, case
 * included. `Organization.Id` answers with 18, and the last three only
 * encode the case of the first fifteen.
 */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** The code of a restore refused because the org is no longer the one the backup was taken from. */
const ORG_REPLACED_SINCE_BACKUP = 'ORG_REPLACED_SINCE_BACKUP';

/** Why a snapshot a cancel stopped was not taken. */
const BACKUP_CANCELLED =
  'Backup was cancelled before it finished. Nothing was saved — run it again to take a complete snapshot.';

/**
 * The three words Seed, Sync and Clone already use for a write that did not
 * fully land. Reused here rather than invented: a restore or a masking run
 * that only partly succeeded is the same event those modules name `partial`.
 */
function dmlStatus(succeeded: number, failed: number): 'success' | 'partial' | 'failure' {
  if (failed === 0) return 'success';
  if (succeeded === 0) return 'failure';
  return 'partial';
}

/** Append a bounded sample of what the org said about a rejected row. */
function collectDmlError(
  sink: Array<{ objectApiName: string; message: string }>,
  objectApiName: string,
  errors: Array<{ message: string }> | undefined,
): void {
  if (sink.length >= DML_ERROR_SAMPLE_LIMIT) return;
  sink.push({ objectApiName, message: errors?.[0]?.message ?? 'Unknown DML error' });
}

/**
 * Objects a masking run addresses: the ones the request names, otherwise
 * the ones the template's rules address. Empty for an unknown template —
 * such a request stops at the template lookup, before any write.
 */
function plannedAnonymizeObjects(
  payload: { objects?: string[] },
  template: ListedAnonymizationTemplate | undefined,
): string[] {
  if (payload.objects) return payload.objects;
  if (!template) return [];
  return template.rules
    .map((r) => r.fieldPattern.split('.')[0])
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** A snapshot taken, as its metadata records it. */
export interface BackupTaken {
  operationId: string;
  /** Each object read, with the rows taken and whether a bound cut the read short. */
  objects: Array<{ objectApiName: string; recordCount: number; truncated: boolean }>;
  totalRecords: number;
  /** Whether any object stopped at a bound: the snapshot is only part of the org's data. */
  partial: boolean;
  timestamp: string;
}

/** A snapshot not taken: why, whether trying again may help, and what it was on. */
interface BackupNotTaken {
  error: unknown;
  retryable: boolean;
  context: OperationFailureContext;
  /** Whether a cancel stopped it, rather than a failure. */
  cancelled?: boolean;
}

/**
 * Domain handler for DataOps-related webview-to-extension messages.
 *
 * Manages backup, rollback, anonymization, anonymization templates,
 * data-quality scans and PII scanning operations.
 */
export class DataOpsHandler implements DomainHandler {
  /**
   * Set of orgId values currently involved in a rollback or backup operation.
   * Prevents concurrent operations from interleaving on the same org.
   */
  private readonly activeOrgOperations = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /**
   * File-backed store for backup record payloads.
   *
   * Present once composition supplies a storage path. Absent in tests and in
   * any host without one, where the ConfigStore path below still works.
   */
  private backupRecords?: BackupRecordStore;

  /**
   * HMAC key the masking engine falls back to for rules that carry no salt,
   * and the salt every hash rule is given (see `ruleConfig`).
   *
   * Held here rather than left to the engine, which mints a random one per
   * instance: a fresh engine per request meant two masking runs of the same
   * template replaced the same record with two different people, so nothing
   * the user saw in one run told them anything about the next. This handler is
   * built once per activation and shared by every panel, so the key is one per
   * window, and staying out of storage keeps the permutation from being
   * replayable by anyone who reads the workspace.
   */
  private readonly maskingKey = randomBytes(32).toString('hex');

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** The masking templates the user saved, kept in the config store. */
  private get savedTemplates(): AnonymizationTemplateStore {
    return new AnonymizationTemplateStore(this.deps.configStore);
  }

  /** A template that ships, or else one the user saved; undefined for an id neither holds. */
  private findTemplate(templateId: string): ListedAnonymizationTemplate | undefined {
    return (
      ANONYMIZATION_TEMPLATES.find((t) => t.id === templateId) ??
      this.savedTemplates.load(templateId)
    );
  }

  /**
   * What a template's rule hands the masking engine: the settings the
   * template gives it, and for a hash the window's key as its salt.
   *
   * Every rule used to go in with an empty configuration, so the CCPA and
   * HIPAA templates threw on their first email, which the engine will not hash
   * without a salt, and nothing was masked. No template carries a salt, and
   * none may: one written into a template is readable by everyone who has the
   * template. The window's key is the one the run's other keyed methods
   * already draw from, never written down, so an address gets the same digest
   * on every object of a run and on every run of the window, and another one
   * in the next window.
   */
  private ruleConfig(rule: AnonymizationTemplateRule): AnonymizationRuleConfig {
    const config: AnonymizationRuleConfig = { ...rule.config };
    if (rule.ruleType === 'hash') config.hashSalt = this.maskingKey;
    return config;
  }

  /**
   * Inject the file-backed record store so backups stop inflating globalState.
   * Called from composition, which owns the extension's storage path.
   */
  setBackupRecordStore(store: BackupRecordStore): void {
    this.backupRecords = store;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!DATAOPS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'backup:execute':
        await this.handleBackup(msg);
        return true;
      case 'backup:list':
        this.handleBackupList(msg);
        return true;
      case 'backup:export':
        await this.handleBackupExport(msg);
        return true;
      case 'dataops:rollback':
        await this.handleRollback(msg);
        return true;
      case 'dataops:anonymize':
        await this.handleAnonymize(msg);
        return true;
      case 'dataops:anonymization-templates':
        this.handleAnonymizationTemplates(msg);
        return true;
      case 'dataops:quality-scan':
        await this.handleQualityScan(msg);
        return true;
      case 'dataops:anonymization-template:save':
        this.handleTemplateSave(msg);
        return true;
      case 'dataops:anonymization-template:delete':
        this.handleTemplateDelete(msg);
        return true;
      case 'precheck:pii-scan':
        await this.handlePIIScan(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Comma-separated list of every field of an object, ready to drop into a
   * SELECT clause.
   *
   * Salesforce caps `SELECT FIELDS(ALL)` at `LIMIT 200`, and these snapshots
   * ask for the org-tier limit (2000 on a sandbox): the org rejected the query
   * every single time, and the records only arrived because
   * `queryWithFieldsFallback` caught the rejection, described the object and
   * re-queried — three round trips per object to do the work of two. Resolving
   * the field list up front makes the query valid on the first attempt. It is
   * the same list that fallback built, and the same `LIMIT`, so the rows and
   * columns collected do not change.
   *
   * @param conn - Connection used for the describe call.
   * @param objectApiName - Already-sanitized SObject API name.
   */
  private async selectAllFields(
    conn: { describe: (objectApiName: string) => Promise<{ fields: Array<{ name: string }> }> },
    objectApiName: string,
  ): Promise<string> {
    const desc = await conn.describe(objectApiName);
    return desc.fields.map((f) => f.name).join(', ');
  }

  /**
   * The id the org behind a connection answers with (`Organization.Id`), or
   * `undefined` when it does not say.
   *
   * A refreshed sandbox keeps its registered id and answers with a new one,
   * so this, not the registry, tells apart the org a backup was taken from
   * and the org a restore would write to. An org that cannot say is bound to
   * nothing, and no restore is held back on its account.
   */
  private async organizationIdOf(conn: Connection): Promise<string | undefined> {
    try {
      const records = await queryAll<{ Id?: unknown }>(conn, 'SELECT Id FROM Organization');
      const id = records[0]?.Id;
      return typeof id === 'string' && ORG_ID_PATTERN.test(id) ? id : undefined;
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] dataops: the org did not say which org it is: ${extractErrorMessage(err)}`,
      );
      return undefined;
    }
  }

  private async handleBackup(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsBackupPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    // Deterministic ID from the message ID — enables genuine duplicate detection
    // (a fresh UUID per call made `isDuplicate` dead code).
    const operationId = msg.id;
    const outcome = await this.takeBackup(operationId, parsed, msg.type);

    if ('error' in outcome) {
      // Dual channel, single display: `operation:failed` carries the lifecycle
      // (webview clears global loading + auto AI-resolver); `dataops:error` is
      // the `<domain>:error` channel useBridgeMutation listens on — it settles
      // the in-flight mutation with the real message. The webview surfaces the
      // error from dataops:error only, so the user sees it exactly once.
      sendHandlerError(this.deps, 'backup:execute', 'dataops:error', msg, outcome.error);
      this.endBackupNotTaken(operationId, outcome);
      return;
    }

    const response = buildResponse(this.deps, msg, 'dataops:backup:response', {
      operationId,
      status: 'completed',
      objects: outcome.objects.map((r) => ({
        objectApiName: r.objectApiName,
        recordCount: r.recordCount,
      })),
      totalRecords: outcome.totalRecords,
      timestamp: outcome.timestamp,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Take a snapshot for a pipeline's Backup step: the flow the Backup button
   * runs — the org's lock, the duplicate guard, the tier's row bound, the
   * registry entry Live Operations can cancel, the retention — answered to the
   * step rather than to a page. Nothing is written to the org; the records go
   * to local storage, where the DataOps page lists them.
   *
   * @param request - The snapshot's id, the org, and the objects to read.
   * @param signal - Stops the snapshot between two objects or before it is
   *   saved, with nothing saved.
   * @returns What the snapshot holds.
   * @throws {StepCancelledError} When a cancel stopped the snapshot — Live
   *   Operations' on its own registry entry, or the run's — so the step is not
   *   tried again: a retry took a new snapshot of what the person had just
   *   stopped.
   * @throws With the reason, when no snapshot was taken for any other reason.
   */
  async backupForPipeline(
    request: { operationId: string; orgId: string; objects: string[] },
    signal?: AbortSignal,
  ): Promise<BackupTaken> {
    const outcome = await this.takeBackup(
      request.operationId,
      { orgId: request.orgId, objects: request.objects },
      'pipeline:execute',
      signal,
    );
    if ('error' in outcome) {
      const message = extractErrorMessage(outcome.error);
      this.endBackupNotTaken(request.operationId, outcome);
      if (outcome.cancelled) throw new StepCancelledError(message);
      throw outcome.error instanceof Error ? outcome.error : new Error(message);
    }
    return outcome;
  }

  /**
   * End the lifecycle of a snapshot that was not taken: as failed, or, when a
   * cancel stopped it, as a completion that says it was aborted — the way a
   * cancelled Forge discovery ends. A cancel used to post `operation:failed`:
   * the activity feed listed the snapshot the user had stopped as failed, and
   * the cancel was sent off to be explained like an org's error.
   *
   * @param operationId - The snapshot's id.
   * @param outcome - Why it was not taken.
   */
  private endBackupNotTaken(operationId: string, outcome: BackupNotTaken): void {
    if (outcome.cancelled) {
      sendOperationCompleted(this.deps, operationId, { aborted: true });
      return;
    }
    sendOperationFailed(
      this.deps,
      operationId,
      extractErrorMessage(outcome.error),
      outcome.retryable,
      { context: outcome.context },
    );
  }

  /**
   * The snapshot flow the Backup button and a pipeline's Backup step share. It
   * reports the lifecycle (`operation:started`, progress, `operation:completed`)
   * itself and leaves answering the request, or the step, to its caller, with
   * the failure when there is one.
   *
   * @param operationId - The snapshot's id: its storage key and its registry entry.
   * @param payload - The org and the objects to read.
   * @param origin - The request that asked for it, for the fix suggestion.
   * @param signal - Stops the snapshot between two objects or before it is
   *   saved, as a cancel from Live Operations does.
   */
  private async takeBackup(
    operationId: string,
    payload: { orgId: string; objects: string[] },
    origin: string,
    signal?: AbortSignal,
  ): Promise<BackupTaken | BackupNotTaken> {
    // Names the object in progress as the loop below advances, so the fix
    // suggestion for a failure says which object it came from.
    const failure: OperationFailureContext = { module: 'dataops', operation: origin };

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      // This message is one SandForge writes itself, so it is never asked
      // about and the context is never read — it is passed here, and at the
      // guard and precondition refusals below, so every failure of the run
      // carries the same thing.
      return { error: new Error(message), retryable: false, context: failure };
    }
    this.activeOrgOperations.add(lockKey);

    /**
     * Settles the promise the registry watches, so it stops listing this run:
     * with the error the snapshot failed on, or with nothing when it finished.
     * Settled unconditionally, a snapshot that errored was announced completed.
     */
    let settleBackup: (error?: unknown) => void = () => {};
    /** What the snapshot failed on, read by `settleBackup` in `finally`. */
    let backupError: unknown;
    // Aborted by the registry (a cancel from Live Operations, the window
    // closing) and by the caller's signal (a pipeline run stopped).
    const stop = new AbortController();
    const onAbort = (): void => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate backup operation detected: ${operationId}`);
        return {
          error: new Error(`Duplicate operation: ${operationId}`),
          retryable: false,
          context: failure,
        };
      }
      this.dmlTracker.register(operationId, 'backup', 'insert', payload.objects.length);

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Resolve dynamic query limits based on org tier
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const orgTier = resolveOrgTier(org?.orgType === 'Sandbox' || org?.orgType === 'Scratch');
      const queryLimits = getQueryLimits(orgTier);

      const results: Array<
        BackupTaken['objects'][number] & { records: Record<string, unknown>[] }
      > = [];

      const description = `Backup ${payload.objects.length} object(s)`;
      sendOperationStarted(this.deps, operationId, 'dataops', description);

      // A snapshot reads one object after another, so the registry's abort —
      // the extension deactivating, the window closing, a cancel from Live
      // Operations, a pipeline run stopped — is honoured between two objects.
      // Nothing is written to storage until the whole loop is through, so
      // stopping there leaves no half-saved backup behind.
      this.deps.infraServices?.backgroundRegistry?.register(
        operationId,
        'dataops',
        description,
        new Promise<void>((resolve, reject) => {
          settleBackup = (error) => {
            if (error === undefined) resolve();
            else reject(error instanceof Error ? error : new Error(String(error)));
          };
        }),
        stop,
      );

      let processedObjects = 0;
      for (const objectApiName of payload.objects) {
        if (stop.signal.aborted) {
          throw new Error(BACKUP_CANCELLED);
        }
        const safeObj = sanitizeSoqlObjectName(objectApiName);
        failure.objectName = safeObj;
        const read = await queryAllBounded<Record<string, unknown>>(
          conn,
          `SELECT ${await this.selectAllFields(conn, safeObj)} FROM ${safeObj} ` +
            `LIMIT ${queryLimits.defaultQueryLimit}`,
          queryLimits.defaultQueryLimit,
        );
        const records = read.records;
        checkApiLimits(conn.limitInfo, `dataops:backup query ${safeObj}`);

        // A snapshot that stopped at a bound is still a snapshot, and taking
        // it is still better than taking none — but it is not the thing the
        // user thinks they have. Said here, carried in the metadata below, and
        // read back by the listing, so it is still true tomorrow.
        if (read.truncated) {
          this.deps.log(
            `[WARN] backup of ${safeObj} stopped at ${records.length} record(s): the object holds more.`,
          );
        }

        results.push({
          objectApiName,
          recordCount: records.length,
          records,
          truncated: read.truncated,
        });
        processedObjects++;

        sendOperationProgress(
          this.deps,
          operationId,
          Math.round((processedObjects / payload.objects.length) * 100),
          processedObjects,
          payload.objects.length,
          `Exported ${objectApiName} (${records.length} records)`,
        );
      }

      // Which org the records were read from: a restore compares it with the
      // org it would write to, which a sandbox refresh replaces behind the
      // same registered id.
      const organizationId = await this.organizationIdOf(conn);

      // And once more before anything is saved. A cancel that came while the
      // last object was read was honoured by nothing: the snapshot of a single
      // object was saved and called taken, after Live Operations had said it
      // was stopped.
      if (stop.signal.aborted) {
        throw new Error(BACKUP_CANCELLED);
      }

      const backupKey = `backup:${operationId}`;
      const backupMeta = {
        operationId,
        orgId: payload.orgId,
        ...(organizationId !== undefined ? { organizationId } : {}),
        objects: results.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
          truncated: r.truncated,
        })),
        // True when any object stopped at a bound, so the listing can say so
        // without reading every object of every snapshot.
        partial: results.some((r) => r.truncated),
        timestamp: new Date().toISOString(),
        totalRecords: results.reduce((sum, r) => sum + r.recordCount, 0),
      };
      this.deps.configStore.set(backupKey, backupMeta, 'backups');

      for (const r of results) {
        // Record payloads go to a file, not globalState: VSCode re-serializes
        // that memento in full on every write, so megabytes of backup made
        // every unrelated setting save pay for them.
        if (this.backupRecords) {
          await this.backupRecords.save(operationId, r.objectApiName, r.records);
        } else {
          this.deps.configStore.set(`${backupKey}:${r.objectApiName}`, r.records, 'backups');
        }
      }

      // `sandforge.backup.maxCount` retention: prune oldest backups for this
      // org. Housekeeping, and it runs after the snapshot is written — so a
      // failure in it must not be reported as a failed backup. Told the
      // snapshot failed, a user takes it again or, worse, carries on without
      // the one they already have; the records are on disk either way and the
      // listing finds them. Only the pruning is lost, and it retries on the
      // next backup of this org.
      try {
        this.pruneBackups(payload.orgId);
      } catch (pruneErr: unknown) {
        this.deps.log(
          `[WARN] backup retention failed after the snapshot was written: ${extractErrorMessage(pruneErr)}`,
        );
      }

      sendOperationCompleted(this.deps, operationId, {
        objects: results.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
        })),
        totalRecords: backupMeta.totalRecords,
      });
      this.dmlTracker.markCompleted(operationId);

      return {
        operationId,
        objects: backupMeta.objects,
        totalRecords: backupMeta.totalRecords,
        partial: backupMeta.partial,
        timestamp: backupMeta.timestamp,
      };
    } catch (err: unknown) {
      backupError = err;
      this.dmlTracker.markFailed(operationId);
      const cancelled = stop.signal.aborted;
      // Stopped through the run's signal rather than from Live Operations, the
      // snapshot is still listed as running there, and the error it settles
      // with below would list it as failed.
      if (cancelled) this.deps.infraServices?.backgroundRegistry?.abort(operationId);
      return { error: err, retryable: true, context: failure, cancelled };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      settleBackup(backupError);
      this.activeOrgOperations.delete(lockKey);
    }
  }

  /**
   * Enforce the `sandforge.backup.maxCount` retention policy for an org:
   * oldest backups (by meta timestamp) beyond the cap are deleted, including
   * their per-object record payloads.
   */
  /**
   * Answer `backup:list` with the backups persisted for one org.
   *
   * The DataOps page has always listened on `backup:list:result`, but the
   * request type was declared in no Zod member, so the broker rejected the
   * message before any handler saw it: the list was permanently empty, the KPI
   * row read 0, Restore had nothing to select, and the query eventually timed
   * out into an error banner.
   *
   * Key partitioning mirrors pruneBackups: meta keys are `backup:<operationId>`,
   * record keys are `backup:<operationId>:<objectApiName>`.
   */
  private handleBackupList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsBackupListPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;

    const backups: BackupSummary[] = [];
    for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
      if (key.slice('backup:'.length).includes(':')) continue;
      const meta = this.deps.configStore.get<{
        operationId?: string;
        orgId?: string;
        timestamp?: string;
        totalRecords?: number;
        objects?: Array<{ objectApiName: string; recordCount: number }>;
      }>(key);
      if (!meta || meta.orgId !== parsed.orgId) continue;
      backups.push({
        operationId: meta.operationId ?? key.slice('backup:'.length),
        orgId: meta.orgId,
        timestamp: meta.timestamp ?? '',
        totalRecords: meta.totalRecords ?? 0,
        // Byte size is not recorded at backup time; reporting 0 is honest,
        // where a computed guess would not be.
        totalSize: 0,
        // A meta record only exists once the backup has been written, so a
        // listed backup is by construction a completed one.
        status: 'completed',
        objectResults: meta.objects ?? [],
      });
    }
    // Newest first — the list is a history, and the most recent restore point
    // is the one a user reaches for.
    backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const response = buildResponse(this.deps, msg, 'backup:list:result', { backups });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} count=${backups.length}`);
  }

  /**
   * Serialize one backup, records included, so it can leave the machine.
   *
   * dataops:backup writes record payloads into ConfigStore, which is VSCode
   * globalState: a backup lived on one laptop with no way out. Nothing here
   * touches the org — it reads what was already stored and hands back a
   * document the webview downloads, the same shape sync:history:export uses.
   */
  private async handleBackupExport(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsBackupExportPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;

    const metaKey = `backup:${parsed.operationId}`;
    const meta = this.deps.configStore.get<{
      orgId?: string;
      timestamp?: string;
      totalRecords?: number;
      objects?: Array<{ objectApiName: string; recordCount: number }>;
    }>(metaKey);

    if (!meta || meta.orgId !== parsed.orgId) {
      sendHandlerError(
        this.deps,
        'backup:export',
        'dataops:error',
        msg,
        new Error(`Backup not found: ${parsed.operationId}`),
        { code: 'BACKUP_NOT_FOUND' },
      );
      return;
    }

    const objects: Record<string, unknown[]> = {};
    for (const obj of meta.objects ?? []) {
      const fromFile = await this.backupRecords?.read(parsed.operationId, obj.objectApiName);
      // Backups written before the file store still live in ConfigStore.
      objects[obj.objectApiName] =
        fromFile ?? this.deps.configStore.get<unknown[]>(`${metaKey}:${obj.objectApiName}`) ?? [];
    }

    const document = {
      sandforgeBackupVersion: 1,
      operationId: parsed.operationId,
      orgId: meta.orgId,
      timestamp: meta.timestamp ?? '',
      totalRecords: meta.totalRecords ?? 0,
      objects,
    };

    const response = buildResponse(this.deps, msg, 'backup:export:result', {
      operationId: parsed.operationId,
      filename: `sandforge-backup-${parsed.operationId}.json`,
      data: JSON.stringify(document, null, 2),
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private pruneBackups(orgId: string): void {
    const maxCount = this.deps.services?.getSandforgeSetting?.('backup.maxCount', 10) ?? 10;
    const metas: Array<{ key: string; timestamp: string }> = [];
    for (const key of this.deps.configStore.getKeysByPrefix('backup:')) {
      // Meta keys are `backup:<operationId>`; record keys are
      // `backup:<operationId>:<objectApiName>` — skip the latter.
      const rest = key.slice('backup:'.length);
      if (rest.includes(':')) continue;
      const meta = this.deps.configStore.get<{ orgId?: string; timestamp?: string }>(key);
      if (meta?.orgId !== orgId) continue;
      metas.push({ key, timestamp: meta.timestamp ?? '' });
    }
    if (metas.length <= maxCount) return;
    metas.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const { key } of metas.slice(0, metas.length - maxCount)) {
      const meta = this.deps.configStore.get<{
        objects?: Array<{ objectApiName: string }>;
      }>(key);
      for (const obj of meta?.objects ?? []) {
        this.deps.configStore.delete(`${key}:${obj.objectApiName}`);
        void this.backupRecords?.delete(key.slice('backup:'.length), obj.objectApiName);
      }
      this.deps.configStore.delete(key);
      this.deps.log(`[INFO] Pruned backup ${key} (retention: ${maxCount} per org)`);
    }
  }

  /**
   * Bring back, from the recycle bin, the records of a snapshot deleted since.
   *
   * A record no longer in the recycle bin cannot come back with its Id; the
   * upsert that follows reports it as refused, which is what it is. An object
   * whose rows cannot be read with the deleted ones, or a record the bin will
   * not give back, is likewise left to that upsert and its report.
   */
  private async undeleteFromRecycleBin(
    conn: Connection,
    objectApiName: string,
    records: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ undeleted: number }> {
    const ids = records.map((r) => r.Id).filter((id): id is string => typeof id === 'string');
    const deleted: string[] = [];
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const inList = ids
          .slice(i, i + 200)
          .map((id) => `'${sanitizeSoqlValue(id)}'`)
          .join(', ');
        const result = await conn.query<{ Id: string }>(
          `SELECT Id FROM ${objectApiName} WHERE Id IN (${inList}) AND IsDeleted = true`,
          { scanAll: true },
        );
        deleted.push(...result.records.map((r) => r.Id));
      }
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] Rollback on ${objectApiName}: could not look for deleted records — ${extractErrorMessage(err)}`,
      );
      return { undeleted: 0 };
    }
    let undeleted = 0;
    for (let i = 0; i < deleted.length; i += 200) {
      const results = await conn.soap.undelete(deleted.slice(i, i + 200));
      undeleted += results.filter((r) => r.success).length;
    }
    return { undeleted };
  }

  /**
   * Refuse a write whose Production Guard is not there, on both channels the
   * page listens on — the same as a declined confirmation, with the code the
   * frozen load refuses with — and record it in the audit trail, as the
   * guard's own refusals are.
   */
  private refuseWithoutGuard(
    context: 'dataops:rollback' | 'dataops:anonymize',
    msg: InboundRequest,
    operationId: string,
    failure: OperationFailureContext,
    run: WriteRun,
  ): void {
    recordWriteRun(this.deps, {
      ...run,
      outcome: 'stopped',
      source: undefined,
      code: PRODUCTION_GUARD_MISSING.code,
    });
    sendHandlerError(
      this.deps,
      context,
      'dataops:error',
      msg,
      new Error(PRODUCTION_GUARD_MISSING.message),
      { code: PRODUCTION_GUARD_MISSING.code },
    );
    sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
      context: failure,
    });
  }

  private async handleRollback(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsRollbackPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    // Deterministic ID from the message ID (see handleBackup).
    const rollbackOpId = msg.id;
    // Follows the object in progress (see handleBackup).
    const failure: OperationFailureContext = { module: 'dataops', operation: msg.type };

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(message));
      sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
      return;
    }
    this.activeOrgOperations.add(lockKey);

    /** The restore as the audit trail records it, once the backup is found. */
    let run: WriteRun | undefined;
    /** Per object, what the restore wrote so far. */
    const restored: AuditObjectCounts[] = [];
    /**
     * True from the moment the restore is announced until its end is recorded:
     * it stops at the first object it may not write, and must still be recorded.
     */
    let unrecorded = false;

    try {
      if (this.dmlTracker.isDuplicate(rollbackOpId)) {
        this.deps.log(`[WARN] Duplicate rollback operation detected: ${rollbackOpId}`);
        sendHandlerError(
          this.deps,
          'dataops:rollback',
          'dataops:error',
          msg,
          new Error(`Duplicate operation: ${rollbackOpId}`),
        );
        sendOperationFailed(
          this.deps,
          rollbackOpId,
          `Duplicate operation: ${rollbackOpId}`,
          false,
          { context: failure },
        );
        return;
      }
      this.dmlTracker.register(rollbackOpId, 'rollback', 'upsert', 0);

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Create CrudFlsGuard for permission checks before DML
      const crudFlsGuard = new CrudFlsGuard(async (objectApiName: string) => {
        const desc = await conn.describe(objectApiName);
        return describeToObjectDescribe(desc);
      });

      const backupKey = `backup:${payload.operationId}`;
      const backupMeta = this.deps.configStore.get<{
        operationId: string;
        orgId: string;
        /** Absent from backups taken before it was recorded. */
        organizationId?: string;
        objects: Array<{ objectApiName: string; recordCount: number }>;
        totalRecords: number;
        timestamp?: string;
      }>(backupKey);

      if (!backupMeta) {
        throw new Error(`No backup found for operation ${payload.operationId}. Cannot rollback.`);
      }

      // A backup belongs to the org it was taken from. Without this, the
      // records of org A could be poured into org B.
      if (backupMeta.orgId !== payload.orgId) {
        throw new Error(
          `Backup ${payload.operationId} was taken from org ${backupMeta.orgId} and cannot be ` +
            `restored into org ${payload.orgId}.`,
        );
      }

      run = {
        action: 'backup_restore',
        module: 'dataops',
        operationId: rollbackOpId,
        orgId: payload.orgId,
        outcome: 'failure',
        // Named by when it was taken: the backup's own id says nothing to a reader.
        source: {
          origin: 'backup',
          label: backupMeta.timestamp?.slice(0, 16).replace('T', ' ') ?? payload.operationId,
        },
      };

      // Rollback writes records over live data — the same Production Guard as
      // every other write path applies (see handleAnonymize), and no write
      // without it.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        this.refuseWithoutGuard('dataops:rollback', msg, rollbackOpId, failure, run);
        return;
      }
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const guardRequest = {
        orgId: payload.orgId,
        orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
        operation: 'upsert' as const,
        objectName: backupMeta.objects.map((o) => o.objectApiName).join(', ') || 'RollbackData',
        recordCount: backupMeta.totalRecords ?? 0,
        module: 'dataops',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw new Error(
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
        );
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (production confirmation declined).';
        sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(message));
        sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
        return;
      }

      // A refresh replaces the org behind a registered sandbox and keeps its
      // id: the registry check above passes, and the records the backup saved
      // belong to the org the sandbox was. Restoring them does not put that
      // org back, so the user is told before anything is written.
      if (backupMeta.organizationId !== undefined) {
        const now = await this.organizationIdOf(conn);
        if (now !== undefined && !sameOrg(backupMeta.organizationId, now)) {
          const alias = org?.alias ?? payload.orgId;
          const ask = this.deps.infraServices?.confirmRestoreIntoReplacedOrg;
          const restoreAnyway = ask
            ? await ask({ alias, backedUpFrom: backupMeta.organizationId, now })
            : false;
          if (!restoreAnyway) {
            // Stopped before anything was written, and recorded as the
            // guard's refusals are: the trail said nothing of a restore the
            // check turned down.
            recordWriteRun(this.deps, {
              ...run,
              outcome: 'stopped',
              source: undefined,
              code: ORG_REPLACED_SINCE_BACKUP,
            });
            const message =
              `Restore not run: ${alias} answers as org ${now}, not as org ` +
              `${backupMeta.organizationId}, which backup ${payload.operationId} was taken from, ` +
              (ask
                ? 'and the restore into the org it is now was not confirmed.'
                : 'and nothing here can ask whether to restore into the org it is now.');
            sendHandlerError(
              this.deps,
              'dataops:rollback',
              'dataops:error',
              msg,
              new Error(message),
              {
                code: ORG_REPLACED_SINCE_BACKUP,
              },
            );
            sendOperationFailed(this.deps, rollbackOpId, message, false, { context: failure });
            return;
          }
        }
      }

      sendOperationStarted(
        this.deps,
        rollbackOpId,
        'dataops',
        `Rollback ${backupMeta.objects.length} object(s)`,
      );
      unrecorded = true;

      let totalRestored = 0;
      let totalFailed = 0;
      const restoreErrors: Array<{ objectApiName: string; message: string }> = [];
      for (let i = 0; i < backupMeta.objects.length; i++) {
        const obj = backupMeta.objects[i];
        const safeObj = sanitizeSoqlObjectName(obj.objectApiName);
        failure.objectName = safeObj;
        const fromFile = (await this.backupRecords?.read(
          payload.operationId,
          obj.objectApiName,
        )) as Record<string, unknown>[] | null | undefined;
        // Backups written before the file store still live in ConfigStore.
        const records =
          fromFile ??
          this.deps.configStore.get<Record<string, unknown>[]>(`${backupKey}:${obj.objectApiName}`);

        if (!records || records.length === 0) {
          this.deps.log(`[WARN] No backup records for ${obj.objectApiName}, skipping.`);
          continue;
        }

        // Can this org upsert the object at all? That question is all-or-nothing
        // and still gates the restore.
        const crudCheck = await crudFlsGuard.checkCrudPermission(safeObj, 'upsert');
        if (!crudCheck.allowed) {
          this.deps.log(`[WARN] CRUD check failed for rollback on ${safeObj}: ${crudCheck.reason}`);
          sendHandlerError(
            this.deps,
            'dataops:rollback',
            'dataops:error',
            msg,
            new Error(crudCheck.reason),
          );
          sendOperationFailed(this.deps, rollbackOpId, crudCheck.reason, false, {
            context: failure,
          });
          return;
        }

        // Which of the backup's fields can actually be written? A backup is a
        // verbatim `SELECT FIELDS(ALL)` snapshot, so it always carries fields
        // nobody may write. Asking "may I write ALL of these?" made every
        // restore fail; the describe answers the field-by-field question.
        const payloadFields = Object.keys(records[0]).filter((k) => k !== 'attributes');
        const { skipped, denied } = await crudFlsGuard.partitionWritableFields(
          safeObj,
          'upsert',
          payloadFields,
        );
        // A business field this org may not write is still a hard stop: dropping
        // it would restore the record with that column silently missing.
        if (denied.length > 0) {
          const reason = `FLS violation on '${safeObj}': fields [${denied.join(', ')}] are not updateable.`;
          this.deps.log(`[WARN] CRUD/FLS check failed for rollback on ${safeObj}: ${reason}`);
          sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, new Error(reason));
          sendOperationFailed(this.deps, rollbackOpId, reason, false, { context: failure });
          return;
        }
        // `Id` is the upsert match key, not a field being written.
        const droppedFields = new Set(
          skipped.filter((f) => f.toLowerCase() !== 'id').map((f) => f.toLowerCase()),
        );
        if (droppedFields.size > 0) {
          // Reported, never silent: a partial restore the user is not told
          // about is a different lie from the one this replaces.
          this.deps.log(
            `[INFO] Rollback on ${safeObj}: ${droppedFields.size} non-writable field(s) ` +
              `excluded from the payload — ${[...droppedFields].sort().join(', ')}`,
          );
        }

        // A record deleted since the snapshot sits in the recycle bin, and an
        // upsert on its Id is refused: "entity is deleted". Run for real, a
        // restore reported 204 restored and 1 rejected — the one record the
        // user had lost. It is brought back first, with its Id and whatever
        // pointed at it, and the upsert below then writes its fields.
        const brought = await this.undeleteFromRecycleBin(conn, safeObj, records);
        if (brought.undeleted > 0) {
          this.deps.log(
            `[INFO] Rollback on ${safeObj}: ${brought.undeleted} record(s) brought back from the recycle bin`,
          );
        }

        type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };
        const batchSize = 200;
        failure.batchSize = batchSize;
        let successCount = 0;
        let failureCount = 0;
        for (let j = 0; j < records.length; j += batchSize) {
          const batch = records.slice(j, j + batchSize);
          const cleaned = batch.map((r) => {
            const copy: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(r)) {
              if (key === 'attributes') continue;
              // `Id` is the upsert match key — kept; everything the describe
              // says this org cannot write is dropped.
              if (droppedFields.has(key.toLowerCase())) continue;
              copy[key] = value;
            }
            return copy;
          });
          const results = (await conn
            .sobject(safeObj)
            .upsert(cleaned as Array<Record<string, unknown> & { Id: string }>, 'Id', {
              headers: duplicateRuleHeaders(true),
            })) as unknown as JsforceResult[];
          const arr = Array.isArray(results) ? results : [results];
          // Only the successes used to be counted, so a row the org refused
          // (validation rule, required field, trigger) vanished between the
          // upsert and the report. `errors` was declared above and read by
          // no one.
          for (const r of arr) {
            if (r.success) {
              successCount++;
              continue;
            }
            failureCount++;
            collectDmlError(restoreErrors, safeObj, r.errors);
          }
        }
        checkApiLimits(conn.limitInfo, `dataops:rollback upsert ${safeObj}`);
        totalRestored += successCount;
        totalFailed += failureCount;
        // An upsert on the record's own Id writes over a record that exists —
        // or was just brought back from the recycle bin — so it updates.
        restored.push({ ...emptyCounts(safeObj), updated: successCount, failed: failureCount });

        sendOperationProgress(
          this.deps,
          rollbackOpId,
          Math.round(((i + 1) / backupMeta.objects.length) * 100),
          i + 1,
          backupMeta.objects.length,
          `Restored ${safeObj} (${successCount}/${records.length})`,
        );
      }

      const status = dmlStatus(totalRestored, totalFailed);
      if (run) {
        unrecorded = false;
        recordWriteRun(this.deps, { ...run, outcome: status, objects: restored });
      }
      sendOperationCompleted(this.deps, rollbackOpId, { status, totalRestored, totalFailed });
      this.dmlTracker.markCompleted(rollbackOpId);

      const message =
        totalFailed === 0
          ? `Rollback completed: ${totalRestored} records restored`
          : `Rollback ${status}: ${totalRestored} restored, ${totalFailed} rejected by the org`;
      const response = buildResponse(this.deps, msg, 'dataops:rollback:response', {
        operationId: payload.operationId,
        status,
        message,
        totalRestored,
        totalFailed,
        errors: restoreErrors,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${status}`);
      // The DataOps page reads only the error and notification channels: a
      // `partial` left in the response alone is as invisible as the count that
      // was dropped.
      if (totalFailed > 0) {
        sendNotification(
          this.deps,
          status === 'failure' ? 'error' : 'warning',
          'Restore',
          `${message}${restoreErrors[0] ? ` — e.g. ${restoreErrors[0].message}` : ''}`,
        );
      }
    } catch (err: unknown) {
      this.dmlTracker.markFailed(rollbackOpId);
      // Dual channel, single display (see handleBackup).
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', msg, err);
      sendOperationFailed(this.deps, rollbackOpId, extractErrorMessage(err), true, {
        context: failure,
      });
    } finally {
      this.activeOrgOperations.delete(lockKey);
      // A restore that stopped at an object it may not write, or threw, after
      // it started: recorded as failed, with the objects it had restored.
      if (unrecorded && run) {
        recordWriteRun(this.deps, { ...run, outcome: 'failure', objects: restored });
      }
    }
  }

  private async handleAnonymize(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsAnonymizePayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const operationId = crypto.randomUUID();
    // Follows the object in progress (see handleBackup).
    const failure: OperationFailureContext = { module: 'dataops', operation: msg.type };

    // A template the user saved is applied the way one that ships is.
    const template = this.findTemplate(payload.templateId);
    const plannedObjects = plannedAnonymizeObjects(payload, template);

    /** The masking run as the audit trail records it: read from the org, written back to it. */
    const run: WriteRun = {
      action: 'anonymize_execute',
      module: 'dataops',
      operationId,
      orgId: payload.orgId,
      outcome: 'failure',
      source: { origin: 'org', orgId: payload.orgId },
    };
    /** Per object, what the run masked so far. */
    const masked: AuditObjectCounts[] = [];
    /**
     * True from the moment the run is announced until its end is recorded: it
     * stops at the first object it may not write, and must still be recorded.
     */
    let unrecorded = false;

    try {
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        this.refuseWithoutGuard('dataops:anonymize', msg, operationId, failure, run);
        return;
      }
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const guardRequest = {
        orgId: payload.orgId,
        orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
        operation: 'update' as const,
        // The objects the run addresses, so a production confirmation
        // names them instead of an opaque 'AnonymizeData'.
        objectName: plannedObjects.join(', ') || 'AnonymizeData',
        // Each object is queried below, under the tier's row limit, so the
        // rows cannot be counted here.
        recordCount: 'unknown' as const,
        module: 'dataops',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw new Error(
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
        );
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (production confirmation declined).';
        sendHandlerError(this.deps, 'dataops:anonymize', 'dataops:error', msg, new Error(message));
        sendOperationFailed(this.deps, operationId, message, false, { context: failure });
        return;
      }

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      if (!template) {
        sendNotification(
          this.deps,
          'error',
          'Anonymize',
          `Template "${payload.templateId}" not found.`,
        );
        return;
      }

      // Resolve dynamic query limits based on org tier
      const anonOrg = this.deps.orgManager.getOrg(payload.orgId);
      const anonOrgTier = resolveOrgTier(
        anonOrg?.orgType === 'Sandbox' || anonOrg?.orgType === 'Scratch',
      );
      const anonQueryLimits = getQueryLimits(anonOrgTier);

      // Create CrudFlsGuard for permission checks before DML
      const crudFlsGuard = new CrudFlsGuard(async (objectApiName: string) => {
        const desc = await conn.describe(objectApiName);
        return describeToObjectDescribe(desc);
      });

      sendOperationStarted(this.deps, operationId, 'dataops', `Anonymizing with ${template.name}`);
      unrecorded = true;

      const { AnonymizationEngine } = await import('../../modules/dataops/AnonymizationEngine.js');
      // The window's key, not a fresh random one: see `maskingKey`.
      const engine = new AnonymizationEngine(undefined, this.maskingKey);

      let totalProcessed = 0;
      let totalFailed = 0;
      const maskErrors: Array<{ objectApiName: string; message: string }> = [];

      for (let oi = 0; oi < plannedObjects.length; oi++) {
        const objectName = plannedObjects[oi];
        const safeObj = sanitizeSoqlObjectName(objectName);
        failure.objectName = safeObj;
        const objectRules = template.rules.filter(
          (r) => r.fieldPattern.startsWith(`${objectName}.`) || (r.fieldPattern as string) === '*',
        );

        if (objectRules.length === 0) continue;

        const records = await queryAll<Record<string, unknown>>(
          conn,
          `SELECT ${await this.selectAllFields(conn, safeObj)} FROM ${safeObj} ` +
            `LIMIT ${anonQueryLimits.defaultQueryLimit}`,
        );
        checkApiLimits(conn.limitInfo, `dataops:anonymize query ${safeObj}`);

        if (records.length === 0) continue;

        // Verify CRUD/FLS permissions before update
        const updateFieldNames = objectRules
          .map((r) =>
            r.fieldPattern.includes('.') ? r.fieldPattern.split('.')[1] : r.fieldPattern,
          )
          .filter((f) => f !== '*');
        const flsCheck = await crudFlsGuard.checkCrudAndFls(safeObj, 'update', updateFieldNames);
        if (!flsCheck.allowed) {
          this.deps.log(
            `[WARN] CRUD/FLS check failed for anonymize on ${safeObj}: ${flsCheck.reason}`,
          );
          sendHandlerError(
            this.deps,
            'dataops:anonymize',
            'dataops:error',
            msg,
            new Error(flsCheck.reason),
          );
          sendOperationFailed(this.deps, operationId, flsCheck.reason, false, { context: failure });
          return;
        }

        const rules = objectRules.map((r) => ({
          objectApiName: objectName,
          fieldApiName: r.fieldPattern.includes('.')
            ? r.fieldPattern.split('.')[1]
            : r.fieldPattern,
          method: r.ruleType as
            | 'mask'
            | 'hash'
            | 'fake'
            | 'nullify'
            | 'shuffle'
            | 'truncate'
            | 'constant'
            | 'preserve_format',
          config: this.ruleConfig(r),
        }));

        const anonymized = engine.anonymize(records, rules);

        // Only the Id and the template's fields that held something go back.
        // The read takes every field, so each record went back with its audit
        // dates, its compound name and address and every flag the org keeps,
        // and Salesforce refuses a record carrying any of those, whole — Sync
        // and Autopilot saw it refuse every record of a run over the same
        // fields — so no record could be masked. An empty field holds nobody's
        // data, and a value made up for it — a fake street, the digest of
        // nothing, which an Email field refuses along with the rest of the
        // record — is data the record never had.
        const payloads: Array<Record<string, unknown>> = [];
        let nothingToMask = 0;
        records.forEach((original, index) => {
          const payload: Record<string, unknown> = { Id: original.Id };
          for (const rule of rules) {
            if (isFilledValue(original[rule.fieldApiName])) {
              payload[rule.fieldApiName] = anonymized[index][rule.fieldApiName];
            }
          }
          if (Object.keys(payload).length > 1) payloads.push(payload);
          else nothingToMask++;
        });

        type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };
        const batchSize = 200;
        failure.batchSize = batchSize;
        let successCount = 0;
        let failureCount = 0;
        for (let bi = 0; bi < payloads.length; bi += batchSize) {
          const batch = payloads.slice(bi, bi + batchSize);
          const updateResults = (await conn
            .sobject(objectName)
            .update(
              batch as Array<Record<string, unknown> & { Id: string }>,
            )) as unknown as JsforceResult[];
          checkApiLimits(conn.limitInfo, `dataops:anonymize update ${objectName}`);
          // Same dropped count as the restore: a record the org refuses keeps
          // its real PII, and reporting only the successes hid exactly that.
          for (const r of Array.isArray(updateResults) ? updateResults : [updateResults]) {
            if (r.success) {
              successCount++;
              continue;
            }
            failureCount++;
            collectDmlError(maskErrors, safeObj, r.errors);
          }
        }
        // A record none of whose masked fields held anything is done, as an
        // erasure counts one; the audit trail keeps to what was written.
        totalProcessed += successCount + nothingToMask;
        totalFailed += failureCount;
        masked.push({ ...emptyCounts(safeObj), updated: successCount, failed: failureCount });

        sendOperationProgress(
          this.deps,
          operationId,
          Math.round(((oi + 1) / plannedObjects.length) * 100),
          oi + 1,
          plannedObjects.length,
          `Anonymized ${objectName} (${successCount + nothingToMask}/${records.length})`,
        );
      }

      const status = dmlStatus(totalProcessed, totalFailed);
      unrecorded = false;
      recordWriteRun(this.deps, { ...run, outcome: status, objects: masked });
      sendOperationCompleted(this.deps, operationId, { status, totalProcessed, totalFailed });

      const message =
        totalFailed === 0
          ? `Anonymization completed: ${totalProcessed} records processed.`
          : `Anonymization ${status}: ${totalProcessed} masked, ${totalFailed} rejected by the org` +
            ' — those records still hold their original values.';
      const response = buildResponse(this.deps, msg, 'dataops:anonymize:response', {
        templateId: payload.templateId,
        status,
        recordsProcessed: totalProcessed,
        recordsFailed: totalFailed,
        message,
        errors: maskErrors,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${status}`);
      if (totalFailed > 0) {
        sendNotification(
          this.deps,
          status === 'failure' ? 'error' : 'warning',
          'Anonymize',
          `${message}${maskErrors[0] ? ` — e.g. ${maskErrors[0].message}` : ''}`,
        );
      }
    } catch (err: unknown) {
      // Dual channel, single display (see handleBackup).
      sendHandlerError(this.deps, 'dataops:anonymize', 'dataops:error', msg, err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        context: failure,
      });
    } finally {
      // A run that stopped at an object it may not write, or threw, after it
      // started: recorded as failed, with the objects it had masked.
      if (unrecorded) {
        recordWriteRun(this.deps, { ...run, outcome: 'failure', objects: masked });
      }
    }
  }

  private handleAnonymizationTemplates(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const templates: ListedAnonymizationTemplate[] = [
      ...ANONYMIZATION_TEMPLATES,
      ...this.savedTemplates.list(),
    ];
    const response = buildResponse(this.deps, msg, 'dataops:anonymization-templates:response', {
      templates,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] dataops:anonymization-templates:response`);
  }

  /**
   * Answer `dataops:quality-scan`: fill counts, repeated values and stale
   * records for the objects the page picked, each a count the org made.
   *
   * Read-only by construction — describes and aggregate queries, nothing else
   * — so it takes no org lock and passes no Production Guard: there is no
   * write for either to hold back. An object the org will not describe or
   * count comes back failed inside the result; only a scan that cannot start
   * at all, such as an org with no session, answers on `dataops:error`.
   */
  private async handleQualityScan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsQualityScanPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const result = await scanDataQuality(
        {
          describe: (objectApiName) => conn.describe(objectApiName),
          query: async (soql) => {
            const answer = await conn.query<Record<string, unknown>>(soql);
            checkApiLimits(conn.limitInfo, 'dataops:quality-scan');
            return { totalSize: answer.totalSize, records: answer.records };
          },
        },
        parsed,
      );
      const response = buildResponse(this.deps, msg, 'dataops:quality-scan:response', {
        ...result,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} objects=${result.objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:quality-scan', 'dataops:error', msg, err);
    }
  }

  /**
   * Save the rules the page sends as a template of the user's.
   *
   * The library used to be the four templates that ship: nothing could be
   * added to it, and the Create Template button said so. A name any template
   * already goes by is refused, since the picker lists templates by name.
   */
  private handleTemplateSave(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      anonymizationTemplateSavePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const name = parsed.name.trim();
      const taken = [...ANONYMIZATION_TEMPLATES, ...this.savedTemplates.list()].some(
        (t) => t.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        sendHandlerError(
          this.deps,
          'dataops:anonymization-template:save',
          'dataops:error',
          msg,
          new Error(`A template named "${name}" already exists. Pick another name.`),
          { code: 'DUPLICATE_NAME' },
        );
        return;
      }
      const template = {
        id: `tpl-saved-${crypto.randomUUID()}`,
        name,
        description: '',
        complianceFramework: 'custom' as const,
        rules: parsed.rules.map((rule) => ({ ...rule, description: '' })),
        saved: true as const,
        createdAt: new Date().toISOString(),
      };
      this.savedTemplates.save(template);
      const response = buildResponse(
        this.deps,
        msg,
        'dataops:anonymization-template:save:response',
        { template },
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'dataops:anonymization-template:save', 'dataops:error', msg, err);
    }
  }

  /** Delete a template the user saved. One that ships is code, and is refused. */
  private handleTemplateDelete(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      anonymizationTemplateDeletePayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const { templateId } = parsed;
    if (ANONYMIZATION_TEMPLATES.some((t) => t.id === templateId)) {
      sendHandlerError(
        this.deps,
        'dataops:anonymization-template:delete',
        'dataops:error',
        msg,
        new Error(`Template "${templateId}" ships with SandForge and cannot be deleted.`),
        { code: 'BUILT_IN' },
      );
      return;
    }
    try {
      const deleted = this.savedTemplates.delete(templateId);
      const response = buildResponse(
        this.deps,
        msg,
        'dataops:anonymization-template:delete:response',
        { templateId, deleted },
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'dataops:anonymization-template:delete',
        'dataops:error',
        msg,
        err,
      );
    }
  }

  private async handlePIIScan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(piiScanPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const { orgId, objectNames } = parsed;
    try {
      if (!this.deps.infraServices?.piiDetector) {
        throw new Error('PII Detector not available.');
      }
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const results = await Promise.all(
        objectNames.map(async (objectName: string) => {
          const safeObj = sanitizeSoqlObjectName(objectName);
          const desc = await conn.describe(safeObj);
          checkApiLimits(conn.limitInfo, `precheck:pii-scan describe ${safeObj}`);
          const fields = (
            desc.fields as Array<{ name: string; label: string; type: string; length?: number }>
          ).map((f: { name: string; label: string; type: string; length?: number }) => ({
            apiName: f.name,
            label: f.label,
            type: f.type,
            length: f.length,
          }));
          const piiResult = this.deps.infraServices!.piiDetector.detectPII(objectName, fields);
          return {
            objectName,
            piiFields: piiResult.piiFields.map(
              (f: { fieldApiName: string; classification: string; confidence: number }) => ({
                fieldName: f.fieldApiName,
                piiType: f.classification,
                confidence: f.confidence,
              }),
            ),
          };
        }),
      );
      const response = buildResponse(this.deps, msg, 'precheck:pii-scan:response', {
        success: true,
        results,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] precheck:pii-scan: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'precheck:pii-scan:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
