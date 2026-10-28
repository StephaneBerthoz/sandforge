import type {
  AuditOutcome,
  CompiledScenario,
  GuardDecision,
  ScenarioCompileOptions,
  ScenarioPack,
  SeedTemplate,
  PersonaMsg,
  SeedExecutionResult,
  SeedExecuteRequest,
  SeedScenarioRunInfo,
  SeedScenarioTestFileOutcome,
} from '@sandforge/shared';
import { integerDigitsOf, sanitizeSoqlObjectName, guardTierOf } from '@sandforge/shared';
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
  PRODUCTION_GUARD_MISSING,
  GUARD_REFUSAL,
  guardBlockedError,
  guardRefusalCode,
  syntheticRequest,
  ABORTED_BEFORE_START,
} from './HandlerTypes.js';
import {
  PIPELINE_SEED_REFUSAL,
  pipelineSeedAsked,
  pipelineSeedRefusal,
  pipelineSeedTierRefusal,
  type PipelineSeedOutcome,
  type PipelineSeedRequest,
  type SeedAsked,
} from './seedPipeline.js';
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
  seedAutomationPayloadSchema,
  seedTemplatePayloadSchema,
  seedScenarioPacksPayloadSchema,
  seedScenarioPreparePayloadSchema,
  seedScenarioExecutePayloadSchema,
  seedScenarioAgentsPayloadSchema,
  seedScenarioSavePayloadSchema,
  seedScenarioTestFilePayloadSchema,
} from '../validatePayload.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { seedInsert, type SeedInsertConnection } from '../../modules/seed/seedInsert.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { InsertResult, SeedProgressEvent } from '../../modules/seed/SeedOrchestrator.js';
import type { SeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
import {
  personRecordTypes,
  seedRecordTypeOptions,
  templateForAccountKinds,
} from '../../modules/seed/seedRecordTypes.js';
import { ACCOUNT, leftOutForAccountKind } from '../../core/common/platformRecords.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import {
  withGivenAnswer,
  type ProductionGuard,
  type RunConfirmationAnswer,
  type WriteConfirmation,
} from '../../core/precheck/ProductionGuard.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { seedStorageGate } from '../../modules/seed/seedStorage.js';
import {
  API_BUDGET_EXCEEDED,
  confirmationApiOf,
  confirmationStorageOf,
  formatMB,
  readEmailLimits,
} from '../../modules/forge/ForgeRunGate.js';
import {
  readSeedAutomation,
  seedAutomationLines,
  seedEmailGate,
  type SeedAutomationRead,
} from '../../modules/seed/seedAutomation.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { seedLocaleOf } from '../../modules/seed/seedLocale.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import { isUncopyableObject } from '@sandforge/shared';
import type { ToolingQueries } from '../../modules/seed/scenario/scenarioOrg.js';
import type { KnowledgeOrg } from '../../modules/seed/seedKnowledge.js';

/** The code a seed refused for the data storage it takes is answered with. */
const SEED_STORAGE_EXCEEDED = 'SEED_STORAGE_EXCEEDED';

/** The code a seed refused for the emails its records make the org send is answered with. */
const SEED_EMAILS_EXCEEDED = 'SEED_EMAILS_EXCEEDED';

/** The code a seed the user declined at its write question is answered with. */
const SEED_WRITE_DECLINED = 'SEED_WRITE_DECLINED';

/**
 * How long reading what the org runs as a seed's records are created may
 * take, before the confirmation and before the run: as a removal's sweep
 * reads it. Past it, the read is said to have failed, and the seed is not
 * held back.
 */
const AUTOMATION_TIMEOUT_MS = 60_000;

/** What a seed runs with once its request is read. */
interface SeedRunPayload {
  orgId: string;
  template: Record<string, unknown>;
  /** The objects written as person accounts (`templateForAccountKinds`). */
  personObjects: string[];
  /** The locale its people and places are drawn in. */
  locale: string;
}

/**
 * Why a seed is not run, found before its first write: what the page's
 * `seed:error` says, and what its `operation:failed` says when the refusal
 * ends the run's lifecycle; a pipeline's step fails with the message.
 */
interface SeedRefusal {
  code: string;
  message: string;
  /** What the page's `seed:error` carries beside its code. */
  extraPayload?: Record<string, unknown>;
  /** Set when `operation:failed` follows: whether SandForge worded the refusal (`authored`). */
  failed?: { authored: boolean };
}

/** A seed held to every gate before its first write, ready to run. */
interface SeedCleared {
  conn: Awaited<ReturnType<typeof getJsforceConnection>>;
  /** What the run runs with: the template as the org takes it, and its locale. */
  run: SeedRunPayload;
  plannedRecords: number;
  guardDecision: GuardDecision;
  /** What the org runs as the records are created, or why it could not be read. */
  automation: SeedAutomationRead;
  /** The org, as the user knows it. */
  orgName: string;
  /** What could not be read or counted, the seed going on: each said in the log. */
  warnings: string[];
}

/**
 * Who answers the question a seed puts before its first write, when the org
 * would not say what storage it has left or the run would leave it short of
 * today's API requests; and what comes of a question nobody could answer.
 */
interface SeedQuestions {
  ask: (guard: ProductionGuard, question: WriteConfirmation) => Promise<RunConfirmationAnswer>;
  /** `goOn` for the page's seed, said in the log; `refuse` for a pipeline's, which nobody watches. */
  unanswered: 'goOn' | 'refuse';
}

/** The Seed page's: its user, through the guard's confirmation. */
const PANEL_QUESTIONS: SeedQuestions = {
  ask: (guard, question) => guard.confirmRun(question),
  unanswered: 'goOn',
};

/** How a seed's run ended: its result, whole, or what it failed with. */
type SeedRunEnd = { result: SeedExecutionResult } | { error: unknown };

/** What a scenario's seed hands the run beside its template: what its companion file is made from. */
interface ScenarioSeedRun {
  pack: ScenarioPack;
  /** The options the pack was compiled with, as the page sent them. */
  options: ScenarioCompileOptions;
  compiled: CompiledScenario;
}

/** What a pipeline's Seed step hands the run beside what the page's does. */
interface SeedPipelineRun {
  /** The pipeline, which the run's file names. */
  pipeline: { name: string };
  /** Told how the run ended, once the page has been. */
  ended: (end: SeedRunEnd) => void;
}

/** Why a pipeline's seed needed an answer before its first write, in a phrase. */
function unansweredWhy(storage: Awaited<ReturnType<typeof seedStorageGate>>, org: string): string {
  const why: string[] = [];
  if (storage.check.verdict === 'unread') {
    why.push(`the data storage ${org} has left could not be read (${storage.check.unread})`);
  }
  if (storage.api.verdict === 'near') {
    why.push(
      `it would leave ${org} ${storage.api.remaining - storage.api.estimate} of its ` +
        `${storage.api.max} daily API requests`,
    );
  }
  return why.join(', and ');
}

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

/** A connection's Tooling API query and its next pages, as an agent's catalog is read through. */
function toolingOf(conn: Awaited<ReturnType<typeof getJsforceConnection>>): ToolingQueries {
  return {
    query: async (soql) => conn.tooling.query<Record<string, unknown>>(soql),
    queryMore: async (url) => conn.tooling.queryMore<Record<string, unknown>>(url),
  };
}

/** Why a seed that wrote nothing failed: the first thing one of its objects was refused for. */
function seedFailureReason(result: SeedExecutionResult): string {
  const first = result.objectResults.flatMap((object) => object.errors)[0];
  return first ?? 'The seed wrote no records.';
}

/** Message types handled by SeedOpsHandler. */
const SEED_TYPES = new Set([
  'seed:execute',
  'seed:automation',
  'seed:describe-global',
  'seed:describe-object',
  'seed:template:save',
  'seed:template:load',
  'seed:template:list',
  'seed:template:delete',
  'seed:list-personas',
  'seed:create-persona',
  'seed:scenario:packs',
  'seed:scenario:prepare',
  'seed:scenario:execute',
  'seed:scenario:agents',
  'seed:scenario:save',
  'seed:scenario:test-file',
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

  /** What each run created, kept on disk for its removal. */
  private runCreations?: SeedRunCreations;

  /**
   * Reads what the org runs as a seed's records are created: a reader of the
   * handler's own, over its connections, loaded on its first read, off the
   * activation path.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };

  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

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
   * Where each run keeps what it created, whole, for its removal from the
   * results (`seed:remove`): the results the page gets carry the first
   * thousand ids of an object at most.
   */
  setRunCreations(store: SeedRunCreations): void {
    this.runCreations = store;
  }

  /**
   * The runs this window is writing now, by the id their creations are kept
   * under: kept as they write, they have no end until they end, and the list
   * of earlier seeds read one as a run whose window had closed.
   */
  private readonly runningRuns = new Set<string>();

  /** Whether the run kept under `runId` is still writing, in this window. */
  isRunning(runId: string): boolean {
    return this.runningRuns.has(runId);
  }

  /** Another reader of what the org runs as a seed's records are created than the handler's own. */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
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

  /**
   * What the org runs as a seed creates the records of `objects`, and the
   * daily email limits it has left when a record sends any; a read that fails
   * or takes too long says why, and holds nothing back.
   *
   * @param transport - The org's connection, which reads its limits.
   * @param org - The org, as the panel names it.
   */
  private readAutomation(
    orgId: string,
    transport: Parameters<typeof readEmailLimits>[0],
    objects: readonly string[],
    org: string,
  ): Promise<SeedAutomationRead> {
    const reader = this.targetAutomation;
    return readSeedAutomation({
      org,
      objects,
      readAutomation: (names) =>
        new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('seed automation', () =>
          reader.read(orgId, names),
        ),
      readLimits: () => readEmailLimits(transport),
    });
  }

  /**
   * `seed:automation`: what the org runs as a seed creates the records of the
   * objects named — the confirmation's account of it, before Start — read
   * only. A read the org refuses in part is answered with what was read and
   * what was not; one that cannot run at all, on `seed:automation:error`.
   */
  private async handleAutomation(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const validated = validatePayload(
      seedAutomationPayloadSchema,
      msg,
      'seed:automation:error',
      this.deps,
    );
    if (!validated) return;
    try {
      const conn = await getJsforceConnection(
        validated.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const org = this.deps.orgManager.getOrg(validated.orgId);
      const read = await this.readAutomation(
        validated.orgId,
        conn,
        validated.objects,
        org?.alias || org?.username || validated.orgId,
      );
      if ('error' in read) throw new Error(read.error);
      const response = buildResponse(this.deps, msg, 'seed:automation:response', {
        orgId: validated.orgId,
        objects: validated.objects,
        preview: read.preview as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:automation', 'seed:automation:error', msg, err, {
        retryable: true,
      });
    }
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
      case 'seed:automation':
        await this.handleAutomation(msg);
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
      case 'seed:scenario:packs':
        await this.handleScenarioPacks(msg);
        return true;
      case 'seed:scenario:prepare':
        await this.handleScenarioPrepare(msg);
        return true;
      case 'seed:scenario:execute':
        await this.handleScenarioExecute(msg);
        return true;
      case 'seed:scenario:agents':
        await this.handleScenarioAgents(msg);
        return true;
      case 'seed:scenario:save':
        await this.handleScenarioSave(msg);
        return true;
      case 'seed:scenario:test-file':
        await this.handleScenarioTestFile(msg);
        return true;
      default:
        return false;
    }
  }

  /** The folders of the workspace, in VS Code's order: where packs and test files are. */
  private workspaceFolders(): string[] {
    return this.deps.services?.getWorkspaceFolders?.() ?? [];
  }

  /** Answer a scenario request on its response channel. */
  private answerScenario(
    msg: InboundRequest,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const response = buildResponse(this.deps, msg, type, payload);
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * `seed:scenario:packs`: the packs SandForge ships, then the workspace's
   * `*.sandforge-scenario.json` files, each read or said why it is not one.
   */
  private async handleScenarioPacks(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!validatePayload(seedScenarioPacksPayloadSchema, msg, 'seed:error', this.deps)) return;
    try {
      const { listScenarioPacks, nodeScenarioPackFiles } =
        await import('../../modules/seed/scenario/scenarioPackFiles.js');
      const folders = this.workspaceFolders();
      const packs = await listScenarioPacks(nodeScenarioPackFiles(), folders);
      this.answerScenario(msg, 'seed:scenario:packs:response', {
        packs,
        workspace: folders.length > 0,
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:scenario:packs', 'seed:error', msg, err);
    }
  }

  /**
   * `seed:scenario:prepare`: the pack compiled for an org, read only — its
   * case statuses, what its articles can hold — so the confirmation says
   * what the run writes, and the run is sent with what was read.
   */
  private async handleScenarioPrepare(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedScenarioPreparePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const { prepareScenario, readScenarioCaseStatus, scenarioKnowledge } =
        await import('../../modules/seed/scenario/scenarioOrg.js');
      const { seedObjectAccess } = await import('../../modules/seed/seedObjectAccess.js');
      const caseStatus = await readScenarioCaseStatus(
        async (soql) => (await conn.query<Record<string, unknown>>(soql)).records,
      );
      const knowledge = await scenarioKnowledge(seedObjectAccess(conn), (objectApiName) =>
        conn.describe(objectApiName),
      );
      const prepared = prepareScenario(parsed.pack, {
        caseStatus,
        knowledge,
        ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
        ...(parsed.articleBodyField !== undefined
          ? { articleBodyField: parsed.articleBodyField }
          : {}),
      });
      this.answerScenario(msg, 'seed:scenario:prepare:response', { ...prepared });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:scenario:prepare', 'seed:error', msg, err, {
        retryable: true,
      });
    }
  }

  /**
   * `seed:scenario:execute`: seed an org from a pack, compiled here again
   * with the options its preparation answered, through every gate a
   * template's seed goes through, and answered as one: `seed:execute:response`
   * once it has ended, its `scenario` set, or `seed:error`.
   */
  private async handleScenarioExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedScenarioExecutePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const { compileScenario, ScenarioCompileError } =
      await import('../../modules/seed/scenario/compileScenario.js');
    let compiled: CompiledScenario;
    try {
      compiled = compileScenario(parsed.pack, parsed.options);
    } catch (err: unknown) {
      if (!(err instanceof ScenarioCompileError)) throw err;
      sendHandlerError(this.deps, 'seed:scenario:execute', 'seed:error', msg, err, {
        code: 'SCENARIO_INVALID',
        retryable: false,
      });
      return;
    }
    // Held to what any template the page sends is held to.
    const template = seedTemplatePayloadSchema.safeParse(compiled.template);
    if (!template.success) {
      sendHandlerError(
        this.deps,
        'seed:scenario:execute',
        'seed:error',
        msg,
        new Error(
          `The scenario compiled to a template the seed refuses: ${template.error.issues[0]?.message ?? 'invalid'}`,
        ),
        { code: 'SCENARIO_INVALID', retryable: false },
      );
      return;
    }
    await this.runAsked(
      msg,
      {
        orgId: parsed.orgId,
        template: template.data,
        ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
      },
      { pack: parsed.pack, options: parsed.options, compiled },
    );
  }

  /**
   * A scenario's companion file, written beside its run's once the run has
   * ended: the open cases' ids by key, which its test file is written from.
   * No file for a run that wrote no open case; a file that cannot be written
   * is said, and the run ends as it did.
   */
  private async keepScenario(
    result: SeedExecutionResult,
    scenario: ScenarioSeedRun,
    caseIds: Readonly<Record<string, string>>,
  ): Promise<SeedScenarioRunInfo> {
    const { compiled, pack } = scenario;
    const openCases = compiled.tests.filter((test) => test.openCase !== undefined);
    const openCaseKeys = new Set(openCases.map((test) => test.openCase?.caseKey));
    const openCasesWritten = Object.keys(caseIds).filter((key) => openCaseKeys.has(key)).length;
    const info = {
      packId: pack.id,
      packName: pack.name,
      tests: compiled.tests.length,
      openCasesWritten,
      openCases: openCaseKeys.size,
    };
    if (openCasesWritten === 0) return { ...info, companion: { kind: 'none' } };
    const store = this.runCreations;
    if (!store) {
      return {
        ...info,
        companion: { kind: 'failed', message: 'The runs are not kept in this window.' },
      };
    }
    try {
      const { nodeScenarioSidecarFiles, scenarioRunSidecar, writeScenarioRunSidecar } =
        await import('../../modules/seed/scenario/scenarioRunSidecar.js');
      await writeScenarioRunSidecar(
        nodeScenarioSidecarFiles(),
        store.storagePath,
        scenarioRunSidecar({
          runId: result.operationId,
          pack,
          compiled,
          options: scenario.options,
          caseIds,
        }),
      );
      return { ...info, companion: { kind: 'kept' } };
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(
        `[WARN] seed:scenario:execute ${result.operationId}: the companion file could not be ` +
          `written, so its test file cannot be: ${message}`,
      );
      return { ...info, companion: { kind: 'failed', message } };
    }
  }

  /**
   * `seed:scenario:agents`: an org's Agentforce agents, by SOQL on the
   * catalog objects alone, with where a test file would be written and the
   * org's Case picklist values. Read only; an org without an agent is
   * answered so, not refused.
   */
  private async handleScenarioAgents(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedScenarioAgentsPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const { readAgentCatalog } = await import('../../modules/agentforce/agentCatalog.js');
      const { scenarioCasePicklists, toolingQueryAll } =
        await import('../../modules/seed/scenario/scenarioOrg.js');
      const { scenarioProjectOf } = await import('../../modules/seed/scenario/scenarioTestFile.js');
      const read = await readAgentCatalog(toolingQueryAll(toolingOf(conn)));
      const casePicklists = await scenarioCasePicklists((objectApiName) =>
        conn.describe(objectApiName),
      );
      this.answerScenario(msg, 'seed:scenario:agents:response', {
        orgId: parsed.orgId,
        agents: read.kind === 'agents' ? { kind: 'agents', agents: read.catalog.agents } : read,
        project: await scenarioProjectOf(this.workspaceFolders()),
        ...(casePicklists ? { casePicklists } : {}),
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:scenario:agents', 'seed:error', msg, err, {
        retryable: true,
      });
    }
  }

  /** `seed:scenario:save`: save a reviewed pack in the workspace, never over a file there unless told. */
  private async handleScenarioSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedScenarioSavePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const { nodeScenarioPackFiles, saveScenarioPack } =
        await import('../../modules/seed/scenario/scenarioPackFiles.js');
      const outcome = await saveScenarioPack(
        nodeScenarioPackFiles(),
        this.workspaceFolders(),
        parsed.pack,
        parsed.overwrite === true,
      );
      this.answerScenario(msg, 'seed:scenario:save:response', { outcome });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:scenario:save', 'seed:error', msg, err);
    }
  }

  /**
   * `seed:scenario:test-file`: write the Agentforce test file of a
   * scenario's run into the workspace, for the org the run wrote to, as
   * its companion file and the pack it was seeded from make it. Never
   * deployed, never run: the commands that do are answered for the page.
   */
  private async handleScenarioTestFile(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedScenarioTestFilePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const answer = (outcome: SeedScenarioTestFileOutcome): void =>
      this.answerScenario(msg, 'seed:scenario:test-file:response', {
        runId: parsed.runId,
        outcome,
      });
    try {
      const store = this.runCreations;
      const run = store ? await store.get(parsed.runId) : undefined;
      const org = run ? this.deps.orgManager.getOrg(run.targetOrgId) : undefined;
      if (!store || !run || !org) {
        answer({
          kind: 'unavailable',
          reason: 'run-unknown',
          message: !run
            ? 'Nothing of this run is kept any more.'
            : 'The org this run wrote to is no longer connected to SandForge.',
        });
        return;
      }
      const conn = await getJsforceConnection(
        run.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const { readAgentCatalog } = await import('../../modules/agentforce/agentCatalog.js');
      const { nodeAgentTestSpecFiles } = await import('../../modules/agentforce/testSpecWriter.js');
      const { toolingQueryAll } = await import('../../modules/seed/scenario/scenarioOrg.js');
      const { findScenarioPack, nodeScenarioPackFiles } =
        await import('../../modules/seed/scenario/scenarioPackFiles.js');
      const { nodeScenarioSidecarFiles } =
        await import('../../modules/seed/scenario/scenarioRunSidecar.js');
      const { scenarioProjectOf, writeRunTestFile } =
        await import('../../modules/seed/scenario/scenarioTestFile.js');
      const folders = this.workspaceFolders();
      const outcome = await writeRunTestFile(
        { sidecar: nodeScenarioSidecarFiles(), spec: nodeAgentTestSpecFiles() },
        {
          runId: parsed.runId,
          storagePath: store.storagePath,
          project: await scenarioProjectOf(folders),
          alias: org.alias || org.username || run.targetOrgId,
          choice: parsed.choice,
          ...(parsed.overwrite !== undefined ? { overwrite: parsed.overwrite } : {}),
          readCatalog: () => readAgentCatalog(toolingQueryAll(toolingOf(conn))),
          findPack: (packId, fingerprint) =>
            findScenarioPack(nodeScenarioPackFiles(), folders, packId, fingerprint),
        },
      );
      answer(outcome);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:scenario:test-file', 'seed:error', msg, err, {
        retryable: true,
      });
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
   * breaker, token budget, network, or an answer the model declined, cut off
   * or left empty) — returns '[]': FieldMapper then fills every ai_generate
   * field the call left empty with a generated sentence, so the run continues
   * and the refusal is only logged.
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
          precision?: number;
          scale?: number;
          digits?: number;
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
          integerDigits: integerDigitsOf(f),
          // The wizard gives each field its first rule from this description
          // alone, and a name field holds a person's name on a contact and a
          // company's on an account.
          objectApiName: payload.objectApiName,
        }));

      // The record types the panel lets a seed choose, a person account's
      // marked: it offered none, and person accounts were seeded from the
      // command line only.
      const recordTypes = seedRecordTypeOptions(
        safeObjectName,
        (result as { recordTypeInfos?: unknown }).recordTypeInfos,
        safeObjectName === ACCOUNT ? await personRecordTypes(conn) : [],
      );
      const response = buildResponse(this.deps, msg, 'seed:describe-object:response', {
        objectApiName: payload.objectApiName,
        objectLabel: (result as { label: string }).label,
        fields,
        recordTypes,
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
    await this.runAsked(msg, parsed);
  }

  /**
   * Run a seed the page asked for — a template's, or a scenario's compiled —
   * held to its gates, in the background.
   *
   * @param scenario - The pack the template was compiled from, for a scenario's seed.
   */
  private async runAsked(
    msg: InboundRequest,
    parsed: SeedAsked,
    scenario?: ScenarioSeedRun,
  ): Promise<void> {
    // The request id is the operation id, as for sync: the page knows the id of
    // the request it sent, so it can match operation:* events and aim
    // execution:abort at its own run rather than whichever run reported last.
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'seed', operation: msg.type };

    try {
      const cleared = await this.clearSeed(parsed, operationId, failure, PANEL_QUESTIONS);
      if ('refusal' in cleared) {
        // Settle the in-flight useBridgeMutation listener on seed:error (same
        // dual-channel contract as sync — without it the mutation spun until
        // its 120 s timeout), correlated to the request so the webview can
        // drop stale error responses; and end the run's lifecycle when the
        // refusal has one.
        const { refusal } = cleared;
        sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, new Error(refusal.message), {
          code: refusal.code,
          retryable: false,
          ...(refusal.extraPayload ? { extraPayload: refusal.extraPayload } : {}),
        });
        if (refusal.failed) {
          sendOperationFailed(this.deps, operationId, refusal.message, false, {
            context: failure,
            ...(refusal.failed.authored ? { authored: true } : {}),
          });
        }
        return;
      }

      const description = scenario
        ? `Seed of the scenario ${scenario.pack.name}`
        : 'Seed data generation';
      const { abortController, execution } = this.beginSeed(
        msg,
        cleared,
        operationId,
        failure,
        description,
        undefined,
        scenario,
      );

      // Register with BackgroundOperationRegistry if available
      if (this.registry) {
        this.registry.register(operationId, 'seed', description, execution, abortController);
      } else {
        // Fallback: await directly when no registry is available
        await execution;
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
        code: guardRefusalCode(err),
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
   * Hold a seed to everything it is held to before its first write, the Seed
   * page's and a pipeline's alike: the record types it writes accounts as,
   * the data storage and the daily API requests the org has left, the emails
   * its records make the org send, Production Guard, and the question put
   * when the storage could not be read or the requests would run short. Each
   * stop is recorded in the audit trail here; the caller says it, on the
   * page's channels or as the step's failure. A refusal of the guard is
   * thrown, as every write path throws it.
   *
   * @param asked - The seed as it was asked for.
   * @param failure - The run's failure context, given the objects it writes.
   * @param questions - Who answers the question before the first write.
   */
  private async clearSeed(
    asked: SeedAsked,
    operationId: string,
    failure: OperationFailureContext,
    questions: SeedQuestions,
  ): Promise<SeedCleared | { refusal: SeedRefusal }> {
    // Fill per-object batch sizes from the `sandforge.seed.defaultBatchSize`
    // setting when the webview omitted them.
    const defaultBatchSize =
      this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
    const objects = asked.template.objects.map((o) => ({
      ...o,
      batchSize: o.batchSize ?? defaultBatchSize,
    }));
    Object.assign(failure, objectsFailureContext(objects));
    const conn = await getJsforceConnection(
      asked.orgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );

    // Each account written as the kind its record types give it, as the
    // command line writes them: a person account without Name, a business
    // account without a person's fields. A person type and a business type
    // chosen together are refused before the guard is asked or anything is
    // written.
    const asTemplate = { ...asked.template, objects } as unknown as SeedTemplate;
    const kinds = asTemplate.objects.some((o) => o.objectApiName === ACCOUNT)
      ? templateForAccountKinds(asTemplate, await personRecordTypes(conn))
      : { template: asTemplate, personObjects: [] };
    if ('refusal' in kinds) {
      return { refusal: { code: 'RECORD_TYPES_MIXED', message: kinds.refusal } };
    }
    const payload: SeedRunPayload = {
      orgId: asked.orgId,
      template: kinds.template as unknown as Record<string, unknown>,
      personObjects: kinds.personObjects,
      // The people and places of a seed are drawn in the org's own locale
      // unless the request names one: the panel drew every seed in en_US.
      locale: await seedLocaleOf(asked.locale, conn),
    };

    // Planned record total, known upfront from the template. It feeds the
    // Production Guard impact summary (the sentence the user reads in the
    // production confirmation modal) and the Monitor "live operations" panel.
    const plannedRecords = asked.template.objects.reduce((sum, o) => sum + o.recordCount, 0);
    /** What could not be read or counted, the seed going on: each said in the log. */
    const warnings: string[] = [];
    const warn = (line: string): void => {
      warnings.push(line);
      this.deps.log(`[WARN] seed:execute ${operationId}: ${line}`);
    };

    // The storage the records take against what the org has left, before the
    // guard is asked and before anything is written: a template three times
    // a Developer Edition's 5 MB filled the org part way through its run.
    const org = this.deps.orgManager.getOrg(payload.orgId);
    const storage = await seedStorageGate(
      conn,
      kinds.template,
      kinds.personObjects,
      org?.alias ?? payload.orgId,
    );
    if (storage.check.verdict === 'unread') {
      warn(
        `the data storage the org has left could not be read (${storage.check.unread}): ` +
          'whether the records fit is not known',
      );
    }
    if (storage.refusal) {
      const code =
        storage.refusedFor === 'apiRequests' ? API_BUDGET_EXCEEDED : SEED_STORAGE_EXCEEDED;
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'stopped',
        code,
      });
      const check = storage.check;
      return {
        refusal: {
          code,
          message: storage.refusal,
          extraPayload:
            check.verdict === 'unread' || code === API_BUDGET_EXCEEDED
              ? {}
              : {
                  estimateMB: Number(formatMB(check.estimateMB)),
                  remainingMB: check.remainingMB,
                  maxMB: check.maxMB,
                  org: org?.alias ?? payload.orgId,
                },
          failed: { authored: true },
        },
      };
    }

    // The emails the records make the org send, against what it has left
    // today, read with what it runs as they are created, before the guard is
    // asked and before anything is written: a seed of 75 contacts left a
    // Developer Edition at -60 of its 15 single emails, its workflow rule
    // emailing each one. A read that fails is said, and holds nothing back.
    const orgName = org?.alias || org?.username || payload.orgId;
    const written = kinds.template.objects.map((o) => ({
      objectApiName: o.objectApiName,
      recordCount: o.recordCount,
    }));
    const automation = await this.readAutomation(
      payload.orgId,
      conn,
      written.map((o) => o.objectApiName),
      orgName,
    );
    const emails = seedEmailGate(automation, written, orgName);
    for (const line of emails.unknown ?? []) warn(line);
    if (emails.refusal) {
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'stopped',
        code: SEED_EMAILS_EXCEEDED,
      });
      return {
        refusal: {
          code: SEED_EMAILS_EXCEEDED,
          message: emails.refusal,
          extraPayload: emails.figures ? { ...emails.figures } : {},
          failed: { authored: true },
        },
      };
    }

    // Production guard check. No write without it: a guard that was never
    // injected refuses the run instead of waving it through.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      return {
        refusal: {
          code: PRODUCTION_GUARD_MISSING.code,
          message: PRODUCTION_GUARD_MISSING.message,
          failed: { authored: false },
        },
      };
    }
    const guardRequest = {
      orgId: payload.orgId,
      orgTier: guardTierOf(org),
      operation: 'insert' as const,
      objectName: 'SeedData',
      recordCount: plannedRecords,
      module: 'seed',
    };
    const { check, decision } = await consultProductionGuard(guard, guardRequest);
    if (decision === 'refused' || decision === 'declined') {
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'stopped',
        guard: decision,
      });
    }
    if (decision === 'refused') {
      throw guardBlockedError(check.blockedReason ?? check.impactSummary);
    }
    // Production Guard's question, which every write to a production org is
    // asked and no setting turns off: the user's explicit consent.
    if (decision === 'declined') {
      // The code is the one every write path declines with, so the page says
      // it in the interface language instead of showing this English prose.
      return {
        refusal: {
          code: GUARD_REFUSAL.declined,
          message: 'Operation cancelled by user (confirmation declined).',
          failed: { authored: false },
        },
      };
    }

    // Asked before the first write when the org would not say what storage
    // it has left, or the seed would leave it short of today's API
    // requests: said only in the log, nobody saw either. With nobody to ask,
    // the page's seed goes on, said in the log as before; a pipeline's is
    // refused, nobody having approved it.
    if (storage.check.verdict === 'unread' || storage.api.verdict === 'near') {
      const answer = await questions.ask(guard, {
        stage: 'write',
        module: 'seed',
        org: orgName,
        orgTier: guardTierOf(org),
        objects: kinds.template.objects
          .map((o) => ({ objectApiName: o.objectApiName, rows: o.recordCount }))
          .sort((a, b) => b.rows - a.rows),
        total: plannedRecords,
        storage: confirmationStorageOf(storage.check),
        counted: true,
        ...confirmationApiOf(storage.api),
      });
      if (answer === 'declined') {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: payload.orgId,
          outcome: 'stopped',
          guard: decision,
          code: SEED_WRITE_DECLINED,
        });
        return {
          refusal: {
            code: SEED_WRITE_DECLINED,
            message: 'The seed was cancelled before it wrote anything. Nothing was written.',
            failed: { authored: true },
          },
        };
      }
      if (answer === 'unavailable' && questions.unanswered === 'refuse') {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: payload.orgId,
          outcome: 'stopped',
          guard: decision,
          code: PIPELINE_SEED_REFUSAL.unanswered,
        });
        return {
          refusal: {
            code: PIPELINE_SEED_REFUSAL.unanswered,
            message:
              `The seed needed an answer before it wrote — ${unansweredWhy(storage, orgName)} — ` +
              'and no Approval step before it approved the run: put one before it. Nothing was ' +
              'written.',
            failed: { authored: true },
          },
        };
      }
      if (answer === 'unavailable') {
        this.deps.log(
          `[WARN] seed:execute ${operationId}: nobody could be asked about the storage or the ` +
            'API requests the org has left; the seed goes on',
        );
      }
    }
    return {
      conn,
      run: payload,
      plannedRecords,
      guardDecision: decision,
      automation,
      orgName,
      warnings,
    };
  }

  /**
   * Start a seed held to its gates: tracked, announced on `operation:started`,
   * listed in Live Operations, and run in the background.
   *
   * @param description - What Live Operations and the activity feed list it as.
   * @param pipeline - The pipeline step it runs for, when one does.
   * @returns The controller that cancels it, and its run.
   */
  private beginSeed(
    msg: InboundRequest,
    cleared: SeedCleared,
    operationId: string,
    failure: OperationFailureContext,
    description: string,
    pipeline?: SeedPipelineRun,
    scenario?: ScenarioSeedRun,
  ): { abortController: AbortController; execution: Promise<{ status: 'failure' } | void> } {
    // Start performance tracking
    this.deps.infraServices?.performanceTracker?.start(operationId, 'seed');

    sendOperationStarted(this.deps, operationId, 'seed', description);
    // Feed the Monitor "live operations" panel with the same planned total.
    this.liveTracker?.register(operationId, 'seed', description, cleared.plannedRecords);

    // Create AbortController for this operation
    const abortController = new AbortController();

    // Build the execution promise (runs detached in the background)
    const execution = this.executeSeed(
      msg,
      cleared.conn,
      cleared.run,
      operationId,
      abortController,
      failure,
      cleared.guardDecision,
      pipeline,
      scenario,
    );
    return { abortController, execution };
  }

  /**
   * Seed an org for a pipeline's Seed step as a seed of the Seed page runs,
   * with nobody to watch it: held to the same gates (`clearSeed`), kept in the
   * same run file — which names the pipeline — and so listed in Seed's Recent
   * runs and taken back from there, registered in Live Operations, recorded
   * in the audit trail. It resolves once the run has ended.
   *
   * Before anything is read of the org, it is refused: in an org SandForge
   * does not know; in a production org, whatever the answer; in a sandbox
   * marked Staging with no approval; for a template no longer saved, one that
   * no longer reads, or one with an AI rule. Then every question is answered
   * by the request's answer (`withGivenAnswer`): Production Guard's, and the
   * one the page puts when the storage could not be read or the requests
   * would run short — refused without an approval, where the page's seed goes
   * on when nobody can be asked.
   *
   * @param request - The org, the template, the pipeline and the Approval's answer.
   * @param signal - The step's: aborted, the run is cancelled as Cancel in
   *   Live Operations cancels it, and ends with what it wrote before the stop.
   * @returns How the run ended: its result, whole, a cancelled one included.
   * @throws With a code (`PIPELINE_SEED_REFUSAL`, or the page's) when the seed
   *   is refused before it writes; a {@link StepCancelledError} when the step
   *   is cancelled before the run starts; the run's error when it fails.
   */
  async seedForPipeline(
    request: PipelineSeedRequest,
    signal?: AbortSignal,
  ): Promise<PipelineSeedOutcome> {
    const org = this.deps.orgManager.getOrg(request.orgId);
    if (!org) {
      throw pipelineSeedRefusal(
        PIPELINE_SEED_REFUSAL.orgUnknown,
        `The org the seed writes to is not connected to SandForge (${request.orgId}): connect ` +
          'it, or choose another. Nothing was written.',
      );
    }
    const tierRefusal = pipelineSeedTierRefusal(
      guardTierOf(org),
      request.answer,
      org.alias || org.username || request.orgId,
    );
    if (tierRefusal) throw tierRefusal;
    const chosen = pipelineSeedAsked(request.orgId, request.templateId, (id) =>
      this.seedTemplateStore.load(id),
    );
    if ('refusal' in chosen) throw chosen.refusal;

    // No page waits on a pipeline's run: its origin is a listed synthetic
    // request, whose id doubles as the operation id, as a pipeline's Sync.
    const msg = syntheticRequest('seed:pipeline', crypto.randomUUID(), 'seed:execute');
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'seed', operation: msg.type };
    const questions: SeedQuestions = {
      ask: () => Promise.resolve(request.answer.approved ? 'confirmed' : 'unavailable'),
      unanswered: 'refuse',
    };
    return withGivenAnswer(request.answer, async () => {
      const cleared = await this.clearSeed(chosen.asked, operationId, failure, questions);
      if ('refusal' in cleared) {
        throw pipelineSeedRefusal(cleared.refusal.code, cleared.refusal.message);
      }
      // Cancelled while the org was read or the guard consulted: nothing is written.
      if (signal?.aborted) {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: request.orgId,
          outcome: 'stopped',
          guard: cleared.guardDecision,
          code: ABORTED_BEFORE_START,
        });
        throw new StepCancelledError(
          'The seed was cancelled before it wrote anything. Nothing was written.',
        );
      }
      // What the page's confirmation shows before Start, said before the first write.
      const automation = seedAutomationLines(cleared.automation, cleared.orgName);
      for (const line of automation) this.deps.log(`[INFO] seed:execute ${operationId}: ${line}`);

      let ended: SeedRunEnd | undefined;
      const description = `Pipeline seed of ${chosen.asked.template.name}`;
      const { abortController, execution } = this.beginSeed(
        msg,
        cleared,
        operationId,
        failure,
        description,
        {
          pipeline: request.pipeline,
          ended: (end) => {
            ended = end;
          },
        },
      );
      // Registered as the page's run is: Live Operations lists it, and its
      // Cancel and the step's both reach the run through the registry.
      this.registry?.register(operationId, 'seed', description, execution, abortController);
      const onAbort = (): void => {
        if (this.registry) this.registry.abort(operationId);
        else abortController.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await execution;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      const end = ended as SeedRunEnd | undefined;
      if (end === undefined) throw new Error('The seed ended without a result.');
      if ('error' in end) {
        throw end.error instanceof Error ? end.error : new Error(extractErrorMessage(end.error));
      }
      return {
        operationId,
        runId: end.result.operationId,
        result: end.result,
        automation,
        warnings: cleared.warnings,
      };
    });
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
   *
   * A run the registry's abort stopped ends as cancelled, with the objects it
   * reached answered to the page and recorded. An error thrown while a cancel
   * is pending is still a failure: only the orchestrator, stopping at the
   * cancel, says a run was cancelled.
   *
   * A pipeline's run (`pipeline`) names its pipeline in the run's file, and
   * is told how the run ended, its result whole, once the page has been.
   */
  private async executeSeed(
    msg: InboundRequest,
    conn: Awaited<ReturnType<typeof getJsforceConnection>>,
    payload: SeedRunPayload,
    operationId: string,
    abortController: AbortController,
    failure: OperationFailureContext,
    guardDecision?: GuardDecision,
    pipeline?: SeedPipelineRun,
    scenario?: ScenarioSeedRun,
  ): Promise<{ status: 'failure' } | void> {
    const robustnessConfig = robustnessConfigOf(this.deps);
    const startedAt = new Date().toISOString();
    /** The id each case of a scenario was given, by its row key: what its tests are about. */
    const caseIds: Record<string, string> = {};
    const templateName = (payload.template as { name?: unknown }).name;
    /** Where the records came from: the template the generator filled in. */
    const source = {
      origin: 'generator' as const,
      ...(typeof templateName === 'string' ? { label: templateName } : {}),
    };

    try {
      // Build robustness-aware insert function
      const bulkManager = bulkManagerOf(this.deps);
      const retryOp = new RetryableOperation({
        retryConfig: robustnessConfig.retry,
        // A batch the org failed on is not sent again once the seed is
        // cancelled, and its backoff is not waited out, as in the writer Sync
        // writes through.
        signal: abortController.signal,
        onRetry: (attempt, classified, delay) => {
          this.deps.log(
            `[RETRY] seed insert attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`,
          );
        },
      });
      const handlerDeps = this.deps;
      // What the run creates, written down as each insert returns: a window
      // closed under the run, or a host that stopped, left what it had
      // inserted with nothing to take it back from, the run being kept once
      // it ended. The orchestrator runs under this id, which its result and
      // the page's removal name.
      const runId = crypto.randomUUID();
      const kept = this.runCreations?.recorder({
        runId,
        targetOrgId: payload.orgId,
        startedAt,
        ...(pipeline ? { pipeline: pipeline.pipeline } : {}),
      });
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

      // The write path the command line takes too: see `seedInsert`.
      const insertRecords = seedInsert({
        conn: conn as unknown as SeedInsertConnection,
        bulkThreshold: robustnessConfig.bulk.threshold,
        bulkManager,
        retry: retryOp,
        signal: abortController.signal,
        label: `seed:execute ${operationId}`,
        log: (line) => this.deps.log(line),
        onProgress: reportInsertProgress,
        // Kept call by call, before each goes — a job with its id once the
        // org opened it — and as each answers: the insert notes them all
        // again once it returns, which the recorder keeps once.
        ...(kept
          ? {
              calls: {
                sending: (objectApiName, rows, call) => kept.sending(objectApiName, rows, call),
                answered: (objectApiName, ids) => kept.answered(objectApiName, ids),
              },
            }
          : {}),
      });
      const insertFn = async (
        orgId: string,
        objectApiName: string,
        records: Record<string, unknown>[],
        batchSize: number,
      ): Promise<InsertResult> => {
        const answer = await insertRecords(orgId, objectApiName, records, batchSize);
        kept?.note(objectApiName, answer.successIds);
        return answer;
      };
      /** Say a run's creations could not all be kept, and let the run end as it did. */
      const keptFailed = (err: unknown): void =>
        this.deps.log(
          `[WARN] seed:execute ${operationId}: what the run created could not all be kept, ` +
            `so removing it may leave some of it in the org: ${extractErrorMessage(err)}`,
        );

      // Lazy-import seed dependencies
      const { SeedValidator } = await import('../../modules/seed/SeedValidator.js');
      const { DataPlanBuilder } = await import('../../modules/seed/DataPlanBuilder.js');
      const { FieldMapper } = await import('../../modules/seed/FieldMapper.js');
      const { ReferenceLinker } = await import('../../modules/seed/ReferenceLinker.js');
      const { AIDataGenerator } = await import('../../modules/seed/AIDataGenerator.js');
      const { FakerFallback } = await import('../../modules/seed/FakerFallback.js');
      const { readExistingParentIds, readPresentParentIds } =
        await import('../../modules/seed/existingParents.js');
      const { seedObjectAccess } = await import('../../modules/seed/seedObjectAccess.js');
      const { describedFieldsOf } = await import('../../modules/seed/describedFields.js');
      const seedKnowledge = scenario
        ? (await import('../../modules/seed/seedKnowledge.js')).seedKnowledge
        : undefined;

      const aiGenerator = new AIDataGenerator(this.buildSeedCallAI());
      const fakerFallback = new FakerFallback(payload.locale);
      const fieldMapper = new FieldMapper({ aiGenerator, fakerFallback });
      const referenceLinker = new ReferenceLinker();
      const validator = new SeedValidator();
      const planBuilder = new DataPlanBuilder();

      const { SeedGrappeAdapter } = await import('../../modules/seed/SeedGrappeAdapter.js');

      const grappeConfig = readGrappeConfig(this.deps.services);

      // One describe of the org per object, kept for the run. A template names
      // fields an org may not have: without this, one missing field refuses
      // every record of the object. See `describeCreateableFields`. The same
      // describe gives the values of its picklists, which a template's random
      // picks are kept to (`describePicklistValues`).
      const describedFields = describedFieldsOf((objectApiName) => conn.describe(objectApiName));

      const seedDeps = {
        validator,
        describeCreateableFields: describedFields.createable,
        describeVisibleFields: describedFields.visible,
        describePicklistValues: describedFields.picklistValues,
        describeFieldLengths: describedFields.lengths,
        // What the org requires and the template names no rule for, less what
        // the kind of account written does not take.
        describeRequiredFields: async (objectApiName: string) =>
          (await describedFields.required(objectApiName)).filter(
            (field) =>
              !leftOutForAccountKind(
                objectApiName,
                field.fieldApiName,
                payload.personObjects.includes(objectApiName) ? 'person' : 'business',
              ),
          ),
        // An object the org has not, or the user may not create, is skipped
        // with the reason, before its records are generated.
        objectAccess: seedObjectAccess(conn),
        // A relation may draw its parents from records already in this org.
        readExistingParentIds: (objectApiName: string, where: string | undefined, limit: number) =>
          readExistingParentIds(conn, objectApiName, where, limit),
        // And from records it names by id, checked before the first write.
        readPresentParentIds: (objectApiName: string, ids: readonly string[]) =>
          readPresentParentIds(conn, objectApiName, ids),
        describeKeyPrefix: describedFields.keyPrefix,
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
        // The controller the registry aborts: the Seed page's Cancel and Live
        // Operations' both reach the run through it.
        signal: abortController.signal,
        // A scenario's tests know its cases by key: the id each became is
        // kept beside the run for its test file. Once every object is
        // written, its articles are published and each closed case linked to
        // the article of its topic: an agent's data library indexes
        // published articles alone, and reads a customer's history through
        // the links. Each of those calls is kept with the run, so that its
        // removal reads what they dated as the run's own. An org without
        // Knowledge has no article written, and the step says so without a
        // call.
        ...(scenario && seedKnowledge
          ? {
              onRowIds: (objectApiName: string, ids: Readonly<Record<string, string>>) => {
                if (objectApiName === 'Case') Object.assign(caseIds, ids);
              },
              knowledge: seedKnowledge({
                org: conn as unknown as KnowledgeOrg,
                plan: { publish: true, links: scenario.compiled.closedCaseArticles },
                ...(kept ? { journal: kept } : {}),
                signal: abortController.signal,
              }),
            }
          : {}),
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
      let result: Awaited<ReturnType<typeof orchestrator.execute>>;
      // Running until its end is kept: a removal of it is refused until then.
      this.runningRuns.add(runId);
      try {
        result = await orchestrator.execute(template, payload.orgId, runId);
      } catch (err: unknown) {
        // What it inserted before it threw stays removable, the run ended failed.
        await kept
          ?.end({ status: 'failure', finishedAt: new Date().toISOString(), objectResults: [] })
          .catch(keptFailed);
        this.runningRuns.delete(runId);
        throw err;
      }
      // Kept whole before the lists are cut for the page, a stopped run's too:
      // what it wrote before the cancel can be taken back from its results,
      // or after a reload from the list of earlier seeds. A store that cannot
      // keep it is said, and the run ends as it did.
      await kept
        ?.end({
          finishedAt: new Date().toISOString(),
          status: result.status,
          ...(result.cancelled ? { cancelled: true } : {}),
          objectResults: result.objectResults,
        })
        .catch(keptFailed);
      // A scenario's companion file, beside the run's, once the run's is kept:
      // the open cases' ids, by key, which its test file is written from.
      if (scenario) {
        result = { ...result, scenario: await this.keepScenario(result, scenario, caseIds) };
      }
      this.runningRuns.delete(runId);
      if (!result.cancelled) {
        sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Seed complete');
      }
      // What the orchestrator reports it wrote. A cast to an `insertedIds`
      // array no result ever carried reported every finished run as 0 records.
      const totalRecords = result.totalRecordsCreated;
      this.deps.infraServices?.performanceTracker?.update(operationId, totalRecords, 1);
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      if (result.cancelled) {
        // Ended the way a cancelled backup ends: aborted in the registry —
        // already, when the cancel came through it; this lists a run stopped
        // any other way as aborted too — and posted as a completion that
        // says so. A stopped seed was posted with the status its objects came
        // to, so the recent operations and Home listed a run the user had
        // stopped as failed or succeeded, and Live Operations kept it running.
        this.registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true, totalRecords });
        this.liveTracker?.cancel(operationId);
      } else {
        // The run's own status, the way the other write paths report theirs.
        // A template the validator refused, or one whose every record the org
        // turned down, ends here with a failure status, and was announced as
        // completed: Live Operations listed it done, "seed completed" popped
        // up and Home showed a success.
        sendOperationCompleted(this.deps, operationId, { status: result.status, totalRecords });
        if (result.status === 'failure') {
          this.liveTracker?.fail(operationId, seedFailureReason(result));
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
      // Stopped by the user: cancelled once it wrote a record or had one
      // refused, stopped under the code of a run cancelled before it wrote
      // otherwise, as a Sync run is recorded. A stopped seed's status is
      // partial whether or not it wrote, and the trail read it as a seed the
      // org had refused records of.
      const touched = result.objectResults.some(
        (object) => object.recordsCreated + object.recordsFailed > 0,
      );
      const outcome: AuditOutcome =
        result.cancelled === true ? (touched ? 'cancelled' : 'stopped') : result.status;
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome,
        ...(outcome === 'stopped' ? { code: RUN_CANCELLED } : {}),
        guard: guardDecision,
        objects: result.objectResults.map((object) => ({
          ...emptyCounts(object.objectApiName),
          created: object.recordsCreated,
          failed: object.recordsFailed,
        })),
        source,
      });

      const response = buildResponse(
        this.deps,
        msg,
        'seed:execute:response',
        capResultForBridge(result) as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      pipeline?.ended({ result });
      // A failure status, not a bare resolve, so the registry marks the run
      // failed — see the method docstring for the contract. A cancelled run
      // is aborted there already.
      if (result.status === 'failure' && !result.cancelled) return { status: 'failure' };
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // What the run inserted before it threw is not counted here: it is
      // kept, for its removal, with the run's creations.
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'failure',
        guard: guardDecision,
        source,
      });
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
      pipeline?.ended({ error: err });
      // Failure-status result (not a rejection, not a bare resolve) so the
      // BackgroundOperationRegistry marks the operation 'failed' — see the
      // method docstring for the contract.
      return { status: 'failure' };
    }
  }
}
