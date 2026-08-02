import type { BaseMessage, SeedTemplate, PersonaMsg } from '@sandforge/shared';
import {
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
  RobustnessConfigSchema,
} from '@sandforge/shared';
import type { RobustnessConfig } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
} from './HandlerTypes.js';
import { SeedTemplateStore } from '../../modules/seed/SeedTemplateStore.js';
import { SeedTemplateManager } from '../../modules/seed/SeedTemplateManager.js';
import { AIPersonaManager } from '../../modules/ai/AIPersonaManager.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiConnection, BulkApiExecutorDeps } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BulkJobProgressTracker } from '../../core/engine/BulkJobProgressTracker.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

/** Record count threshold above which streaming pipeline is used per object. */
const STREAMING_THRESHOLD = 10_000;

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
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
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
  private async handleTemplateSave(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { template: Record<string, unknown> } })
        .payload;
      const template = payload.template as unknown as SeedTemplate;

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
      sendHandlerError(this.deps, 'seed:template:save', 'seed:error', err);
    }
  }

  /** Load a seed template by ID. */
  private async handleTemplateLoad(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { id: string } }).payload;
      const template = this.seedTemplateStore.load(payload.id);
      const response = buildResponse(this.deps, msg, 'seed:template:load:response', {
        template: (template as unknown as Record<string, unknown>) ?? null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:load', 'seed:error', err);
    }
  }

  /** List all seed templates (summary view). */
  private async handleTemplateList(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'seed:template:list', 'seed:error', err);
    }
  }

  /** Delete a seed template by ID. */
  private async handleTemplateDelete(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { id: string } }).payload;
      const success = this.seedTemplateStore.delete(payload.id);
      const response = buildResponse(this.deps, msg, 'seed:template:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:delete', 'seed:error', err);
    }
  }

  /**
   * Load and validate robustness configuration from ConfigStore.
   * Falls back to schema defaults when no config is stored.
   */
  private getRobustnessConfig(): RobustnessConfig {
    const raw = this.deps.configStore.get<Partial<RobustnessConfig>>('robustness:config');
    return RobustnessConfigSchema.parse(raw ?? {});
  }

  /** List all built-in and custom personas. */
  private async handleListPersonas(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'seed:list-personas', 'seed:error', err);
    }
  }

  /** Create a custom persona from a text description using AI. */
  private async handleCreatePersona(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { description: string } }).payload;
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
          'AI is disabled. Enable sandforge.ai.enabled and configure your Anthropic API key ' +
            '(SandForge: Configure AI Key) to create custom personas.',
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
      sendHandlerError(this.deps, 'seed:create-persona', 'seed:error', err);
    }
  }

  /**
   * Build the AI call function for seed data generation.
   * When AI is enabled, routes prompts through the unified client (breaker +
   * budget). When AI is disabled — or when a call fails (missing key, open
   * breaker, network) — returns '[]' so FieldMapper gracefully falls back to
   * FakerFallback instead of failing the whole seed operation.
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

  private async handleDescribeGlobal(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;
    const config = this.getRobustnessConfig();

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
      sendHandlerError(this.deps, 'seed:describe-global', 'seed:error', err);
    }
  }

  private async handleDescribeObject(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string; objectApiName: string } })
      .payload;
    const config = this.getRobustnessConfig();

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
      sendHandlerError(this.deps, 'seed:describe-object', 'seed:error', err);
    }
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (
      msg as BaseMessage & {
        payload: { orgId: string; template: Record<string, unknown>; dryRun?: boolean };
      }
    ).payload;
    const operationId = crypto.randomUUID();

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Production guard check
      if (this.deps.infraServices?.productionGuard) {
        const org = this.deps.orgManager.getOrg(payload.orgId);
        const check = this.deps.infraServices.productionGuard.check({
          orgId: payload.orgId,
          orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
          operation: 'insert',
          objectName: 'SeedData',
          recordCount: 1,
          module: 'seed',
        });
        if (!check.allowed) {
          throw new Error(
            `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          );
        }
      }

      // Dry-run mode: skip real inserts, return synthetic result (stays synchronous)
      if (payload.dryRun) {
        const response = buildResponse(this.deps, msg, 'seed:execute:response', {
          success: true,
          dryRun: true,
          insertedCount: 0,
          results: [],
        });
        this.deps.broker.postToWebview(response);
        return;
      }

      // Start performance tracking
      this.deps.infraServices?.performanceTracker?.start(operationId, 'seed');

      const description = 'Seed data generation';
      sendOperationStarted(this.deps, operationId, 'seed', description);

      // Create AbortController for this operation
      const abortController = new AbortController();

      // Build the execution promise (runs detached in the background)
      const executionPromise = this.executeSeed(msg, conn, payload, operationId, abortController);

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
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', err);
    }
  }

  /**
   * Execute seed operation in the background.
   * Extracted from handleExecute to allow detached execution via BackgroundOperationRegistry.
   */
  private async executeSeed(
    msg: BaseMessage,
    conn: Awaited<ReturnType<typeof getJsforceConnection>>,
    payload: { orgId: string; template: Record<string, unknown>; dryRun?: boolean },
    operationId: string,
    abortController: AbortController,
  ): Promise<void> {
    const robustnessConfig = this.getRobustnessConfig();
    let progressTracker: BulkJobProgressTracker | undefined;
    let unsubProgress: (() => void) | undefined;

    try {
      // Build robustness-aware insert function
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      const bulkManager = new BulkApiManager(robustnessConfig.bulk.maxConcurrentJobs);
      progressTracker = new BulkJobProgressTracker(bulkManager);
      unsubProgress = progressTracker.onProgress((progress) => {
        this.deps.broker.postToWebview({
          id: crypto.randomUUID(),
          type: 'execution:progress',
          timestamp: Date.now(),
          payload: progress,
        } as unknown as import('@sandforge/shared').BaseMessage);
      });
      const retryOp = new RetryableOperation({
        retryConfig: robustnessConfig.retry,
        onRetry: (attempt, classified, delay) => {
          this.deps.log(
            `[RETRY] seed insert attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`,
          );
        },
      });
      const handlerDeps = this.deps;

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
              const pct = Math.round((processed / total) * 100);
              sendOperationProgress(
                handlerDeps,
                operationId,
                pct,
                processed,
                total,
                `Streaming insert ${objectApiName}`,
              );
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
              const pct = Math.round((processed / total) * 100);
              sendOperationProgress(
                handlerDeps,
                operationId,
                pct,
                processed,
                total,
                `Bulk insert ${objectApiName}`,
              );
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
            return conn.sobject(objectApiName).create(batch) as Promise<
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
            errors.push(retryResult.error?.message ?? 'Insert failed after retries');
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

      const seedDeps = {
        validator,
        planBuilder,
        fieldMapper,
        referenceLinker,
        insert: insertFn,
        generateId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        services: this.deps.services,
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
        10,
        0,
        1,
        'Validating template and building plan',
      );
      const result = await orchestrator.execute(template, payload.orgId);
      sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Seed complete');
      const totalRecords = (result as { insertedIds?: string[] }).insertedIds?.length ?? 0;
      this.deps.infraServices?.performanceTracker?.update(operationId, totalRecords, 1);
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      sendOperationCompleted(this.deps, operationId, { totalRecords });

      const response = buildResponse(
        this.deps,
        msg,
        'seed:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', err);
    } finally {
      progressTracker?.stopTracking(operationId);
      unsubProgress?.();
      progressTracker?.dispose();
    }
  }
}
