import type { BaseMessage } from '@sandforge/shared';
import { QuickSyncConfigSchema } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendNotification } from './HandlerTypes.js';
import {
  validatePayload,
  quickSyncSuggestObjectsPayloadSchema,
  quickSyncDetectRelationshipsPayloadSchema,
  quickSyncPreviewPayloadSchema,
  quickSyncExecutePayloadSchema,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { SmartObjectSuggester } from '../../modules/sync/SmartObjectSuggester.js';
import { RelationshipDetector } from '../../modules/sync/RelationshipDetector.js';
import type { DescribeFieldInfo } from '../../modules/sync/RelationshipDetector.js';
import { QuickSyncPreviewEstimator } from '../../modules/sync/QuickSyncPreviewEstimator.js';
import type { RecordCountResult } from '../../modules/sync/QuickSyncPreviewEstimator.js';
import { AutoFieldMapper } from '../../modules/sync/AutoFieldMapper.js';
import type { AutoMapFieldInfo } from '../../modules/sync/AutoFieldMapper.js';

/** Message types handled by QuickSyncHandler. */
const QUICKSYNC_TYPES = new Set([
  'quicksync:suggest-objects',
  'quicksync:detect-relationships',
  'quicksync:preview',
  'quicksync:execute',
]);

/** Smart defaults for Quick Sync execution (QSYNC-04). */
const QUICK_SYNC_DEFAULTS = {
  direction: 'source_to_target' as const,
  mode: 'full' as const,
  conflictStrategy: 'source_wins' as const,
  operation: 'upsert' as const,
  batchSize: 200,
};

/**
 * Domain handler for Quick Sync webview-to-extension messages.
 *
 * Orchestrates the 3-click flow: object suggestions, relationship detection,
 * preview estimation, and execution with smart defaults.
 */
export class QuickSyncHandler implements DomainHandler {
  private readonly suggester = new SmartObjectSuggester();
  private readonly relationshipDetector = new RelationshipDetector();
  private readonly previewEstimator = new QuickSyncPreviewEstimator();
  private readonly autoFieldMapper = new AutoFieldMapper();

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!QUICKSYNC_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'quicksync:suggest-objects':
        await this.handleSuggestObjects(msg);
        return true;
      case 'quicksync:detect-relationships':
        await this.handleDetectRelationships(msg);
        return true;
      case 'quicksync:preview':
        await this.handlePreview(msg);
        return true;
      case 'quicksync:execute':
        await this.handleExecute(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Suggest top 5 common objects filtered by org availability.
   * Payload: { orgId, alreadySelected }
   */
  private async handleSuggestObjects(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      quickSyncSuggestObjectsPayloadSchema,
      msg,
      'quicksync:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId ?? '',
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const result = await conn.describeGlobal();

      const availableObjects = (
        result.sobjects as Array<{ name: string; createable: boolean; queryable: boolean }>
      )
        .filter((s) => s.createable && s.queryable)
        .map((s) => s.name);

      const suggestions = this.suggester.suggest(availableObjects, payload.alreadySelected ?? []);

      const response = buildResponse(this.deps, msg, 'quicksync:suggest-objects:response', {
        suggestions,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'quicksync:suggest-objects', 'quicksync:error', err);
    }
  }

  /**
   * Detect parent object dependencies for a given object.
   * Payload: { orgId, objectApiName, alreadySelected, availableObjects? }
   *
   * `availableObjects` is optional: the QuickSync webview wizard does not know
   * the org's full object catalogue, so when it is omitted the list is derived
   * from `describeGlobal` (same createable+queryable filter as suggestions).
   */
  private async handleDetectRelationships(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      quickSyncDetectRelationshipsPayloadSchema,
      msg,
      'quicksync:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId ?? '',
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const describeResult = await conn.describe(payload.objectApiName ?? '');

      const fields: DescribeFieldInfo[] = (
        describeResult.fields as Array<{
          name: string;
          type: string;
          referenceTo?: string[];
          relationshipName?: string | null;
        }>
      ).map((f) => ({
        name: f.name,
        type: f.type,
        referenceTo: f.referenceTo ?? [],
        relationshipName: f.relationshipName ?? null,
      }));

      // Fall back to the live org catalogue when the caller cannot provide it.
      const availableObjects =
        payload.availableObjects ??
        (
          (await conn.describeGlobal()).sobjects as Array<{
            name: string;
            createable: boolean;
            queryable: boolean;
          }>
        )
          .filter((s) => s.createable && s.queryable)
          .map((s) => s.name);

      const suggestions = this.relationshipDetector.detect(
        payload.objectApiName ?? '',
        fields,
        payload.alreadySelected ?? [],
        availableObjects,
      );

      const response = buildResponse(this.deps, msg, 'quicksync:detect-relationships:response', {
        suggestions,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'quicksync:detect-relationships', 'quicksync:error', err);
    }
  }

  /**
   * Compute preview (record counts, API call estimates) for selected objects.
   * Payload: { sourceOrgId, selectedObjects, parentObjects }
   */
  private async handlePreview(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      quickSyncPreviewPayloadSchema,
      msg,
      'quicksync:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const allObjects = [...payload.selectedObjects, ...(payload.parentObjects ?? [])];
      const recordCounts: RecordCountResult[] = [];

      for (const objectApiName of allObjects) {
        const result = await conn.query<{ expr0: number }>(`SELECT COUNT() FROM ${objectApiName}`);
        recordCounts.push({
          objectApiName,
          count: result.totalSize ?? 0,
        });
      }

      const parentSet = new Set(payload.parentObjects ?? []);
      const preview = this.previewEstimator.estimate(recordCounts, parentSet);

      const response = buildResponse(this.deps, msg, 'quicksync:preview:response', { preview });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'quicksync:preview', 'quicksync:error', err);
    }
  }

  /**
   * Execute Quick Sync with smart defaults.
   * Payload: { config: QuickSyncConfig }
   *
   * Validates config with Zod, auto-generates field mappings via AutoFieldMapper,
   * builds a full SyncConfig with smart defaults (QSYNC-04), and delegates to
   * the existing sync execution flow.
   */
  private async handleExecute(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      quickSyncExecutePayloadSchema,
      msg,
      'quicksync:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;

    try {
      // Validate with Zod
      const validatedConfig = QuickSyncConfigSchema.parse(payload.config);

      const sourceConn = await getJsforceConnection(
        validatedConfig.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        validatedConfig.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Build per-object configs with auto-field mapping (QSYNC-03)
      const allObjects = [...validatedConfig.selectedObjects, ...validatedConfig.parentObjects];
      const objectConfigs: Array<{
        objectApiName: string;
        operation: string;
        fieldMappings: Array<{ sourceField: string; targetField: string; type: string }>;
        transformRules: never[];
        excludedFields: never[];
        batchSize: number;
        insertOrder: number;
      }> = [];

      for (let i = 0; i < allObjects.length; i++) {
        const objectApiName = allObjects[i];
        const isParent = validatedConfig.parentObjects.includes(objectApiName);

        // Describe both source and target to get field metadata for auto-mapping
        const [sourceDesc, targetDesc] = await Promise.all([
          sourceConn.describe(objectApiName),
          targetConn.describe(objectApiName),
        ]);

        const sourceFields: AutoMapFieldInfo[] = (
          sourceDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>
        )
          .filter((f) => f.createable)
          .map((f) => ({ apiName: f.name, label: f.label, type: f.type }));

        const targetFields: AutoMapFieldInfo[] = (
          targetDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>
        )
          .filter((f) => f.createable)
          .map((f) => ({ apiName: f.name, label: f.label, type: f.type }));

        const suggestions = this.autoFieldMapper.suggest(sourceFields, targetFields);
        const fieldMappings = this.autoFieldMapper.toMappings(suggestions);

        objectConfigs.push({
          objectApiName,
          operation: QUICK_SYNC_DEFAULTS.operation,
          fieldMappings,
          transformRules: [],
          excludedFields: [],
          batchSize: QUICK_SYNC_DEFAULTS.batchSize,
          // Parents get lower insert order
          insertOrder: isParent ? 0 : i + 1,
        });
      }

      // Build full sync config with smart defaults
      const syncConfig = {
        id: msg.id,
        name: `Quick Sync ${new Date().toISOString()}`,
        description: 'Auto-generated by Quick Sync',
        sourceOrgId: validatedConfig.sourceOrgId,
        targetOrgId: validatedConfig.targetOrgId,
        direction: QUICK_SYNC_DEFAULTS.direction,
        mode: QUICK_SYNC_DEFAULTS.mode,
        objects: objectConfigs,
        conflictStrategy: QUICK_SYNC_DEFAULTS.conflictStrategy,
        enableRollback: false,
        dryRun: false,
      };

      sendNotification(
        this.deps,
        'info',
        'Quick Sync',
        `Starting sync of ${allObjects.length} object(s)`,
      );

      // Send built sync config back to the webview.
      // The webview will then dispatch a sync:execute message with this config,
      // delegating to the existing SyncOpsHandler execution flow.
      const response = buildResponse(this.deps, msg, 'quicksync:execute:response', {
        syncConfig: syncConfig as unknown as Record<string, unknown>,
        objectCount: allObjects.length,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'quicksync:execute', 'quicksync:error', err);
    }
  }
}
