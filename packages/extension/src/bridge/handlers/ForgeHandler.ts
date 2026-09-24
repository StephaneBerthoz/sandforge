import type {
  AuditObjectCounts,
  AuditOutcome,
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeTemplate,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoResult,
  ForgeUndoStatus,
  ForgeRunObjectRecords,
  ComplianceFrameworkType,
} from '@sandforge/shared';
import {
  fileCopyRefusal,
  forgeAnonymizationRulesSchema,
  forgeConfigSchema,
  forgeFileCopyOptionSchema,
  forgeGraphSchema,
  forgeRunCreatedRecords,
  forgeTemplateSchema,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  PRODUCTION_GUARD_MISSING,
} from './HandlerTypes.js';
import { validatePayload } from '../validatePayload.js';
import { logger } from '../../logger.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import {
  dropImportedTemplates,
  importedTemplatesFor,
  isTemplateEntry,
} from '../../core/config/importedForgeTemplates.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import type { ForgeHistoryStore } from '../../modules/forge/ForgeHistoryStore.js';
import { queryAllPages } from '../../modules/forge/queryAllPages.js';
import { partialSummaryOf } from '../../modules/forge/interruptedRun.js';
import {
  RECORD_TYPES_SOQL,
  RecordTypeMapper,
  parseRecordTypeRows,
  type RecordTypeMapping,
} from '../../modules/sync/RecordTypeMapper.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { removalOrg, removeRunRecords } from '../../modules/forge/ForgeRunRemoval.js';
import { forgeRunResult } from '../../modules/forge/runResult.js';
import type { ExecutionSummary, ForgeProgressEvent } from '../../modules/forge/ForgeExecutor.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

/** Strict Salesforce record/org ID format. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
/** Permissive org-id schema (accepts UUIDs as well as 18-char SF IDs). */
const orgIdSchema = z.string().min(1).max(128);

/** Zod payload schemas for every webview→extension forge:* message. */
const previewPayloadSchema = z.object({
  recordId: z.string().regex(SF_ID_RE, 'Invalid Salesforce record ID'),
  orgId: orgIdSchema,
});
const discoverPayloadSchema = z.object({ config: forgeConfigSchema });
const executePayloadSchema = z.object({
  graph: forgeGraphSchema,
  config: forgeConfigSchema,
  // The method Review holds per PII category. The fields travel on the
  // graph's nodes; a category left out takes its default method.
  anonymizationRules: forgeAnonymizationRulesSchema.optional(),
  // Copy the files of the records the run clones, as Review set it; absent,
  // no file is read. Never part of the config: a template or a past run does
  // not bring back the acceptance a run that anonymizes needs.
  files: forgeFileCopyOptionSchema.optional(),
});

/** Why a run that copies files was stopped before it started, as the audit trail records it. */
const FILES_NOT_ACCEPTED = 'FILES_NOT_ACCEPTED';

const saveTemplatePayloadSchema = z.object({ template: forgeTemplateSchema });
// The entry is named, never its records: what is removed is what this
// extension's own history says the run created.
const undoPayloadSchema = z.object({
  forgeId: z.string().min(1).max(200),
  includeChanged: z.boolean().optional(),
});
const deleteTemplatePayloadSchema = z.object({ templateId: z.string().min(1).max(200) });
const planRequestPayloadSchema = z.object({ graph: forgeGraphSchema, config: forgeConfigSchema });
const complianceRequestPayloadSchema = z.object({
  framework: z.string().min(1).max(50),
  graph: forgeGraphSchema,
  config: forgeConfigSchema,
});
const metadataDiffRequestPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  // Tightened from .max(500) to .max(100). 100 SObjects per diff
  // is already past any realistic UI use case; 500 enabled API-limit DoS
  // (500 source describes + 500 target describes = 1000 calls per request).
  objectApiNames: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
        .max(80),
    )
    .max(100),
});

/**
 * Throttle a function to at most one call per `delayMs`. Subsequent calls
 * coalesce — only the *latest* arguments are forwarded on the next tick.
 * Returned function exposes `.flush()` to emit the pending event immediately
 * (for terminal events that must not be dropped).
 */
function throttle<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): T & { flush: () => void } {
  let lastEmit = 0;
  let pending: Parameters<T> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const emit = (args: Parameters<T>): void => {
    fn(...args);
    lastEmit = Date.now();
    pending = null;
  };
  const wrapped = ((...args: Parameters<T>): void => {
    pending = args;
    const wait = delayMs - (Date.now() - lastEmit);
    if (wait <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emit(args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) emit(pending);
      }, wait);
    }
  }) as T & { flush: () => void };
  wrapped.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) emit(pending);
  };
  return wrapped;
}

/**
 * Local alias for the shared payload validator (bridge/validatePayload.ts).
 * Kept as a one-line wrapper so the call sites below stay readable.
 */
function parsePayload<T>(
  schema: z.ZodSchema<T>,
  msg: InboundRequest,
  responseType: string,
  deps: HandlerDeps,
): T | null {
  return validatePayload(schema, msg, responseType, deps);
}

/** Optional v2 services injected alongside the ForgeOrchestrator. */
export interface ForgeServices {
  /** Optional plan generator for wave-based planning. */
  planGenerator?: ForgePlanGenerator;
  /** Optional compliance service for PII reports. */
  complianceService?: ForgeComplianceService;
  /** Optional metadata diff service for schema comparison. */
  metadataDiff?: ForgeMetadataDiff;
  /**
   * Workspace-file template store. Present only when a folder is open — a
   * folderless window has no `.sandforge/` to write into and falls back to
   * ConfigStore.
   */
  templateStore?: ForgeTemplateStore;
  /** @deprecated History is now persisted via ConfigStore. Accepted for backward compatibility. */
  historyStore?: ForgeHistoryStore;
}

/** Message types handled by ForgeHandler. */
const FORGE_TYPES = new Set([
  'forge:preview',
  'forge:discover',
  'forge:execute',
  'forge:pause',
  'forge:resume',
  'forge:abort',
  'forge:templates:list',
  'forge:templates:save',
  'forge:templates:delete',
  'forge:history:list',
  'forge:undo',
  'forge:plan:request',
  'forge:compliance:request',
  'forge:metadata-diff:request',
]);

/** Timeout for plan generation in milliseconds. */
const PLAN_TIMEOUT_MS = 30_000;

/** Timeout for compliance report generation in milliseconds. */
const COMPLIANCE_TIMEOUT_MS = 30_000;

/** Timeout for metadata diff comparison in milliseconds. */
const METADATA_DIFF_TIMEOUT_MS = 60_000;

/** Timeout for reading both orgs' record types before a run, in milliseconds. */
const RECORD_TYPES_TIMEOUT_MS = 30_000;

/** ConfigStore key of the templates of the windows with no folder open. */
const TEMPLATES_KEY = 'forge:templates';

/** The templates a window holds, as it lists them. */
interface HeldTemplates {
  templates: ForgeTemplate[];
  /** Why the templates an import left for the workspace are not among them: the file refused them. */
  importNotMerged?: string;
}

/** ConfigStore key for persisted forge execution history. */
const HISTORY_KEY = 'forge:history';

/** ConfigStore category for all forge data. */
const FORGE_CATEGORY = 'forge';

/**
 * Drop the org pair from a config so it can be stored as a replay recipe.
 *
 * Copy-then-delete rather than rest destructuring: the repo's
 * `no-unused-vars` rule flags the two discarded bindings. Spreading keeps
 * every other field, including ones added to ForgeConfig later — an explicit
 * field list would silently stop persisting them.
 */
function stripOrgIds(config: ForgeConfig): Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'> {
  const copy: Partial<ForgeConfig> = { ...config };
  delete copy.sourceOrgId;
  delete copy.targetOrgId;
  return copy as Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;
}

/**
 * What a run did per object, for the audit trail: the rows it created,
 * counted from its remap table, and the rows the run lost at read or at write.
 *
 * A row linked to one the target already held was never written and is
 * neither. The `scope` reports are left out — reference data unmatched by
 * name was never going to be written — and so are the reports that name a
 * pass rather than an object (`__pass2__`, `__expandOrphanParents__`).
 */
function forgeAuditObjects(
  result: Pick<ForgeExecutionResult, 'idRemapByObject' | 'errors'>,
): AuditObjectCounts[] {
  const byObject = new Map<string, AuditObjectCounts>();
  const countsOf = (objectApiName: string): AuditObjectCounts => {
    const counts = byObject.get(objectApiName) ?? emptyCounts(objectApiName);
    byObject.set(objectApiName, counts);
    return counts;
  };
  for (const row of result.idRemapByObject ?? []) {
    const counts = countsOf(row.objectApiName);
    counts.created += row.created;
    // Written over by an upsert that matched them: updated, never created.
    counts.updated += row.updated ?? 0;
  }
  for (const error of result.errors ?? []) {
    if (error.stage === 'scope' || error.objectApiName.startsWith('__')) continue;
    countsOf(error.objectApiName).failed += error.failedCount;
  }
  return [...byObject.values()];
}

/**
 * Per object, the source rows the run gave a counterpart in the target —
 * created, or linked to the record the target already held — as its remap
 * table counts them.
 */
function forgeCarried(
  result: Pick<ForgeExecutionResult, 'idRemapByObject'>,
): Record<string, number> {
  return Object.fromEntries(
    (result.idRemapByObject ?? []).map((row) => [
      row.objectApiName,
      row.created + row.linked + (row.updated ?? 0),
    ]),
  );
}

/** Records of a removal's objects left in the org: kept, or refused. */
function leftInOrg(object: ForgeUndoObjectResult): number {
  return object.keptChanged + object.keptDependents + object.refused;
}

/**
 * How a removal of a run's records ended. Nothing left in the org is a
 * success, whether the removal deleted the records or found them gone.
 */
function undoStatus(
  objects: readonly ForgeUndoObjectResult[],
  cancelled: boolean,
): ForgeUndoStatus {
  if (cancelled) return 'cancelled';
  if (objects.every((o) => leftInOrg(o) === 0)) return 'success';
  return objects.some((o) => o.deleted > 0) ? 'partial' : 'failure';
}

/**
 * A removal in the audit trail's words. A removal stopped part way is partial
 * when it deleted something, and failed when it deleted nothing.
 */
function undoAuditOutcome(result: ForgeUndoResult): AuditOutcome {
  if (result.status !== 'cancelled') return result.status;
  return result.objects.some((o) => o.deleted > 0) ? 'partial' : 'failure';
}

/** What a removal deleted and what the org refused, per object, for the audit trail. */
function undoAuditObjects(objects: readonly ForgeUndoObjectResult[]): AuditObjectCounts[] {
  return objects
    .filter((o) => o.deleted + o.refused > 0)
    .map((o) => ({ ...emptyCounts(o.objectApiName), deleted: o.deleted, failed: o.refused }));
}

/** The removal as its history entry keeps it: when, and how many records went each way. */
function undoMark(result: ForgeUndoResult): ForgeUndoMark {
  const sum = (count: (o: ForgeUndoObjectResult) => number): number =>
    result.objects.reduce((total, o) => total + count(o), 0);
  return {
    removedAt: result.finishedAt,
    deleted: sum((o) => o.deleted),
    alreadyGone: sum((o) => o.alreadyGone),
    kept: sum((o) => o.keptChanged + o.keptDependents),
    refused: sum((o) => o.refused),
  };
}

/**
 * Whether a run ended on the executor's abort (`ForgeAbortedError`) rather
 * than on a failure. Read by its name: the executor's module is loaded with
 * the Forge services, after activation, and importing its class here would
 * bring it and what it loads into the activation bundle.
 */
function isForgeAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'ForgeAbortedError';
}

/**
 * Domain handler for forge-related webview-to-extension messages.
 *
 * Routes forge:* message types to the ForgeOrchestrator and manages
 * templates, execution history, and abort/pause/resume lifecycle.
 * Templates are kept in the workspace file, or in ConfigStore with no folder
 * open; history in ConfigStore. Both survive an extension reload.
 */
export class ForgeHandler implements DomainHandler {
  private discoverAbortController: AbortController | null = null;
  private abortController: AbortController | null = null;
  /* The operations the registry is tracking for this handler. Stop has to
     reach the registry, not just the controllers: a run whose promise simply
     settles is recorded as completed, so a clone the user stopped was listed
     as finished in Live Operations and announced as one. */
  private discoverOperationId: string | null = null;
  private executeOperationId: string | null = null;
  private orchestrator?: ForgeOrchestrator;
  private planGenerator?: ForgePlanGenerator;
  private complianceService?: ForgeComplianceService;
  private metadataDiff?: ForgeMetadataDiff;
  /**
   * Workspace-file template store, present only when a folder is open.
   *
   * Templates live in `.sandforge/forge-templates.json` so a recipe can be
   * committed and shared. ConfigStore (VSCode globalState) keeps the templates
   * of a window with no folder open.
   */
  private templateStore?: ForgeTemplateStore;

  /**
   * Per-org `describeGlobal` result, keyed by org id.
   *
   * The preview path only needs the key-prefix -> {name,label} table, but
   * `conn.describeGlobal()` re-downloads 1-2 MB of JSON on every call. The
   * webview fires a preview on each corrected record id the user pastes, so
   * a handful of typos used to cost as many full downloads.
   *
   * Same mechanism, keys and TTL as the caches in
   * `composition/forgeComposition.ts` and `FrozenDatasetHandler` — org id as
   * the key means switching org can never read another org's schema, and the
   * 5-minute TTL bounds how stale a freshly deployed SObject can be.
   */
  private readonly describeGlobalCache = new SchemaCache<
    Array<{ name: string; label: string; keyPrefix: string | null }>
  >({
    defaultTtl: 5 * 60_000,
    maxSize: 16,
    maxSizeBytes: 50 * 1024 * 1024,
  });

  /** Tracks DML operations to prevent duplicate forge executions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** The runs whose records are being removed, by `forgeId`: one removal at a time each. */
  private readonly removing = new Set<string>();

  /**
   * The tracker the Monitor's Live Operations panel lists, where a removal
   * shows with a Cancel that reaches it through the background registry.
   */
  private liveTracker?: LiveOperationTracker;

  /**
   * Cooldown after a run that actually wrote records, keyed by the
   * content-derived operation id -> epoch ms of that run's completion.
   *
   * Only a run that created something arms it: a failed clone, or one that
   * wrote nothing, must be retryable immediately.
   */
  private readonly lastWriteAt = new Map<string, number>();

  /**
   * How long an identical, already-executed forge run is refused.
   *
   * The guard exists to swallow an accidental double submit, not to lock a
   * recipe out: the tracker's 1h TTL used to do exactly that, and it applied
   * to failed runs too — a clone that died on the first object could not be
   * retried for a full hour.
   */
  private static readonly DUPLICATE_COOLDOWN_MS = 60_000;

  /** Maximum number of history entries to retain. */
  private static readonly MAX_HISTORY = 20;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Drop what Forge holds about an org that is no longer the org it was.
   *
   * A refreshed sandbox is a new copy of production behind the same id: its
   * prefix table, its describes and every dependency graph discovered on it
   * describe the org the refresh replaced — root records that are gone,
   * counts from before, fields production may not have.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    this.describeGlobalCache.invalidate(orgId);
    this.orchestrator?.clearDiscoveryCache([orgId]);
  }

  /**
   * Inject forge orchestrator and optional v2 services.
   *
   * @param orchestrator - The ForgeOrchestrator instance.
   * @param services - Optional additional Forge v2 services.
   */
  setForgeOrchestrator(orchestrator: ForgeOrchestrator, services?: ForgeServices): void {
    this.orchestrator = orchestrator;
    if (services) {
      this.planGenerator = services.planGenerator;
      this.complianceService = services.complianceService;
      this.metadataDiff = services.metadataDiff;
      // Composition has always built and passed this store; the assignment was
      // simply missing, so every saved recipe went to globalState instead of
      // `.sandforge/forge-templates.json` and could not be committed or shared.
      this.templateStore = services.templateStore;
    }
  }

  /** Inject the tracker the Monitor's Live Operations panel lists. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Put a run on the background registry for as long as it lasts.
   *
   * Forge was the one long module that registered nothing, so the registry's
   * dispose — the extension deactivating, the window closing — had no run to
   * abort: a clone in flight kept walking the source org and writing to the
   * target with nothing left to report what it did.
   *
   * The registry aborts a controller of its own, which the run then follows:
   * the walk through its own signal, and — for a write run only — the executor
   * by being told, because jsforce cannot cancel a request it has sent. Only
   * `handleAbort` stops everything at once; cancelling one run from Live
   * Operations must not take the other Forge run in flight with it, and the
   * orchestrator is shared by both.
   *
   * @param operationId - Id the run reports progress under.
   * @param description - What the Live Operations panel shows.
   * @param controller - The run's own abort controller.
   * @param stopsExecutor - Whether a cancel also tells the shared orchestrator
   *   to stop writing. True for an execute, false for a discover.
   * @returns Call once the run has settled: with the error it failed on, or
   *   with nothing when it succeeded. A failed run is listed as failed instead
   *   of being announced as completed.
   */
  private trackRun(
    operationId: string,
    description: string,
    controller: AbortController,
    stopsExecutor = false,
  ): (error?: unknown) => void {
    const registry = this.deps.infraServices?.backgroundRegistry;
    if (!registry) return () => {};
    let settle: (error?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (error) => {
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : new Error(String(error)));
      };
    });
    const stop = new AbortController();
    stop.signal.addEventListener(
      'abort',
      () => {
        controller.abort();
        if (stopsExecutor) this.orchestrator?.abort();
      },
      { once: true },
    );
    registry.register(operationId, 'forge', description, tracked, stop);
    return settle;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!FORGE_TYPES.has(msg.type)) return false;

    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    switch (msg.type) {
      case 'forge:preview':
        await this.handleForgePreview(msg);
        return true;
      case 'forge:discover':
        await this.handleDiscover(msg);
        return true;
      case 'forge:execute':
        await this.handleExecute(msg);
        return true;
      case 'forge:pause':
        this.handlePause(msg);
        return true;
      case 'forge:resume':
        this.handleResume(msg);
        return true;
      case 'forge:abort':
        this.handleAbort(msg);
        return true;
      case 'forge:templates:list':
        await this.handleTemplatesList(msg);
        return true;
      case 'forge:templates:save':
        await this.handleSaveTemplate(msg);
        return true;
      case 'forge:templates:delete':
        await this.handleDeleteTemplate(msg);
        return true;
      case 'forge:history:list':
        this.handleHistoryList(msg);
        return true;
      case 'forge:undo':
        await this.handleUndo(msg);
        return true;
      case 'forge:plan:request':
        await this.handlePlanRequest(msg);
        return true;
      case 'forge:compliance:request':
        await this.handleComplianceRequest(msg);
        return true;
      case 'forge:metadata-diff:request':
        await this.handleMetadataDiffRequest(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * The templates this window holds: its workspace file's, with the set a
   * profile import left for the workspace merged in; or, with no folder open,
   * the ConfigStore's.
   *
   * A workspace whose file was empty used to take the ConfigStore's list, as
   * the one-time move of the templates kept there before the file existed. No
   * release saved any there before the file existed: nothing sent a template
   * save before 1.35, and a window with a folder has written to its file since
   * 1.15. The move took what the ConfigStore held instead: the templates of a
   * window with no folder open, those a profile brought in, or another
   * project's, since every window wrote its list there. They landed in the
   * next project opened with an empty file, which they were never saved to.
   *
   * The ConfigStore's list is read as the workspace file is: a value that is
   * no list reads as no template, where it threw on the list the page asked
   * for, and the page got no answer.
   */
  private async loadTemplates(): Promise<HeldTemplates> {
    if (!this.templateStore) {
      const stored = this.deps.configStore.get<unknown>(TEMPLATES_KEY);
      return { templates: Array.isArray(stored) ? stored.filter(isTemplateEntry) : [] };
    }
    return this.withImportedTemplates(this.templateStore);
  }

  /**
   * The workspace file's templates, with the set a profile import left for
   * this workspace merged in: by id, the file's own entry winning, except on
   * the ids an import with "overwrite" brought.
   *
   * An imported set used to be read only in a workspace whose file was empty;
   * anywhere else the file's templates hid it. The set is merged once and then
   * dropped, so a template deleted afterwards does not come back. A set
   * imported in another workspace is left for that workspace's window: merged
   * here, it wrote one project's templates into another's file.
   *
   * A merge the file refuses — a read-only workspace, a full disk — threw past
   * the router, which answers nothing: the page waited out its timeout, on
   * every list, for as long as the set waited. The set now stays for the next
   * list to try again, and this one answers with what the file holds and why
   * the imported templates are not among them.
   *
   * @param store - This workspace's template file.
   */
  private async withImportedTemplates(store: ForgeTemplateStore): Promise<HeldTemplates> {
    const imported = importedTemplatesFor(this.deps.configStore, store.workspacePath);
    if (!imported) return { templates: await store.list() };
    let merged: ForgeTemplate[];
    try {
      merged = await store.merge(imported.templates, new Set(imported.replacing));
    } catch (err: unknown) {
      const reason = extractErrorMessage(err);
      logger.warn(`Imported forge templates not written into .sandforge/: ${reason}`);
      return { templates: await store.list(), importNotMerged: reason };
    }
    dropImportedTemplates(this.deps.configStore, store.workspacePath);
    logger.info('Merged an imported set of forge templates into .sandforge/');
    return { templates: merged };
  }

  /**
   * Persist templates: in the workspace file when a folder is open, so the
   * recipe can be committed and shared; in the ConfigStore when none is.
   *
   * A window with a folder open wrote its list to the ConfigStore as well,
   * over the list kept there: the templates a window with no folder open had
   * saved, or a profile had brought in, were gone at the next save in any
   * project. The ConfigStore now holds only the templates of the windows with
   * no folder open.
   */
  private async saveTemplates(templates: ForgeTemplate[]): Promise<void> {
    if (!this.templateStore) {
      this.deps.configStore.set(TEMPLATES_KEY, templates, FORGE_CATEGORY);
      return;
    }
    const existing = await this.templateStore.list();
    for (const stale of existing.filter((t) => !templates.some((n) => n.id === t.id))) {
      await this.templateStore.delete(stale.id);
    }
    for (const template of templates) {
      await this.templateStore.save(template);
    }
  }

  /** Load execution history from ConfigStore. */
  private loadHistory(): ForgeExecutionResult[] {
    return this.deps.configStore.get<ForgeExecutionResult[]>(HISTORY_KEY) ?? [];
  }

  /** Save execution history to ConfigStore. */
  private saveHistory(history: ForgeExecutionResult[]): void {
    this.deps.configStore.set(HISTORY_KEY, history, FORGE_CATEGORY);
  }

  /**
   * Start the duplicate cooldown for a run that wrote records, dropping the
   * stamps that already expired so the map stays bounded.
   */
  private noteForgeWrite(forgeOpId: string): void {
    const now = Date.now();
    for (const [id, at] of this.lastWriteAt) {
      if (now - at >= ForgeHandler.DUPLICATE_COOLDOWN_MS) {
        this.lastWriteAt.delete(id);
      }
    }
    this.lastWriteAt.set(forgeOpId, now);
  }

  /** Preview a single record by ID (resolve object type, fetch standard fields). */
  private async handleForgePreview(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(previewPayloadSchema, msg, 'forge:preview:error', this.deps);
    if (!parsed) return;
    const { recordId, orgId } = parsed;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve object type from record ID key prefix. The prefix table is
      // org-wide and identical for every preview, so it is cached per org
      // — without the cache each pasted record id re-downloaded the whole
      // describeGlobal payload.
      const keyPrefix = recordId.substring(0, 3);
      let sobjects = this.describeGlobalCache.get(orgId);
      if (!sobjects) {
        const globalDesc = await conn.describeGlobal();
        checkApiLimits(conn.limitInfo, 'forge:preview describeGlobal');
        sobjects = globalDesc.sobjects.map((s) => ({
          name: s.name,
          label: s.label,
          keyPrefix: s.keyPrefix ?? null,
        }));
        this.describeGlobalCache.set(orgId, sobjects);
      }
      const sobjectInfo = sobjects.find((s) => s.keyPrefix === keyPrefix);

      if (!sobjectInfo) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Unknown object for key prefix "${keyPrefix}"`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      // Query the record with standard fields (with fallback for orgs not supporting FIELDS() syntax)
      const records = await queryWithFieldsFallback<Record<string, unknown>>(
        conn,
        sobjectInfo.name,
        `SELECT FIELDS(STANDARD) FROM ${sobjectInfo.name} WHERE Id = '${sanitizeSoqlValue(recordId)}' LIMIT 1`,
      );
      checkApiLimits(conn.limitInfo, `forge:preview query ${sobjectInfo.name}`);

      if (!records || records.length === 0) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Record not found: ${recordId}`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      const record = records[0];
      const skipKeys = new Set(['attributes', 'Id']);
      const fields = Object.entries(record)
        .filter(([key]) => !skipKeys.has(key))
        .filter(([, value]) => value != null && String(value) !== '')
        .slice(0, 8)
        .map(([key, value]) => ({ name: key, value: String(value) }));

      // Describe the object for total field count
      const objectDesc = await conn.describe(sobjectInfo.name);
      checkApiLimits(conn.limitInfo, `forge:preview describe ${sobjectInfo.name}`);
      const totalFieldCount = objectDesc.fields.length;

      // Count records in the object
      let estimatedRecordCount = 0;
      try {
        const countResult = await conn.query(`SELECT COUNT() FROM ${sobjectInfo.name}`);
        estimatedRecordCount = countResult.totalSize;
      } catch {
        // Some objects may not support COUNT() -- fall back to 0
      }

      // Compute estimated size using the same heuristic as GraphDiscoveryService
      const estimatedSize = estimatedRecordCount * 0.001; // MB_PER_RECORD

      const response = buildResponse(this.deps, msg, 'forge:preview:response', {
        objectApiName: sobjectInfo.name,
        objectLabel: sobjectInfo.label,
        recordId,
        fields,
        estimatedRecordCount,
        totalFieldCount,
        estimatedSize,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'forge:preview', 'forge:preview:error', msg, err, {
        code: 'PREVIEW_ERROR',
      });
    }
  }

  private async handleDiscover(msg: InboundRequest): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(
        this.deps,
        'forge:discover',
        'forge:discover:error',
        msg,
        new Error('Forge module is not initialized'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }

    const parsed = parsePayload(discoverPayloadSchema, msg, 'forge:discover:error', this.deps);
    if (!parsed) return;
    const { config } = parsed;
    // A discovery still running belongs to a screen the user has left (Back,
    // then Discover again). Overwriting its controller without aborting it
    // left that BFS running beside the new one with nothing able to stop it.
    // Stopped through the registry first, as forge:abort stops one: stopped
    // by its controller alone, it settled with no error and the registry
    // recorded the replaced walk as completed.
    if (this.discoverOperationId) {
      this.deps.infraServices?.backgroundRegistry?.abort(this.discoverOperationId);
    }
    this.discoverAbortController?.abort();
    const controller = new AbortController();
    this.discoverAbortController = controller;
    const operationId = `forge-discover-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Discovering object graph');
    const releaseRun = this.trackRun(operationId, 'Discovering object graph', controller);
    this.discoverOperationId = operationId;
    /** What the walk failed on, so the registry lists the run as failed. */
    let runError: unknown;

    // Throttle progress events to ~10/s. Without this, big graphs flood
    // the webview with hundreds of postMessages, each carrying a JSON
    // payload that vscode has to serialize. Terminal events are emitted
    // immediately; mid-stream events are coalesced. Hoisted out of try
    // so the catch path can flush pending events too.
    const throttledProgress = throttle((event: Record<string, unknown>) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:discover:progress', event);
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      logger.info('Forge discover started');
      const graph = await this.orchestrator.discover(config, {
        // Absent, the discovery service keeps its own default.
        maxNodes: config.maxNodes,
        signal: controller.signal,
        onProgress: (event) => {
          throttledProgress(event as unknown as Record<string, unknown>);
        },
      });
      throttledProgress.flush();
      if (controller.signal.aborted) {
        // Cancelled from the wizard or replaced by a newer discovery. The BFS
        // hands back the partial graph it had reached; answering with it would
        // land that truncated graph in whichever discovery screen is open now.
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        return;
      }
      const response = buildResponse(this.deps, msg, 'forge:discover:response', { graph });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { nodeCount: graph.nodes?.length ?? 0 });
    } catch (error: unknown) {
      // Flush any pending throttled progress event so the UI gets
      // the latest queue state before the error response arrives. Without
      // this, an abort mid-BFS leaves the wizard frozen on stale counts.
      throttledProgress.flush();
      // A cancelled or replaced walk can still throw on its way out. Its error
      // would stop the spinner of the discovery screen open now, whose own walk
      // is still running.
      if (controller.signal.aborted) {
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        return;
      }
      // Dual channel, single display, as for every other module:
      // `forge:discover:error` is what the discovery screen shows, and
      // `operation:failed` ends the run where it is listed. Left out, the
      // recent operations and the side panel showed a failed discovery as
      // running for the rest of the session.
      runError = error;
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', msg, error, {
        code: 'DISCOVER_ERROR',
        retryable: true,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(error), true);
    } finally {
      releaseRun(runError);
      if (this.discoverOperationId === operationId) this.discoverOperationId = null;
      // Only release the controller this call owns: a superseded discovery
      // settles after its replacement started, and nulling the field then cut
      // the live one off from forge:abort.
      if (this.discoverAbortController === controller) {
        this.discoverAbortController = null;
      }
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error('Forge module is not initialized'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }

    const parsed = parsePayload(executePayloadSchema, msg, 'forge:execute:error', this.deps);
    if (!parsed) return;
    const { graph, config, anonymizationRules, files } = parsed;

    // A run that anonymizes its records copies no file the user has not
    // accepted as it is: a file's content cannot be anonymized. Refused before
    // the guard is asked, and recorded as the path's own stop.
    const filesRefused = files ? fileCopyRefusal(config.anonymizePII, files.acceptedAsIs) : null;
    if (filesRefused) {
      recordWriteRun(this.deps, {
        action: 'forge_execute',
        module: 'forge',
        operationId: msg.id,
        orgId: config.targetOrgId,
        outcome: 'stopped',
        code: FILES_NOT_ACCEPTED,
      });
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error(filesRefused),
        { code: FILES_NOT_ACCEPTED },
      );
      return;
    }

    // Production guard check on the target org — same policy as sync/seed
    // runs (guard instance from backgroundComposition via infraServices).
    // Covers every write path below: BatchWriter insert/upsert, orphan-parent
    // expansion inserts and the pass-2 cycle-FK updates all flow through
    // orchestrator.execute, which runs only after this gate. Without the
    // guard there is no gate, and nothing is written.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      // Refused as the guard refuses, and recorded as the guard's refusals
      // are: the trail kept no trace of a run no guard could judge.
      recordWriteRun(this.deps, {
        action: 'forge_execute',
        module: 'forge',
        operationId: msg.id,
        orgId: config.targetOrgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error(PRODUCTION_GUARD_MISSING.message),
        { code: PRODUCTION_GUARD_MISSING.code },
      );
      return;
    }
    const targetOrg = this.deps.orgManager.getOrg(config.targetOrgId);
    const guardRequest = {
      orgId: config.targetOrgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation: 'insert' as const,
      objectName: graph.nodes?.[0]?.objectApiName ?? 'ForgeData',
      recordCount: graph.totalRecords ?? 0,
      module: 'forge',
    };
    const { check, decision } = await consultProductionGuard(guard, guardRequest);
    /** What the guard decided, recorded with the run it let through. */
    const guardDecision = decision;
    if (decision === 'refused' || decision === 'declined') {
      // No run started, so no operation id was minted: the request's stands in.
      recordWriteRun(this.deps, {
        action: 'forge_execute',
        module: 'forge',
        operationId: msg.id,
        orgId: config.targetOrgId,
        outcome: 'stopped',
        guard: decision,
      });
    }
    if (decision === 'refused') {
      // Single error channel (see handleDiscover): forge:execute:error
      // only — no duplicate operation:failed / parasitic error resolution.
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error(
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
        ),
        { code: 'GUARD_BLOCKED' },
      );
      return;
    }
    // `safety.requireProdConfirmation`: explicit user consent before
    // writing to a production org.
    if (decision === 'declined') {
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error('Operation cancelled by user (production confirmation declined).'),
        { code: 'GUARD_DECLINED', retryable: true },
      );
      return;
    }

    // Build a deterministic ID from payload content to detect genuine duplicates
    const configKey = `${config.sourceOrgId}:${config.targetOrgId}:${config.recordId ?? ''}`;
    const objectKeys = graph.nodes?.map((n) => n.objectApiName).join(',') ?? '';
    const forgeOpId = `forge:${configKey}:${objectKeys}:${graph.totalRecords ?? 0}`;

    // Refuse the payload only while an identical run is still in flight, or
    // during a short cooldown after one that actually wrote records. Anything
    // else — a failed run, a run that created nothing — is retryable at once.
    const tracked = this.dmlTracker.isDuplicate(forgeOpId)
      ? this.dmlTracker.get(forgeOpId)
      : undefined;
    const lastWrite = this.lastWriteAt.get(forgeOpId);
    const inCooldown =
      lastWrite !== undefined && Date.now() - lastWrite < ForgeHandler.DUPLICATE_COOLDOWN_MS;
    if (tracked?.status === 'pending' || inCooldown) {
      logger.warn('Duplicate forge execution detected', { operationId: forgeOpId });
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error(`Duplicate forge operation: ${forgeOpId}`),
        { code: 'DUPLICATE' },
      );
      return;
    }

    const totalRecords = graph.totalRecords ?? 0;
    if (tracked) {
      // A previous attempt with this exact payload reached a terminal state.
      // `register()` throws on an id it already knows and the tracker exposes
      // no release call, so re-arm the entry in place — including its
      // registration stamp, which anchors the TTL to this attempt.
      tracked.status = 'pending';
      tracked.recordCount = totalRecords;
      tracked.registeredAt = new Date().toISOString();
    } else {
      this.dmlTracker.register(forgeOpId, 'forge', 'upsert', totalRecords);
    }

    const runController = new AbortController();
    this.abortController = runController;
    const operationId = `forge-execute-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Executing forge operation');
    const releaseRun = this.trackRun(operationId, 'Executing forge operation', runController, true);
    // Listed in Live Operations while it runs, where Cancel reaches it
    // through the registry, as a Sync or a Seed run is.
    this.liveTracker?.register(operationId, 'forge', 'Executing forge operation');
    this.executeOperationId = operationId;
    /** When the executor was handed the run: a run it stopped is recorded from then. */
    let startedAt = Date.now();
    /** What the run failed on, so the registry lists it as failed. */
    let runError: unknown;

    /** Whether the cancel came before the executor started, so nothing was written. */
    let stoppedBeforeStart = false;

    // Throttle execute progress events to ~10/s. With Bulk API 2.0 batches
    // of 200 records, a 50K-record clone fires ~250 events; spamming each
    // through postMessage adds tens of MB of redundant traffic.
    const throttledExecProgress = throttle((event: Record<string, unknown>) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:progress', event);
      this.deps.broker.postToWebview(progressMsg);
    }, 100);
    const reportToLiveOperations = this.liveProgressOf(operationId, graph);
    const unsubProgress = this.orchestrator.on('forge:progress', (event) => {
      reportToLiveOperations(event);
      /*
       * Always pass through terminal states so the UI can finalize — and
       * 'skipped' is terminal.
       *
       * The throttle coalesces and keeps only the last arguments, and the
       * executor emits 'skipped' with no await between two nodes: back-to-back
       * skips lost all but the last. Those nodes stayed "queued" for the whole
       * run, progress stuck at done/total, and the webview's "every node has
       * settled" test never fired — mission control span forever on a run that
       * had finished.
       */
      const status = (event as { status?: string }).status;
      if (status === 'done' || status === 'error' || status === 'skipped') {
        throttledExecProgress.flush();
        const progressMsg = buildResponse(
          this.deps,
          msg,
          'forge:progress',
          event as unknown as Record<string, unknown>,
        );
        this.deps.broker.postToWebview(progressMsg);
        return;
      }
      throttledExecProgress(event as unknown as Record<string, unknown>);
    });

    try {
      logger.info('Forge execute started');
      // RecordType Ids differ between orgs. Without this table every cloned
      // record kept the source org's RecordTypeId, which the target rejects.
      const recordTypeMappings = await this.loadRecordTypeMappings(config, runController.signal);
      // An Abort that lands during that lookup reaches an executor that has not
      // started yet, and execute() clears its abort flag on entry — the run
      // would go ahead and write. Honour it here instead.
      if (runController.signal.aborted) {
        stoppedBeforeStart = true;
        throw new Error('Forge execution was aborted before it started. Nothing was written.');
      }
      startedAt = Date.now();
      const result = await this.orchestrator.execute(graph, config, {
        recordTypeMappings,
        anonymizationRules,
        files,
      });

      // Arm the duplicate cooldown only when the run created something: a
      // failure, or a run that created no record, leaves the recipe
      // immediately re-runnable. The remap table also holds what was only
      // matched — records the target already held, the standard price book,
      // parents found in place — so its size said "wrote" of a run that
      // created nothing; the run's own count of what it created does not.
      const created =
        result.createdCount ?? result.idRemapCount - (result.linkedExistingCount ?? 0);
      if (result.status !== 'failure' && created > 0) {
        this.noteForgeWrite(forgeOpId);
      }
      // The executor reports a run it could not finish by resolving with a
      // failure status rather than throwing. Left as a plain resolution, the
      // registry announced "forge completed" for a clone that wrote nothing.
      if (result.status === 'failure') {
        runError = new Error('Forge execution finished with a failure status.');
      }

      recordWriteRun(this.deps, {
        action: 'forge_execute',
        module: 'forge',
        operationId,
        orgId: config.targetOrgId,
        outcome: result.status,
        guard: guardDecision,
        objects: forgeAuditObjects(result),
        source: { origin: 'org', orgId: config.sourceOrgId },
        carried: forgeCarried(result),
      });

      this.addToHistory(result, config);

      const response = buildResponse(this.deps, msg, 'forge:execute:response', {
        result,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      this.dmlTracker.markCompleted(forgeOpId);
      sendOperationCompleted(this.deps, operationId, { status: result.status });
      if (result.status === 'failure') {
        this.liveTracker?.fail(operationId, 'Forge execution finished with a failure status.');
      } else {
        this.liveTracker?.complete(operationId);
      }
    } catch (error: unknown) {
      // A cancel, not a failure: stopped before the executor started, or by
      // the executor's own abort. Any other error thrown while the cancel is
      // pending is still the run's failure.
      const cancelled = stoppedBeforeStart || isForgeAbort(error);
      if (!cancelled) runError = error;
      // What the run wrote before it threw travels with the error: an abort
      // after the first objects, or a failure further on, is recorded with
      // the rows it created and lost, not as a run that wrote nothing.
      const partial = partialSummaryOf(error);
      const tallies = partial
        ? { idRemapByObject: partial.remapByObject, errors: partial.errors }
        : undefined;
      // Kept in the history with what it created and where, so those records
      // can be removed from there: the run that went wrong is the one most
      // worth taking back. A run that created nothing is not kept.
      if (partial) this.keepStoppedRun(partial, graph, config, { startedAt, cancelled });
      recordWriteRun(this.deps, {
        action: 'forge_execute',
        module: 'forge',
        operationId,
        orgId: config.targetOrgId,
        outcome: 'failure',
        guard: guardDecision,
        ...(tallies
          ? {
              objects: forgeAuditObjects(tallies),
              source: { origin: 'org' as const, orgId: config.sourceOrgId },
              carried: forgeCarried(tallies),
            }
          : {}),
      });
      this.dmlTracker.markFailed(forgeOpId);
      // A failed or stopped run is re-runnable at once: clear any cooldown so
      // the user can fix the cause and run it again.
      this.lastWriteAt.delete(forgeOpId);
      // `forge:execute:error` is what the execution screen shows. The run's
      // end is posted too, as every other module posts it: with the error
      // alone, the recent operations and the side panel showed a failed or
      // stopped clone as running for the rest of the session.
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', msg, error, {
        code: 'EXECUTE_ERROR',
        retryable: true,
      });
      if (cancelled) {
        // Aborted in the registry already when the cancel came through it,
        // which is then a no-op.
        this.deps.infraServices?.backgroundRegistry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
      } else {
        sendOperationFailed(this.deps, operationId, extractErrorMessage(error), true);
        this.liveTracker?.fail(operationId, extractErrorMessage(error));
      }
    } finally {
      releaseRun(runError);
      if (this.executeOperationId === operationId) this.executeOperationId = null;
      // Unsubscribe BEFORE flushing so the flush's terminal event
      // doesn't trigger any progress listeners that we're about to remove.
      // Then flush so the last queued progress event reaches the webview
      // before this handler returns.
      unsubProgress();
      throttledExecProgress.flush();
      this.abortController = null;
    }
  }

  /**
   * Put a run in the history, with the config that produced it and the org it
   * wrote to.
   *
   * Without the config an entry is inspectable but not repeatable — there is
   * nothing to rebuild a `forge:execute` from. Org ids are stripped from it
   * (same shape as ForgeTemplate.config): a re-run re-picks source and target
   * instead of replaying yesterday's org pair. The target is kept beside the
   * config, never in it: removing what the run created has to reach the org it
   * wrote to.
   */
  private addToHistory(result: ForgeExecutionResult, config: ForgeConfig): void {
    const entry: ForgeExecutionResult = {
      ...result,
      config: stripOrgIds(config),
      targetOrgId: config.targetOrgId,
    };
    this.saveHistory([entry, ...this.loadHistory()].slice(0, ForgeHandler.MAX_HISTORY));
  }

  /**
   * Keep a run that stopped part way — on a failure, or on a cancel — with
   * what it had created by then, as the executor held it when it stopped.
   *
   * Never a success: the run did not reach its end. A cancelled run reads as
   * partial and says it was cancelled, as a cancelled Sync does; one that
   * failed reads as failed. A run that created nothing leaves nothing to
   * remove, and is not kept.
   */
  private keepStoppedRun(
    summary: ExecutionSummary,
    graph: ForgeGraph,
    config: ForgeConfig,
    run: { startedAt: number; cancelled: boolean },
  ): void {
    if (!summary.createdByObject.some((object) => object.sourceIds.length > 0)) return;
    const result = forgeRunResult(summary, graph, {
      startedAt: run.startedAt,
      status: run.cancelled ? 'partial' : 'failure',
    });
    this.addToHistory(run.cancelled ? { ...result, cancelled: true } : result, config);
  }

  /**
   * What Live Operations shows of a clone as the executor reports it: the
   * share of the graph's objects settled, and the records of those objects.
   * The executor names the records of an object when it starts writing it and
   * counts nothing per record, so the count moves object by object.
   */
  private liveProgressOf(
    operationId: string,
    graph: ForgeGraph,
  ): (event: ForgeProgressEvent) => void {
    const objects = graph.nodes.filter((node) => node.included).length;
    const recordsOf = new Map<string, number>();
    const settled = new Set<string>();
    let records = 0;
    return (event) => {
      if (typeof event.recordCount === 'number') {
        recordsOf.set(event.objectName, event.recordCount);
      }
      const terminal =
        event.status === 'done' || event.status === 'error' || event.status === 'skipped';
      if (terminal && !settled.has(event.objectName)) {
        settled.add(event.objectName);
        records += recordsOf.get(event.objectName) ?? 0;
      }
      const percent = objects > 0 ? Math.min(100, Math.round((settled.size / objects) * 100)) : 0;
      this.liveTracker?.updateProgress(operationId, percent, records, 0, event.message);
    };
  }

  private handlePause(_msg: BaseMessage): void {
    this.orchestrator?.pause();
    logger.info('Forge paused');
  }

  private handleResume(_msg: BaseMessage): void {
    this.orchestrator?.resume();
    logger.info('Forge resumed');
  }

  private handleAbort(_msg: BaseMessage): void {
    // Signal abort, then null the refs so a stale post-abort signal
    // can't leak between sequential operations (e.g. abort during discover
    // followed by an immediate execute). The handler functions reset the
    // refs on entry, but defensive nulling here closes the race window.
    // The registry first: it stamps the run aborted and stops it through the
    // handle it was registered with. Settling the tracked promise instead
    // would record the stopped run as completed.
    const registry = this.deps.infraServices?.backgroundRegistry;
    if (this.discoverOperationId) registry?.abort(this.discoverOperationId);
    if (this.executeOperationId) registry?.abort(this.executeOperationId);
    this.discoverAbortController?.abort();
    this.discoverAbortController = null;
    this.abortController?.abort();
    this.abortController = null;
    this.orchestrator?.abort();
    logger.info('Forge aborted');
  }

  /**
   * Build the source -> target RecordType table the executor translates
   * `RecordTypeId` with, the way the command-line clone does: active record
   * types of both orgs, matched by object and DeveloperName.
   *
   * A failure here does not stop the run. It is logged, and the clone proceeds
   * as it did before the table existed — records keep the source Id — rather
   * than refusing a clone whose objects may carry no record type at all. The
   * lookup is bounded: a hung org falls back the same way after
   * {@link RECORD_TYPES_TIMEOUT_MS}, and an Abort returns at once so the
   * caller can refuse the run without waiting for the org to answer.
   */
  private async loadRecordTypeMappings(
    config: ForgeConfig,
    signal: AbortSignal,
  ): Promise<RecordTypeMapping[] | undefined> {
    let onAbort: () => void = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const lookup = new TimeoutManager(RECORD_TYPES_TIMEOUT_MS).withTimeout(
        'forge:record-types',
        () => this.readRecordTypeMappings(config),
      );
      return await Promise.race([lookup, aborted]);
    } catch (err: unknown) {
      logger.warn(
        `[forge] Record types could not be read from both orgs (${extractErrorMessage(err)}); ` +
          `cloned records keep their source RecordTypeId.`,
      );
      return undefined;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async readRecordTypeMappings(config: ForgeConfig): Promise<RecordTypeMapping[]> {
    const [sourceTypes, targetTypes] = await Promise.all(
      [config.sourceOrgId, config.targetOrgId].map(async (orgId) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const { records } = await queryAllPages<Record<string, unknown>>(
          {
            query: async (q) => conn.query<Record<string, unknown>>(q),
            queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
          },
          RECORD_TYPES_SOQL,
        );
        return parseRecordTypeRows(records);
      }),
    );
    return new RecordTypeMapper().buildMapping(sourceTypes, targetTypes);
  }

  /**
   * List the saved templates the Template tab can apply.
   *
   * Each entry is read back through the template schema first. The workspace
   * file is meant to be committed and edited by hand, and another version of
   * SandForge may have written it: an entry that no longer reads as a template
   * is left out of the list, not handed to a form that would run it. It stays
   * in the file — the next save writes it back untouched.
   */
  private async handleTemplatesList(msg: InboundRequest): Promise<void> {
    const { templates, importNotMerged } = await this.loadTemplates();
    const response = buildResponse(this.deps, msg, 'forge:templates:list:response', {
      templates: templates.filter((t) => forgeTemplateSchema.safeParse(t).success),
      ...(importNotMerged === undefined ? {} : { importNotMerged }),
    });
    this.deps.broker.postToWebview(response);
  }

  private async handleSaveTemplate(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(
      saveTemplatePayloadSchema,
      msg,
      'forge:templates:save:error',
      this.deps,
    );
    if (!parsed) return;
    const { template } = parsed;
    // A write that fails — a read-only workspace, a full disk — used to throw
    // past the router, which logs it and answers nothing: the panel waited out
    // its timeout for a template that was never saved.
    try {
      const templates = [
        template,
        ...(await this.loadTemplates()).templates.filter((t) => t.id !== template.id),
      ];
      await this.saveTemplates(templates);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'forge:templates:save', 'forge:templates:save:error', msg, err);
      return;
    }
    const response = buildResponse(this.deps, msg, 'forge:templates:save:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
  }

  private async handleDeleteTemplate(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(
      deleteTemplatePayloadSchema,
      msg,
      'forge:templates:delete:error',
      this.deps,
    );
    if (!parsed) return;
    const { templateId } = parsed;
    try {
      const templates = (await this.loadTemplates()).templates.filter((t) => t.id !== templateId);
      await this.saveTemplates(templates);
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'forge:templates:delete',
        'forge:templates:delete:error',
        msg,
        err,
      );
      return;
    }
    const response = buildResponse(this.deps, msg, 'forge:templates:delete:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
  }

  private handleHistoryList(msg: InboundRequest): void {
    const history = this.loadHistory();
    const response = buildResponse(this.deps, msg, 'forge:history:list:response', { history });
    this.deps.broker.postToWebview(response);
  }

  /**
   * Remove from its target org the records a past run created, as its history
   * entry names them — never what the request names: the request says which
   * run, the history says what it created.
   *
   * Refused before anything is read when the entry is gone, was recorded
   * before runs kept what they created, created nothing, had its records
   * removed already, or is being removed now. Then Production Guard judges the
   * delete — a production org is refused, a missing guard refuses too — and
   * the removal runs on the background registry, listed in Live Operations,
   * where Cancel stops it before its next call to the org — but for giving
   * back a status it set to Draft for a delete. The audit trail records it
   * whatever the outcome, and the entry is marked once records went, so the
   * removal is not offered twice.
   */
  private async handleUndo(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(undoPayloadSchema, msg, 'forge:undo:error', this.deps);
    if (!parsed) return;
    const { forgeId } = parsed;
    const includeChanged = parsed.includeChanged === true;
    const refuse = (message: string, code: string): void => this.refuseUndo(msg, message, code);

    const entry = this.loadHistory().find((e) => e.forgeId === forgeId);
    if (!entry) {
      refuse('This run is no longer in the Forge history.', 'NOT_FOUND');
      return;
    }
    const runEnded = Date.parse(entry.timestamp);
    if (!entry.idRemapCreated || !entry.targetOrgId || Number.isNaN(runEnded)) {
      refuse(
        'This run was recorded before Forge kept what a run created: its records cannot be removed from the history.',
        'NOT_RECORDED',
      );
      return;
    }
    if (entry.undo) {
      refuse(
        `The records this run created were already removed, on ${entry.undo.removedAt}.`,
        'ALREADY_REMOVED',
      );
      return;
    }
    const plan = forgeRunCreatedRecords(entry);
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    if (total === 0) {
      refuse('This run created no record to remove.', 'NOTHING_TO_REMOVE');
      return;
    }
    if (this.removing.has(forgeId)) {
      refuse('The records of this run are being removed already.', 'DUPLICATE');
      return;
    }
    // Claimed before Production Guard is consulted: its confirmation waits on
    // a person, and a second click meanwhile would ask, and remove, twice.
    this.removing.add(forgeId);
    try {
      await this.removeRun(msg, { ...entry, targetOrgId: entry.targetOrgId }, plan, includeChanged);
    } finally {
      this.removing.delete(forgeId);
    }
  }

  /** Answer a `forge:undo` that removes nothing, on its error channel. */
  private refuseUndo(msg: InboundRequest, message: string, code: string): void {
    sendHandlerError(this.deps, 'forge:undo', 'forge:undo:error', msg, new Error(message), {
      code,
    });
  }

  /**
   * The removal of {@link handleUndo} once the request is known to name a
   * run whose records can be removed: Production Guard, then the run itself.
   */
  private async removeRun(
    msg: InboundRequest,
    entry: ForgeExecutionResult & { targetOrgId: string },
    plan: ForgeRunObjectRecords[],
    includeChanged: boolean,
  ): Promise<void> {
    const { forgeId, targetOrgId } = entry;
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    const refuse = (message: string, code: string): void => this.refuseUndo(msg, message, code);

    // Production Guard judges the delete before anything is read, as on every
    // write path; without it nothing is deleted.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'forge',
        operationId: msg.id,
        orgId: targetOrgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      refuse(PRODUCTION_GUARD_MISSING.message, PRODUCTION_GUARD_MISSING.code);
      return;
    }
    const targetOrg = this.deps.orgManager.getOrg(targetOrgId);
    const { check, decision } = await consultProductionGuard(guard, {
      orgId: targetOrgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation: 'delete',
      objectName: plan.map((o) => o.objectApiName).join(', '),
      recordCount: total,
      module: 'forge',
    });
    if (decision === 'refused' || decision === 'declined') {
      // No removal started, so no operation id was minted: the request's stands in.
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'forge',
        operationId: msg.id,
        orgId: targetOrgId,
        outcome: 'stopped',
        guard: decision,
      });
      if (decision === 'refused') {
        refuse(
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          'GUARD_BLOCKED',
        );
      } else {
        sendHandlerError(
          this.deps,
          'forge:undo',
          'forge:undo:error',
          msg,
          new Error('Operation cancelled by user (production confirmation declined).'),
          { code: 'GUARD_DECLINED', retryable: true },
        );
      }
      return;
    }

    const operationId = `forge-undo-${this.deps.nextId()}`;
    const description = `Removing ${total} record(s) a Forge run created`;
    const stop = new AbortController();
    sendOperationStarted(this.deps, operationId, 'forge', description);
    const releaseRun = this.trackRun(operationId, description, stop);
    this.liveTracker?.register(operationId, 'forge', description, total);
    /** What the removal failed on, so the registry lists it as failed. */
    let runError: unknown;

    try {
      const conn = await getJsforceConnection(
        targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      // The run's span as the target dated it; this machine's clock is never
      // compared with the org's. A run the target did not date — recorded
      // before runs kept it, or whose dates could not all be read back — is
      // dated by its records and by when it was recorded, read on the org's
      // clock as the removal starts.
      const span = entry.writtenBetween;
      const outcome = await removeRunRecords(removalOrg(conn, 'forge:undo'), plan, {
        ...(span
          ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
          : { runDurationMs: entry.duration, runRecordedAt: new Date(entry.timestamp) }),
        ...(entry.removalStamps ? { removalStamps: entry.removalStamps } : {}),
        includeChanged,
        signal: stop.signal,
        onProgress: (settled, of, objectApiName) => {
          const percent = Math.min(100, Math.round((settled / Math.max(of, 1)) * 100));
          sendOperationProgress(this.deps, operationId, percent, settled, of, objectApiName);
          // A removal cancelled from Live Operations finishes its call to the
          // org; the registry has recorded the stop and hears no more of it.
          if (!stop.signal.aborted) {
            this.deps.infraServices?.backgroundRegistry?.updateProgress(operationId, percent);
          }
          this.liveTracker?.updateProgress(operationId, percent, settled, of, objectApiName);
        },
      });
      const result: ForgeUndoResult = {
        forgeId,
        status: undoStatus(outcome.objects, outcome.cancelled),
        includeChanged,
        objects: outcome.objects,
        finishedAt: new Date().toISOString(),
      };

      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'forge',
        operationId,
        orgId: targetOrgId,
        outcome: undoAuditOutcome(result),
        guard: decision,
        objects: undoAuditObjects(result.objects),
      });

      // Marked once records went, or none was left to go. A removal stopped
      // part way, or one that deleted nothing, is offered again — with what
      // it wrote to the records it left, which the next one does not read as
      // a change since the run.
      const mark =
        result.status === 'success' || result.status === 'partial' ? undoMark(result) : undefined;
      const stamped = Object.keys(outcome.stamps).length > 0;
      if (mark || stamped) {
        this.saveHistory(
          this.loadHistory().map((e) =>
            e.forgeId === forgeId
              ? {
                  ...e,
                  ...(mark ? { undo: mark } : {}),
                  ...(stamped ? { removalStamps: { ...e.removalStamps, ...outcome.stamps } } : {}),
                }
              : e,
          ),
        );
      }

      const response = buildResponse(this.deps, msg, 'forge:undo:response', {
        result,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      if (result.status === 'cancelled') {
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
      } else {
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        if (result.status === 'failure') {
          runError = new Error('No record this run created could be removed.');
          this.liveTracker?.fail(operationId, 'No record this run created could be removed.');
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
    } catch (error: unknown) {
      runError = error;
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'forge',
        operationId,
        orgId: targetOrgId,
        outcome: 'failure',
        guard: decision,
      });
      // Single error channel (see handleDiscover); the completion ends the
      // operation the panels listed as running.
      sendHandlerError(this.deps, 'forge:undo', 'forge:undo:error', msg, error, {
        code: 'UNDO_ERROR',
        retryable: true,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      this.liveTracker?.fail(operationId, extractErrorMessage(error));
    } finally {
      releaseRun(runError);
    }
  }

  /** Generate a forge execution plan from a graph. */
  private async handlePlanRequest(msg: InboundRequest): Promise<void> {
    if (!this.planGenerator) {
      sendHandlerError(
        this.deps,
        'forge:plan',
        'forge:plan:error',
        msg,
        new Error('Plan generator not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(planRequestPayloadSchema, msg, 'forge:plan:error', this.deps);
    if (!parsed) return;
    const { graph, config } = parsed;
    const operationId = `forge-plan-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating execution plan');
    try {
      logger.info('Forge plan generation started');
      const described = await this.readPersonalFields(graph, config);
      const plan = await new TimeoutManager(PLAN_TIMEOUT_MS).withTimeout('forge:plan', () =>
        Promise.resolve(this.planGenerator!.generate(described)),
      );
      // The graph goes back only when the read named a personal field the
      // page did not have; otherwise the page keeps the graph it holds.
      const response = buildResponse(
        this.deps,
        msg,
        'forge:plan:response',
        described === graph ? { plan } : { plan, graph: described },
      );
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { waveCount: plan.waves?.length ?? 0 });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // One error shown: `forge:plan:error`, what the screen reads. The
      // operation ends as a completion that says it failed, not as
      // `operation:failed`, which would ask for a fix suggestion on top; with
      // no end at all, the recent operations listed it running for good.
      sendHandlerError(this.deps, 'forge:plan', 'forge:plan:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'PLAN_ERROR',
        retryable: isTimeout,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
    }
  }

  /**
   * The graph Review is to show, with the personal fields of the nodes that
   * know none of their fields read from the source org.
   *
   * A starter template's graph comes without discovery, so none of its nodes
   * named a personal field, and its "Anonymize PII" toggle had nothing to act
   * on. A read that fails or does not answer in time leaves the graph as it
   * came: the plan does not depend on it, and the run reads those fields
   * again when it writes.
   */
  private async readPersonalFields(graph: ForgeGraph, config: ForgeConfig): Promise<ForgeGraph> {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return graph;
    try {
      return await new TimeoutManager(PLAN_TIMEOUT_MS).withTimeout(
        'forge:plan:personal-fields',
        (signal) => orchestrator.readPersonalFields(graph, config, signal),
      );
    } catch (error: unknown) {
      logger.warn(`Forge personal fields not read: ${extractErrorMessage(error)}`);
      return graph;
    }
  }

  /** Generate a compliance report for a graph and framework. */
  private async handleComplianceRequest(msg: InboundRequest): Promise<void> {
    if (!this.complianceService) {
      sendHandlerError(
        this.deps,
        'forge:compliance',
        'forge:compliance:error',
        msg,
        new Error('Compliance service not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(
      complianceRequestPayloadSchema,
      msg,
      'forge:compliance:error',
      this.deps,
    );
    if (!parsed) return;
    const { framework, graph, config } = parsed;
    const operationId = `forge-compliance-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating compliance report');
    try {
      logger.info('Forge compliance report generation started');
      const report = await new TimeoutManager(COMPLIANCE_TIMEOUT_MS).withTimeout(
        'forge:compliance',
        () =>
          Promise.resolve(
            this.complianceService!.generate(
              framework as ComplianceFrameworkType,
              graph,
              config.sourceOrgId,
              config.targetOrgId,
            ),
          ),
      );
      const response = buildResponse(this.deps, msg, 'forge:compliance:response', { report });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { framework });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // One error shown: `forge:compliance:error`, what the screen reads. The
      // operation ends as a completion that says it failed, not as
      // `operation:failed`, which would ask for a fix suggestion on top; with
      // no end at all, the recent operations listed it running for good.
      sendHandlerError(this.deps, 'forge:compliance', 'forge:compliance:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'COMPLIANCE_ERROR',
        retryable: isTimeout,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
    }
  }

  /** Compare metadata schemas between source and target orgs. */
  private async handleMetadataDiffRequest(msg: InboundRequest): Promise<void> {
    if (!this.metadataDiff) {
      sendHandlerError(
        this.deps,
        'forge:metadata-diff',
        'forge:metadata-diff:error',
        msg,
        new Error('Metadata diff service not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(
      metadataDiffRequestPayloadSchema,
      msg,
      'forge:metadata-diff:error',
      this.deps,
    );
    if (!parsed) return;
    const { sourceOrgId, targetOrgId, objectApiNames } = parsed;
    const operationId = `forge-metadata-diff-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Comparing metadata schemas');
    try {
      logger.info('Forge metadata diff started');
      const diffs = await new TimeoutManager(METADATA_DIFF_TIMEOUT_MS).withTimeout(
        'forge:metadata-diff',
        () => this.metadataDiff!.compare(sourceOrgId, targetOrgId, objectApiNames),
      );
      const response = buildResponse(this.deps, msg, 'forge:metadata-diff:response', { diffs });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { objectCount: objectApiNames.length });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // One error shown: `forge:metadata-diff:error`, what the screen reads. The
      // operation ends as a completion that says it failed, not as
      // `operation:failed`, which would ask for a fix suggestion on top; with
      // no end at all, the recent operations listed it running for good.
      sendHandlerError(this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'METADATA_DIFF_ERROR',
        retryable: isTimeout,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
    }
  }
}
