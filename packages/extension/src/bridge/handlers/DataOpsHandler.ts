import type { BaseMessage, BackupSummary } from '@sandforge/shared';
import { sanitizeSoqlObjectName, orgTypeToGuardTier } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  sendHandlerError,
} from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { CrudFlsGuard } from '../../core/metadata/CrudFlsGuard.js';
import type { ObjectDescribe } from '../../core/metadata/MetadataReader.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import {
  validatePayload,
  dataOpsBackupPayloadSchema,
  dataOpsBackupListPayloadSchema,
  dataOpsBackupExportPayloadSchema,
  dataOpsRollbackPayloadSchema,
  dataOpsAnonymizePayloadSchema,
  dataOpsMaskingTemplatesPayloadSchema,
  piiScanPayloadSchema,
} from '../validatePayload.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import type { MaskingTemplateService } from '../../modules/dataops/templates/MaskingTemplateService.js';
import type { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';

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
  'dataops:backup',
  'dataops:rollback',
  'dataops:anonymize',
  'dataops:anonymization-templates',
  'dataops:masking-templates-by-object',
  'precheck:pii-scan',
]);

/**
 * Domain handler for DataOps-related webview-to-extension messages.
 *
 * Manages backup, rollback, anonymization, anonymization templates,
 * and PII scanning operations.
 */
export class DataOpsHandler implements DomainHandler {
  /**
   * Set of orgId values currently involved in a rollback or backup operation.
   * Prevents concurrent operations from interleaving on the same org.
   */
  private readonly activeOrgOperations = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** Optional masking template service for per-object template lookups. */
  private maskingTemplateService?: MaskingTemplateService;

  /**
   * File-backed store for backup record payloads.
   *
   * Present once composition supplies a storage path. Absent in tests and in
   * any host without one, where the ConfigStore path below still works.
   */
  private backupRecords?: BackupRecordStore;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the masking template service.
   * @param service - The MaskingTemplateService instance.
   */
  setMaskingTemplateService(service: MaskingTemplateService): void {
    this.maskingTemplateService = service;
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
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!DATAOPS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'backup:execute':
      case 'dataops:backup':
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
      case 'dataops:masking-templates-by-object':
        this.handleMaskingTemplatesByObject(msg);
        return true;
      case 'precheck:pii-scan':
        await this.handlePIIScan(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleBackup(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsBackupPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    // Deterministic ID from the message ID — enables genuine duplicate detection
    // (a fresh UUID per call made `isDuplicate` dead code).
    const operationId = msg.id;

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      // Settle the in-flight useBridgeMutation listener on dataops:error
      // (same dual-channel contract as the catch below).
      sendHandlerError(this.deps, 'dataops:backup', 'dataops:error', new Error(message));
      sendOperationFailed(this.deps, operationId, message, false);
      return;
    }
    this.activeOrgOperations.add(lockKey);

    try {
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate backup operation detected: ${operationId}`);
        sendHandlerError(
          this.deps,
          'dataops:backup',
          'dataops:error',
          new Error(`Duplicate operation: ${operationId}`),
        );
        sendOperationFailed(this.deps, operationId, `Duplicate operation: ${operationId}`, false);
        return;
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

      const results: Array<{
        objectApiName: string;
        recordCount: number;
        records: Record<string, unknown>[];
      }> = [];

      sendOperationStarted(
        this.deps,
        operationId,
        'dataops',
        `Backup ${payload.objects.length} object(s)`,
      );

      let processedObjects = 0;
      for (const objectApiName of payload.objects) {
        const safeObj = sanitizeSoqlObjectName(objectApiName);
        const records = await queryWithFieldsFallback<Record<string, unknown>>(
          conn,
          safeObj,
          `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${queryLimits.defaultQueryLimit}`,
        );
        checkApiLimits(conn.limitInfo, `dataops:backup query ${safeObj}`);

        results.push({ objectApiName, recordCount: records.length, records });
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

      const backupKey = `backup:${operationId}`;
      const backupMeta = {
        operationId,
        orgId: payload.orgId,
        objects: results.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
        })),
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

      // `sandforge.backup.maxCount` retention: prune oldest backups for this org.
      this.pruneBackups(payload.orgId);

      sendOperationCompleted(this.deps, operationId, {
        objects: results.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
        })),
        totalRecords: backupMeta.totalRecords,
      });

      const response = buildResponse(this.deps, msg, 'dataops:backup:response', {
        operationId,
        status: 'completed',
        objects: results.map((r) => ({
          objectApiName: r.objectApiName,
          recordCount: r.recordCount,
        })),
        totalRecords: backupMeta.totalRecords,
        timestamp: backupMeta.timestamp,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      this.dmlTracker.markCompleted(operationId);
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      // Dual channel, single display: `operation:failed` carries the lifecycle
      // (webview clears global loading + auto AI-resolver); `dataops:error` is
      // the `<domain>:error` channel useBridgeMutation listens on — it settles
      // the in-flight mutation with the real message. The webview surfaces the
      // error from dataops:error only, so the user sees it exactly once.
      sendHandlerError(this.deps, 'dataops:backup', 'dataops:error', err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
    } finally {
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
  private handleBackupList(msg: BaseMessage): void {
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
  private async handleBackupExport(msg: BaseMessage): Promise<void> {
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
        new Error(`Backup not found: ${parsed.operationId}`),
        'BACKUP_NOT_FOUND',
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

  private async handleRollback(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsRollbackPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    // Deterministic ID from the message ID (see handleBackup).
    const rollbackOpId = msg.id;

    const lockKey = `backup:${payload.orgId}`;
    if (this.activeOrgOperations.has(lockKey)) {
      const message = `A backup or rollback operation is already running for org ${payload.orgId}. Please wait for it to complete.`;
      this.deps.log(`[WARN] ${message}`);
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', new Error(message));
      sendOperationFailed(this.deps, rollbackOpId, message, false);
      return;
    }
    this.activeOrgOperations.add(lockKey);

    try {
      if (this.dmlTracker.isDuplicate(rollbackOpId)) {
        this.deps.log(`[WARN] Duplicate rollback operation detected: ${rollbackOpId}`);
        sendHandlerError(
          this.deps,
          'dataops:rollback',
          'dataops:error',
          new Error(`Duplicate operation: ${rollbackOpId}`),
        );
        sendOperationFailed(this.deps, rollbackOpId, `Duplicate operation: ${rollbackOpId}`, false);
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
        objects: Array<{ objectApiName: string; recordCount: number }>;
        totalRecords: number;
      }>(backupKey);

      if (!backupMeta) {
        throw new Error(`No backup found for operation ${payload.operationId}. Cannot rollback.`);
      }

      sendOperationStarted(
        this.deps,
        rollbackOpId,
        'dataops',
        `Rollback ${backupMeta.objects.length} object(s)`,
      );

      let totalRestored = 0;
      for (let i = 0; i < backupMeta.objects.length; i++) {
        const obj = backupMeta.objects[i];
        const safeObj = sanitizeSoqlObjectName(obj.objectApiName);
        const fromFile = (await this.backupRecords?.read(
          payload.operationId,
          obj.objectApiName,
        )) as Record<string, unknown>[] | null | undefined;
        // Backups written before the file store still live in ConfigStore.
        const records =
          fromFile ??
          this.deps.configStore.get<Record<string, unknown>[]>(
            `${backupKey}:${obj.objectApiName}`,
          );

        if (!records || records.length === 0) {
          this.deps.log(`[WARN] No backup records for ${obj.objectApiName}, skipping.`);
          continue;
        }

        // Verify CRUD/FLS permissions before upsert
        const fieldNames =
          records.length > 0
            ? Object.keys(records[0]).filter((k) => k !== 'attributes' && k !== 'Id')
            : [];
        const flsCheck = await crudFlsGuard.checkCrudAndFls(safeObj, 'upsert', fieldNames);
        if (!flsCheck.allowed) {
          this.deps.log(
            `[WARN] CRUD/FLS check failed for rollback on ${safeObj}: ${flsCheck.reason}`,
          );
          sendHandlerError(
            this.deps,
            'dataops:rollback',
            'dataops:error',
            new Error(flsCheck.reason),
          );
          sendOperationFailed(this.deps, rollbackOpId, flsCheck.reason, false);
          return;
        }

        type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };
        const batchSize = 200;
        let successCount = 0;
        for (let j = 0; j < records.length; j += batchSize) {
          const batch = records.slice(j, j + batchSize);
          const cleaned = batch.map((r) => {
            const copy = { ...r };
            delete copy['attributes'];
            return copy;
          });
          const results = (await conn
            .sobject(safeObj)
            .upsert(
              cleaned as Array<Record<string, unknown> & { Id: string }>,
              'Id',
            )) as unknown as JsforceResult[];
          const arr = Array.isArray(results) ? results : [results];
          successCount += arr.filter((r) => r.success).length;
        }
        checkApiLimits(conn.limitInfo, `dataops:rollback upsert ${safeObj}`);
        totalRestored += successCount;

        sendOperationProgress(
          this.deps,
          rollbackOpId,
          Math.round(((i + 1) / backupMeta.objects.length) * 100),
          i + 1,
          backupMeta.objects.length,
          `Restored ${safeObj} (${successCount}/${records.length})`,
        );
      }

      sendOperationCompleted(this.deps, rollbackOpId, { totalRestored });
      this.dmlTracker.markCompleted(rollbackOpId);

      const response = buildResponse(this.deps, msg, 'dataops:rollback:response', {
        operationId: payload.operationId,
        status: 'success',
        message: `Rollback completed: ${totalRestored} records restored`,
        totalRestored,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      this.dmlTracker.markFailed(rollbackOpId);
      // Dual channel, single display (see handleBackup).
      sendHandlerError(this.deps, 'dataops:rollback', 'dataops:error', err);
      sendOperationFailed(this.deps, rollbackOpId, extractErrorMessage(err), true);
    } finally {
      this.activeOrgOperations.delete(lockKey);
    }
  }

  private async handleAnonymize(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(dataOpsAnonymizePayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const operationId = crypto.randomUUID();

    try {
      if (this.deps.infraServices?.productionGuard) {
        const guard = this.deps.infraServices.productionGuard;
        const org = this.deps.orgManager.getOrg(payload.orgId);
        const guardRequest = {
          orgId: payload.orgId,
          orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
          operation: 'update' as const,
          objectName: 'AnonymizeData',
          recordCount: 1,
          module: 'dataops',
        };
        const check = guard.check(guardRequest);
        guard.logOperation(guardRequest, check);
        if (!check.allowed) {
          throw new Error(
            `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          );
        }
        // `safety.requireProdConfirmation`: explicit user consent before
        // writing to a production org.
        const confirmed = await guard.confirmIfNeeded(check);
        if (!confirmed) {
          const message = 'Operation cancelled by user (production confirmation declined).';
          sendHandlerError(this.deps, 'dataops:anonymize', 'dataops:error', new Error(message));
          sendOperationFailed(this.deps, operationId, message, false);
          return;
        }
      }

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const template = ANONYMIZATION_TEMPLATES.find((t) => t.id === payload.templateId);
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

      const { AnonymizationEngine } = await import('../../modules/dataops/AnonymizationEngine.js');
      const engine = new AnonymizationEngine();

      const objects =
        payload.objects ??
        template.rules
          .map((r) => r.fieldPattern.split('.')[0])
          .filter((v, i, a) => a.indexOf(v) === i);
      let totalProcessed = 0;

      for (let oi = 0; oi < objects.length; oi++) {
        const objectName = objects[oi];
        const safeObj = sanitizeSoqlObjectName(objectName);
        const objectRules = template.rules.filter(
          (r) => r.fieldPattern.startsWith(`${objectName}.`) || (r.fieldPattern as string) === '*',
        );

        if (objectRules.length === 0) continue;

        const records = await queryWithFieldsFallback<Record<string, unknown>>(
          conn,
          safeObj,
          `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${anonQueryLimits.defaultQueryLimit}`,
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
            new Error(flsCheck.reason),
          );
          sendOperationFailed(this.deps, operationId, flsCheck.reason, false);
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
          config: {},
        }));

        const anonymized = engine.anonymize(records, rules);

        type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };
        const batchSize = 200;
        let successCount = 0;
        for (let bi = 0; bi < anonymized.length; bi += batchSize) {
          const batch = anonymized.slice(bi, bi + batchSize);
          const updateResults = (await conn
            .sobject(objectName)
            .update(
              batch as Array<Record<string, unknown> & { Id: string }>,
            )) as unknown as JsforceResult[];
          checkApiLimits(conn.limitInfo, `dataops:anonymize update ${objectName}`);
          successCount += (Array.isArray(updateResults) ? updateResults : [updateResults]).filter(
            (r) => r.success,
          ).length;
        }
        totalProcessed += successCount;

        sendOperationProgress(
          this.deps,
          operationId,
          Math.round(((oi + 1) / objects.length) * 100),
          oi + 1,
          objects.length,
          `Anonymized ${objectName} (${successCount}/${records.length})`,
        );
      }

      sendOperationCompleted(this.deps, operationId, { totalProcessed });

      const response = buildResponse(this.deps, msg, 'dataops:anonymize:response', {
        templateId: payload.templateId,
        status: 'success',
        recordsProcessed: totalProcessed,
        message: `Anonymization completed: ${totalProcessed} records processed.`,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      // Dual channel, single display (see handleBackup).
      sendHandlerError(this.deps, 'dataops:anonymize', 'dataops:error', err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
    }
  }

  private handleAnonymizationTemplates(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const response = buildResponse(this.deps, msg, 'dataops:anonymization-templates:response', {
      templates: ANONYMIZATION_TEMPLATES,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] dataops:anonymization-templates:response`);
  }

  private handleMaskingTemplatesByObject(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      dataOpsMaskingTemplatesPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    if (!this.maskingTemplateService) {
      sendNotification(
        this.deps,
        'warning',
        'DataOps',
        'Masking template service is not initialized.',
      );
      return;
    }

    const template = this.maskingTemplateService.getTemplate(payload.objectApiName);
    const response = buildResponse(this.deps, msg, 'dataops:masking-templates-by-object:response', {
      objectApiName: payload.objectApiName,
      template: template ?? null,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] dataops:masking-templates-by-object:response`);
  }

  private async handlePIIScan(msg: BaseMessage): Promise<void> {
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
