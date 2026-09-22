import type {
  SeedTemplate,
  PersonaMsg,
  SeedExecutionResult,
  SeedExecuteRequest,
} from '@sandforge/shared';
import {
  duplicateRuleHeaders,
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
} from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  GrappeEventEnvelope,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  objectsFailureContext,
  postGrappeEvent,
  readGrappeConfig,
  robustnessConfigOf,
  bulkManagerOf,
} from './HandlerTypes.js';
import { SeedTemplateStore } from '../../modules/seed/SeedTemplateStore.js';
import { SeedTemplateManager } from '../../modules/seed/SeedTemplateManager.js';
import { AIPersonaManager } from '../../modules/ai/AIPersonaManager.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { isNetworkError } from '../../core/common/isNetworkError.js';
import {
  validatePayload,
  seedExecutePayloadSchema,
  seedDescribeGlobalPayloadSchema,
  seedDescribeObjectPayloadSchema,
  seedTemplateIdPayloadSchema,
  seedTemplateSavePayloadSchema,
  seedCreatePersonaPayloadSchema,
} from '../validatePayload.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiConnection, BulkApiExecutorDeps } from '../../core/engine/BulkApiExecutor.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { SeedProgressEvent } from '../../modules/seed/SeedOrchestrator.js';
import { isUncopyableObject } from '@sandforge/shared';

/** Record count threshold above which streaming pipeline is used per object. */
const STREAMING_THRESHOLD = 10_000;

/**
 * Extra `operation:failed` payload for transport-level seed failures.
 *
 * Seeds are INSERTs — replaying a whole template after partial inserts would
 * duplicate records, so failed seeds are NEVER queued for offline replay
 * (sync upserts are quasi-idempotent and keep the auto-replay). On a network
 * error the failure payload carries an explicit hint instead: the user
 * re-runs the template manually from the Seed module once the org is
 * reachable again, with validation and production guards re-applied.
 *
 * Returns undefined for non-network errors (no hint added).
 */
function buildOfflineReplayHint(
  err: unknown,
  operationId: string,
  log: (msg: string) => void,
): Record<string, unknown> | undefined {
  if (!isNetworkError(err)) {
    return undefined;
  }
  log(`[OFFLINE] seed NOT queued for replay (inserts are not idempotent): ${operationId}`);
  return {
    offlineReplayAvailable: false,
    retryHint:
      'Seed operations are not queued for offline replay (inserts are not idempotent — replaying could duplicate records). Re-run the template manually once the org is reachable again.',
  };
}

/**
 * Created ids and error messages posted back per object, at most. The whole
 * lists went over the bridge: a 50,000-record seed serialised 50,000 ids into
 * one message for a results step that shows counts. recordsCreated and
 * recordsFailed keep the totals, and `truncated` says the lists were cut.
 */
const MAX_RESULT_ENTRIES_PER_OBJECT = 1_000;

/** The result as it is posted to the webview, with its per-object lists capped. */
function capResultForBridge(result: SeedExecutionResult): SeedExecutionResult {
  if (!Array.isArray(result.objectResults)) return result;
  return {
    ...result,
    objectResults: result.objectResults.map((objectResult) => {
      const truncated =
        objectResult.createdIds.length > MAX_RESULT_ENTRIES_PER_OBJECT ||
        objectResult.errors.length > MAX_RESULT_ENTRIES_PER_OBJECT;
      if (!truncated) return objectResult;
      return {
        ...objectResult,
        createdIds: objectResult.createdIds.slice(0, MAX_RESULT_ENTRIES_PER_OBJECT),
        errors: objectResult.errors.slice(0, MAX_RESULT_ENTRIES_PER_OBJECT),
        truncated,
      };
    }),
  };
}

/** Message types handled by SeedOpsHandler. */
const SEED_TYPES = new Set([
  'seed:execute',
  'seed:describe-global',
  'seed:describe-object',
  'seed:template:save',
  'seed:template:load',
  'seed:template:list',
  'seed:template:delete',
  'seed:list-personas',
  'seed:create-persona',
]);

/**
 * Domain handler for seed-related webview-to-extension messages.
 *
 * Routes seed:* message types to schema description and data generation
 * operations against Salesforce orgs, with production guard checks,
 * performance tracking, retry, timeout, and bulk API support.
 */
export class SeedOpsHandler implements DomainHandler {
  /** Persistence facade for seed templates. */
  private readonly seedTemplateStore: SeedTemplateStore;

  /** Template manager backed by persistent store. */
  private readonly templateManager: SeedTemplateManager;

  /** AI persona manager for built-in and custom personas. */
  private readonly personaManager: AIPersonaManager;

  /** Background operation registry for detached execution. */
  private registry?: BackgroundOperationRegistry;

  /** Live operation tracker feeding the Monitor "live operations" panel. */
  private liveTracker?: LiveOperationTracker;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.seedTemplateStore = new SeedTemplateStore(deps.configStore);
    this.templateManager = new SeedTemplateManager(
      () => crypto.randomUUID(),
      () => new Date().toISOString(),
      this.seedTemplateStore,
    );
    this.personaManager = new AIPersonaManager();
  }

  /**
   * Set the background operation registry for detached execution.
   * Called from ExtensionHandlers after construction.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /**
   * Inject the live operation tracker so seed executions show up in the
   * Monitor "live operations" panel. Called from ExtensionHandlers.
   *
   * @param tracker - The shared LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SEED_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'seed:describe-global':
        await this.handleDescribeGlobal(msg);
        return true;
      case 'seed:describe-object':
        await this.handleDescribeObject(msg);
        return true;
      case 'seed:execute':
        await this.handleExecute(msg);
        return true;
      case 'seed:template:save':
        await this.handleTemplateSave(msg);
        return true;
      case 'seed:template:load':
        await this.handleTemplateLoad(msg);
        return true;
      case 'seed:template:list':
        await this.handleTemplateList(msg);
        return true;
      case 'seed:template:delete':
        await this.handleTemplateDelete(msg);
        return true;
      case 'seed:list-personas':
        await this.handleListPersonas(msg);
        return true;
      case 'seed:create-persona':
        await this.handleCreatePersona(msg);
        return true;
      default:
        return false;
    }
  }

  /** Save a seed template (create new or update existing). */
  private async handleTemplateSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateSavePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const template = parsed.template as unknown as SeedTemplate;

      if (template.id && this.templateManager.get(template.id)) {
        const updated = this.templateManager.update(template.id, template);
        const response = buildResponse(this.deps, msg, 'seed:template:save:response', {
          success: true,
          id: updated.id,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id}`);
      } else {
        const created = this.templateManager.create(template);
        const response = buildResponse(this.deps, msg, 'seed:template:save:response', {
          success: true,
          id: created.id,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id}`);
      }
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:save', 'seed:error', msg, err);
    }
  }

  /** Load a seed template by ID. */
  private async handleTemplateLoad(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateIdPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const template = this.seedTemplateStore.load(parsed.id);
      const response = buildResponse(this.deps, msg, 'seed:template:load:response', {
        template: (template as unknown as Record<string, unknown>) ?? null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:load', 'seed:error', msg, err);
    }
  }

  /** List all seed templates (summary view). */
  private async handleTemplateList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const templates = this.seedTemplateStore.list();
      const summaries = templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        updatedAt: t.updatedAt,
        objectCount: t.objects.length,
        totalRecords: t.objects.reduce((sum, o) => sum + o.recordCount, 0),
      }));
      const response = buildResponse(this.deps, msg, 'seed:template:list:response', {
        templates: summaries,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:list', 'seed:error', msg, err);
    }
  }

  /** Delete a seed template by ID. */
  private async handleTemplateDelete(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateIdPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const success = this.seedTemplateStore.delete(parsed.id);
      const response = buildResponse(this.deps, msg, 'seed:template:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:delete', 'seed:error', msg, err);
    }
  }

  /** List all built-in and custom personas. */
  private async handleListPersonas(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const builtIn = this.personaManager.getBuiltInPersonas();
      const custom = this.personaManager.getCustomPersonas();
      const personas: PersonaMsg[] = [...builtIn, ...custom].map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        industry: p.industry,
        locale: p.locale,
        dataPatterns: p.dataPatterns,
      }));
      const response = buildResponse(this.deps, msg, 'seed:list-personas:response', { personas });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:list-personas', 'seed:error', msg, err);
    }
  }

  /** Create a custom persona from a text description using AI. */
  private async handleCreatePersona(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCreatePersonaPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const payload = parsed;
      if (!payload.description || payload.description.trim().length === 0) {
        const response = buildResponse(this.deps, msg, 'seed:create-persona:response', {
          persona: {
            id: '',
            name: '',
            description: '',
            industry: '',
            locale: '',
            dataPatterns: {},
          },
          success: false,
          error: 'Description is required to create a custom persona',
        });
        this.deps.broker.postToWebview(response);
        return;
      }

      const services = this.deps.services;
      if (!services?.isAIEnabled()) {
        throw new Error(
          'AI is disabled. Enable sandforge.ai.enabled and add your Anthropic API key in ' +
            'SandForge Settings > AI > API key to create custom personas.',
        );
      }
      // Route through the unified AI client (breaker + budget + redaction).
      // A missing key surfaces AnthropicAdapter's explicit "not configured" error.
      const aiProvider = async (prompt: string): Promise<string> => {
        const result = await services.aiClient().chat({
          messages: [{ role: 'user', content: prompt }],
        });
        return result.text;
      };

      const persona = await this.personaManager.createCustomPersona(
        payload.description,
        aiProvider,
      );
      const personaMsg: PersonaMsg = {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        industry: persona.industry,
        locale: persona.locale,
        dataPatterns: persona.dataPatterns,
      };
      const response = buildResponse(this.deps, msg, 'seed:create-persona:response', {
        persona: personaMsg,
        success: true,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:create-persona', 'seed:error', msg, err);
    }
  }

  /**
   * Build the AI call function for seed data generation.
   * When AI is enabled, routes prompts through the unified client (breaker +
   * budget). When AI is disabled — or when a call fails (missing key, open
   * breaker, token budget, network) — returns '[]': FieldMapper then fills
   * every ai_generate field the call left empty with a generated sentence,
   * so the run continues and the refusal is only logged.
   */
  private buildSeedCallAI(): (prompt: string) => Promise<string> {
    const services = this.deps.services;
    if (!services?.isAIEnabled()) {
      return async () => '[]';
    }
    return async (prompt: string): Promise<string> => {
      try {
        const result = await services.aiClient().chat({
          messages: [{ role: 'user', content: prompt }],
        });
        return result.text;
      } catch (err: unknown) {
        this.deps.log(
          `[AI] seed data generation failed, falling back to faker: ${extractErrorMessage(err)}`,
        );
        return '[]';
      }
    };
  }

  private async handleDescribeGlobal(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedDescribeGlobalPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = robustnessConfigOf(this.deps);

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describeGlobal);
      const result = await timeout.withTimeout('describe-global', () => conn.describeGlobal());

      const objects = result.sobjects
        .filter((s: { createable: boolean }) => s.createable)
        // See SeedCloneHandler: `createable` is not "a copy can make one".
        .filter((s: { name: string }) => !isUncopyableObject(s.name))
        .map((s: { name: string; label: string }) => ({
          apiName: s.name,
          label: s.label,
          recordCount: 0,
          dependencies: [],
        }));

      const response = buildResponse(this.deps, msg, 'seed:describe-global:response', { objects });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:describe-global', 'seed:error', msg, err);
    }
  }

  private async handleDescribeObject(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedDescribeObjectPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = robustnessConfigOf(this.deps);

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const safeObjectName = sanitizeSoqlObjectName(payload.objectApiName);

      const timeout = new TimeoutManager(config.timeouts.describe);
      const result = await timeout.withTimeout('describe-object', () =>
        conn.describe(safeObjectName),
      );

      const fields = (
        result.fields as {
          name: string;
          label: string;
          type: string;
          nillable: boolean;
          defaultedOnCreate: boolean;
          picklistValues?: { value: string }[];
          referenceTo?: string[];
          length: number;
          createable: boolean;
        }[]
      )
        .filter((f) => f.createable)
        .map((f) => ({
          fieldApiName: f.name,
          label: f.label,
          type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          picklistValues: f.picklistValues?.map((pv) => pv.value) ?? [],
          referenceTo: f.referenceTo ?? [],
          length: f.length,
        }));

      const response = buildResponse(this.deps, msg, 'seed:describe-object:response', {
        objectApiName: payload.objectApiName,
        objectLabel: (result as { label: string }).label,
        fields,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:describe-object', 'seed:error', msg, err);
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const validated = validatePayload(seedExecutePayloadSchema, msg, 'seed:error', this.deps);
    if (!validated) return;
    // The declared message type must accept what the schema lets through:
    // this assignment fails to compile when the two drift apart.
    const parsed: SeedExecuteRequest['payload'] & typeof validated = validated;
    // Seed has no dry run. The flag used to return `{ dryRun: true,
    // insertedCount: 0, results: [] }` before generating anything: nothing was
    // written, but nothing was previewed either, and the answer read as a
    // preview that had passed. Refused here, before the org is touched.
    if (parsed.dryRun === true) {
      sendHandlerError(
        this.deps,
        'seed:execute',
        'seed:error',
        msg,
        new Error('Seed has no dry run: remove "dryRun" from this request to run the seed.'),
        { code: 'DRY_RUN_UNSUPPORTED', retryable: false },
      );
      return;
    }
    // The request id is the operation id, as for sync: the page knows the id of
    // the request it sent, so it can match operation:* events and aim
    // execution:abort at its own run rather than whichever run reported last.
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'seed', operation: msg.type };

    try {
      // Fill per-object batch sizes from the `sandforge.seed.defaultBatchSize`
      // setting when the webview omitted them.
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      const objects = parsed.template.objects.map((o) => ({
        ...o,
        batchSize: o.batchSize ?? defaultBatchSize,
      }));
      Object.assign(failure, objectsFailureContext(objects));
      const payload: { orgId: string; template: Record<string, unknown> } = {
        orgId: parsed.orgId,
        template: { ...parsed.template, objects } as unknown as Record<string, unknown>,
      };

      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Planned record total, known upfront from the template. It feeds the
      // Production Guard impact summary (the sentence the user reads in the
      // production confirmation modal) and the Monitor "live operations" panel.
      const plannedRecords = parsed.template.objects.reduce((sum, o) => sum + o.recordCount, 0);

      // Production guard check
      if (this.deps.infraServices?.productionGuard) {
        const guard = this.deps.infraServices.productionGuard;
        const org = this.deps.orgManager.getOrg(payload.orgId);
        const guardRequest = {
          orgId: payload.orgId,
          orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
          operation: 'insert' as const,
          objectName: 'SeedData',
          recordCount: plannedRecords,
          module: 'seed',
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
          // Settle the in-flight useBridgeMutation listener on seed:error
          // (same dual-channel contract as sync — without it the mutation
          // spun until its 120 s timeout). Correlated to the request so the
          // webview can drop stale error responses. The code is stable and
          // SandForge-authored (unlike pass-through Salesforce messages), so
          // the UI can key off it instead of matching English prose.
          sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, new Error(message), {
            code: 'PROD_CONFIRMATION_DECLINED',
            retryable: false,
          });
          sendOperationFailed(this.deps, operationId, message, false, { context: failure });
          return;
        }
      }

      // Start performance tracking
      this.deps.infraServices?.performanceTracker?.start(operationId, 'seed');

      const description = 'Seed data generation';
      sendOperationStarted(this.deps, operationId, 'seed', description);
      // Feed the Monitor "live operations" panel with the same planned total.
      this.liveTracker?.register(operationId, 'seed', description, plannedRecords);

      // Create AbortController for this operation
      const abortController = new AbortController();

      // Build the execution promise (runs detached in the background)
      const executionPromise = this.executeSeed(
        msg,
        conn,
        payload,
        operationId,
        abortController,
        failure,
      );

      // Register with BackgroundOperationRegistry if available
      if (this.registry) {
        this.registry.register(operationId, 'seed', description, executionPromise, abortController);
      } else {
        // Fallback: await directly when no registry is available
        await executionPromise;
      }

      // Return immediately -- execution continues in background
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      // No-op when the operation never reached registration (connection or
      // guard failure happens before sendOperationStarted).
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // Dual channel, single display (same contract as sync): `operation:failed`
      // carries the lifecycle; `seed:error` settles the in-flight webview
      // mutation (useBridgeMutation listens on seed:execute:response /
      // seed:error — without it the user stared at a 120 s timeout). Both
      // carry the offline retryHint on transport failures.
      const offlineHint = buildOfflineReplayHint(err, operationId, this.deps.log);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, err, {
        retryable: true,
        extraPayload: offlineHint,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        extraPayload: offlineHint,
        context: failure,
      });
    }
  }

  /**
   * Execute seed operation in the background.
   * Extracted from handleExecute to allow detached execution via BackgroundOperationRegistry.
   *
   * Failures are reported on `seed:error` + `operation:failed` and converted to
   * a `{ status: 'failure' }` result rather than a rejection — the same
   * contract as executeSync. The registry reads that status and marks the
   * operation 'failed' (resolving `undefined` would mark a failed seed
   * 'completed' and fire a lying "seed completed" notification); a rejection
   * would double-emit on the no-registry fallback path where handleExecute
   * awaits this promise inside its own try/catch.
   */
  private async executeSeed(
    msg: InboundRequest,
    conn: Awaited<ReturnType<typeof getJsforceConnection>>,
    payload: { orgId: string; template: Record<string, unknown> },
    operationId: string,
    abortController: AbortController,
    failure: OperationFailureContext,
  ): Promise<{ status: 'failure' } | void> {
    const robustnessConfig = robustnessConfigOf(this.deps);

    try {
      // Build robustness-aware insert function
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      const bulkManager = bulkManagerOf(this.deps);
      const retryOp = new RetryableOperation({
        retryConfig: robustnessConfig.retry,
        onRetry: (attempt, classified, delay) => {
          this.deps.log(
            `[RETRY] seed insert attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`,
          );
        },
      });
      const handlerDeps = this.deps;
      // Records written before the insert now running, and the run's total,
      // from the orchestrator's report before each object and each partition.
      // The bulk paths count within one insert call; offsetting them keeps the
      // overall bar from dropping back to 0 when the next call starts.
      const runProgress = { base: 0, total: 0 };
      const reportInsertProgress = (processed: number, total: number, step: string): void => {
        const overall = runProgress.base + processed;
        const overallTotal = Math.max(runProgress.total, overall, total, 1);
        const pct = Math.round((overall / overallTotal) * 100);
        sendOperationProgress(handlerDeps, operationId, pct, overall, overallTotal, step);
        this.liveTracker?.updateProgress(operationId, pct, overall, overallTotal, step);
      };

      const insertFn = async (
        _orgId: string,
        objectApiName: string,
        records: Record<string, unknown>[],
        batchSize: number,
      ): Promise<{ successIds: string[]; errors: string[] }> => {
        // Streaming path for large record sets
        if (records.length > STREAMING_THRESHOLD) {
          const chunkedExecutor = new ChunkedBulkExecutor({ signal: abortController.signal });
          const bulkDeps: BulkApiExecutorDeps = {
            connection: conn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              reportInsertProgress(processed, total, `Streaming insert ${objectApiName}`);
            },
          };
          const streamResult = await chunkedExecutor.executeChunked(
            bulkDeps,
            objectApiName,
            'insert',
            chunkedExecutor.createChunkGenerator(records),
            records.length,
          );
          return {
            successIds: streamResult.successIds,
            errors: streamResult.errors,
          };
        }

        if (bulkExecutor.shouldUseBulkApi(records.length)) {
          // Bulk API 2.0 path
          const bulkDeps: BulkApiExecutorDeps = {
            connection: conn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              reportInsertProgress(processed, total, `Bulk insert ${objectApiName}`);
            },
          };
          const bulkResult = await bulkExecutor.executeBulk(
            bulkDeps,
            objectApiName,
            'insert',
            records,
          );
          return {
            successIds: bulkResult.successIds,
            errors: bulkResult.failures.map((f) => f.error),
          };
        }

        // REST API path with retry and batching
        const successIds: string[] = [];
        const errors: string[] = [];

        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            // Seeded rows are invented and land in an org that may already
            // hold rows like them — a duplicate rule stops exactly that. Forge
            // learnt it in 1.25.3 and Sync in 1.28.0; a hundred seeded
            // contacts were refused here for want of the same header. A
            // unique index still refuses, which is right.
            return conn
              .sobject(objectApiName)
              .create(batch, { headers: duplicateRuleHeaders(true) }) as Promise<
              Array<{ success: boolean; id?: string; errors?: Array<{ message: string }> }>
            >;
          });

          if (retryResult.success && retryResult.result) {
            for (const r of retryResult.result) {
              if (r.success && r.id) {
                successIds.push(r.id);
              } else {
                errors.push(r.errors?.[0]?.message ?? 'Unknown insert error');
              }
            }
          } else {
            // The whole batch is lost, not one record: `errors.length` is what
            // SeedOrchestrator reports as recordsFailed, so a single push made
            // a 180-record wipe-out read as "1 failed".
            const failMsg = retryResult.error?.message ?? 'Insert failed after retries';
            for (let k = 0; k < batch.length; k++) {
              errors.push(failMsg);
            }
          }
        }

        return { successIds, errors };
      };

      // Lazy-import seed dependencies
      const { SeedValidator } = await import('../../modules/seed/SeedValidator.js');
      const { DataPlanBuilder } = await import('../../modules/seed/DataPlanBuilder.js');
      const { FieldMapper } = await import('../../modules/seed/FieldMapper.js');
      const { ReferenceLinker } = await import('../../modules/seed/ReferenceLinker.js');
      const { AIDataGenerator } = await import('../../modules/seed/AIDataGenerator.js');
      const { FakerFallback } = await import('../../modules/seed/FakerFallback.js');

      const aiGenerator = new AIDataGenerator(this.buildSeedCallAI());
      const fakerFallback = new FakerFallback();
      const fieldMapper = new FieldMapper({ aiGenerator, fakerFallback });
      const referenceLinker = new ReferenceLinker();
      const validator = new SeedValidator();
      const planBuilder = new DataPlanBuilder();

      const { SeedGrappeAdapter } = await import('../../modules/seed/SeedGrappeAdapter.js');

      const grappeConfig = readGrappeConfig(this.deps.services);

      // One describe of the org per object, kept for the run. A template names
      // fields an org may not have: without this, one missing field refuses
      // every record of the object. See `describeCreateableFields`.
      const creatableByObject = new Map<string, ReadonlySet<string>>();
      const describeCreateableFields = async (
        objectApiName: string,
      ): Promise<ReadonlySet<string>> => {
        const cached = creatableByObject.get(objectApiName);
        if (cached) return cached;
        const described = await conn.describe(objectApiName);
        const names = new Set(
          (described.fields as Array<{ name: string; createable?: boolean }>)
            .filter((f) => f.createable === true)
            .map((f) => f.name),
        );
        creatableByObject.set(objectApiName, names);
        return names;
      };

      const seedDeps = {
        validator,
        describeCreateableFields,
        planBuilder,
        fieldMapper,
        referenceLinker,
        insert: insertFn,
        generateId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        services: this.deps.services,
        // Grappe stays sequential unless `sandforge.grappe.enabled` is on AND
        // the template crosses the threshold — but adapter, config and callback
        // must all be present, or the Grappe page renders an empty shell.
        grappeAdapter: new SeedGrappeAdapter(() => crypto.randomUUID(), grappeConfig?.grappeSize),
        grappeConfig,
        onGrappeEvent: (event: GrappeEventEnvelope) => postGrappeEvent(this.deps, event),
        onProgress: (event: SeedProgressEvent) => {
          runProgress.base = event.processedRecords;
          runProgress.total = event.totalRecords;
          reportInsertProgress(0, event.totalRecords, `Insert ${event.objectApiName}`);
        },
      };
      if (!this.deps.services) {
        throw new Error(
          'SeedOpsHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      const orchestrator = this.deps.services.seedOrchestrator(seedDeps);

      const template = payload.template as unknown as import('@sandforge/shared').SeedTemplate;
      sendOperationProgress(
        this.deps,
        operationId,
        0,
        0,
        1,
        'Validating template and building plan',
      );
      const result = await orchestrator.execute(template, payload.orgId);
      sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Seed complete');
      // What the orchestrator reports it wrote. A cast to an `insertedIds`
      // array no result ever carried reported every finished run as 0 records.
      const totalRecords = result.totalRecordsCreated;
      this.deps.infraServices?.performanceTracker?.update(operationId, totalRecords, 1);
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      sendOperationCompleted(this.deps, operationId, { totalRecords });
      this.liveTracker?.complete(operationId);

      const response = buildResponse(
        this.deps,
        msg,
        'seed:execute:response',
        capResultForBridge(result) as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // Dual channel, single display (see handleExecute): seed:error settles
      // the in-flight webview mutation, operation:failed carries the
      // lifecycle. Both carry the offline retryHint on transport failures.
      const offlineHint = buildOfflineReplayHint(err, operationId, this.deps.log);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, err, {
        retryable: true,
        extraPayload: offlineHint,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        extraPayload: offlineHint,
        context: failure,
      });
      // Failure-status result (not a rejection, not a bare resolve) so the
      // BackgroundOperationRegistry marks the operation 'failed' — see the
      // method docstring for the contract.
      return { status: 'failure' };
    }
  }
}
