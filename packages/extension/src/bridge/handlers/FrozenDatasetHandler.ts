import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AuditObjectCounts,
  AuditOutcome,
  ForgeConfig,
  ForgeGraph,
  FrozenControlReport,
  FrozenGraphCoverage,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenRemovalResult,
  FrozenSelectionSummary,
  FrozenStatusInfo,
  ForgeRunObjectRecords,
  GuardDecision,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import {
  consultProductionGuard,
  strongerDecision,
} from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { removalOrg, removeRunRecords } from '../../modules/forge/ForgeRunRemoval.js';
import {
  removalAuditObjects,
  removalAuditOutcome,
  removalMark,
  removalMarks,
  removalStatus,
} from '../../modules/forge/removalOutcome.js';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  robustnessConfigOf,
  bulkManagerOf,
  PRODUCTION_GUARD_MISSING,
} from './HandlerTypes.js';
import {
  validatePayload,
  frozenConfigSavePayloadSchema,
  frozenSelectPayloadSchema,
  frozenExtractPayloadSchema,
  frozenLoadPayloadSchema,
  frozenRemovePayloadSchema,
  frozenVerifyPayloadSchema,
} from '../validatePayload.js';
import { logger } from '../../logger.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import {
  DEFAULT_MAX_NODES,
  GraphDiscoveryService,
} from '../../modules/forge/GraphDiscoveryService.js';
import type { ObjectDescribe } from '../../modules/forge/GraphDiscoveryService.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import type { ScopableField } from '../../modules/forge/ScopedSoqlBuilder.js';
import {
  CoverageMatrixSelector,
  CustomMetadataCalloutMockDetector,
  DeterministicPseudonymizer,
  FrozenDatasetAnonymizer,
  FrozenDatasetExtractor,
  FrozenDatasetLoader,
  FrozenDatasetWriter,
  FrozenLoadCancelledError,
  FrozenLoadFailedError,
  InsideRepoPathError,
  LoadConfigError,
  LoadGuardError,
  MissingSaltError,
  NonReidentificationControl,
  PLATFORM_RECORDS_FILE_NAME,
  PostLoadVerifier,
  SELECTION_FILE_NAME,
  SasPathGuard,
  SasReferenceIdMappingStore,
  ScopedDossierHealthChecker,
  TargetRecordTypeIdResolver,
  VolumetryBudgetExceededError,
  buildFrozenManifest,
  contractCountsLoad,
  countingContractPath,
  createBulkDmlWriter,
  datasetRecordCount,
  leftToThePlatformCoverage,
  loadCreatedRecords,
  loadRecordsInfo,
  loadToRemove,
  loadTokensFromSas,
  parseManifest,
  parsePseudonymRules,
  readCountingContract,
  readSelectionFromSas,
  writeSelectionToSas,
  type ControlViolation,
  type CoverageSelectionResult,
  type FrozenDataset,
  type FrozenLoadConfig,
  type FrozenLoadProgressEvent,
  type FrozenLoadReport,
  type FrozenManifest,
  type FrozenObjectData,
  type FrozenRecordTypeRef,
  type NonReidentificationReport,
  type PersonContactLink,
  type RecordedLoad,
  type TargetOrgAccess,
} from '../../modules/frozendataset/index.js';

/** Message types handled by FrozenDatasetHandler. */
const FROZEN_TYPES = new Set([
  'frozen:config:get',
  'frozen:config:save',
  'frozen:select',
  'frozen:extract',
  'frozen:manifest:get',
  'frozen:load',
  'frozen:verify',
  'frozen:remove',
  'frozen:status',
]);

/** ConfigStore category for all frozen-dataset data. */
const FROZEN_CATEGORY = 'frozen';

/** ConfigStore key of the per-project configuration. */
const CONFIG_KEY = 'frozen:config';

/** ConfigStore key of the last load run pointers (verify/status). */
const LAST_RUN_KEY = 'frozen:lastRun';

/** ConfigStore key of the last verification verdict. */
const LAST_VERIFY_KEY = 'frozen:lastVerify';

/** Token file name inside the sas ({{TOKEN}} values for SOQL templates). */
const TOKENS_FILE_NAME = 'tokens.json';

/** Default rules file name when the config does not point at one. */
const DEFAULT_RULES_FILE_NAME = 'rules.json';

/** Default dataset semver when the config does not declare one. */
const DEFAULT_DATASET_VERSION = '0.1.0';

/** Selection / extraction timeouts (long, but bounded — probes + full pull). */
const SELECT_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 15 * 60_000;

/** Violations per check sent to the webview (cap + see sanitizeViolationDetail). */
const MAX_VIOLATIONS_PER_CHECK = 50;

/** Pointers persisted after a load so verify/status can chain onto it. */
interface FrozenLastRun {
  contractPath: string;
  datasetDir: string;
  manifestPath: string;
  targetOrgId: string;
  status: string;
  at: string;
}

/**
 * Throttle a function to at most one call per `delayMs` (same pattern as
 * ForgeHandler): mid-stream calls coalesce, `.flush()` emits the pending one.
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
 * Whether a path exists. Asked before every optional read of the sas, and
 * asked without holding the extension host while the disk answers.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Redact one control violation detail for the bridge. The `clear-empty`
 * detail embeds the residual value — which, under a `clear` rule, can be
 * source data. Everything else is truncated to a bounded length.
 */
function sanitizeViolationDetail(violation: ControlViolation): string {
  if (violation.check === 'clear-empty') {
    return 'residual value under "clear" generator (value redacted at the bridge)';
  }
  return violation.detail.length > 200 ? `${violation.detail.slice(0, 200)}…` : violation.detail;
}

/** Sanitize + cap a gate report before it crosses the bridge. */
function sanitizeControlReport(report: NonReidentificationReport): FrozenControlReport {
  return {
    passed: report.passed,
    author: report.author,
    checkedAt: report.checkedAt,
    checks: report.checks.map((check) => ({
      name: check.name,
      passed: check.passed,
      violations: check.violations.slice(0, MAX_VIOLATIONS_PER_CHECK).map((v) => ({
        check: v.check,
        objectApiName: v.objectApiName,
        referenceId: v.referenceId,
        field: v.field,
        detail: sanitizeViolationDetail(v),
      })),
    })),
  };
}

/** Map an engine manifest to its bridge DTO (control report sanitized). */
function toManifestInfo(manifest: FrozenManifest): FrozenManifestInfo {
  return {
    version: manifest.version,
    status: manifest.status,
    frozenAt: manifest.frozenAt,
    source: manifest.source,
    saltFingerprint: manifest.saltFingerprint,
    rulesVersion: manifest.rulesVersion,
    volumetry: manifest.volumetry,
    controls: {
      nonReidentification: sanitizeControlReport(manifest.controls.nonReidentification),
      dryRunLoad: manifest.controls.dryRunLoad,
      author: manifest.controls.author,
      date: manifest.controls.date,
    },
    ...(manifest.coverage ? { coverage: manifest.coverage } : {}),
  };
}

/**
 * Map a selection result to its REDACTED bridge summary: source record IDs
 * stay in the sas — a real↔anonymized correspondence table never crosses
 * the bridge.
 */
function toSelectionSummary(
  result: CoverageSelectionResult,
  selectionPath: string,
  graph: FrozenGraphCoverage | undefined,
): FrozenSelectionSummary {
  return {
    combinations: result.roots.map((root) => ({
      combinationKey: root.combinationKey,
      axisValues: root.axisValues,
      edgeCase: root.edgeCase,
    })),
    uncovered: result.uncovered,
    volumetry: result.volumetry,
    selectedAt: result.selectedAt,
    selectionPath,
    ...(graph ? { graph } : {}),
  };
}

/** The graph with the objects the configuration leaves out marked so. */
function withoutExcluded(graph: ForgeGraph, excluded: readonly string[] | undefined): ForgeGraph {
  if (!excluded || excluded.length === 0) return graph;
  const out = new Set(excluded);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (out.has(n.objectApiName) ? { ...n, included: false } : n)),
  };
}

/** How far a discovery reached, at the cap it ran with. */
function graphCoverage(graph: ForgeGraph, maxNodes: number): FrozenGraphCoverage {
  return { objects: graph.nodes.length, truncated: graph.truncated === true, maxNodes };
}

/**
 * Map an engine load report to its bridge DTO (alignedRecords dropped).
 * Exported so it can be tested.
 */
export function toLoadReportInfo(report: FrozenLoadReport): FrozenLoadReportInfo {
  return {
    status: report.status,
    orgId: report.orgId,
    mode: report.mode,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    alignment: {
      excludedObjects: report.alignment.excludedObjects,
      removals: report.alignment.removals,
      adjustments: report.alignment.adjustments,
      recordTypeIssues: report.alignment.recordTypeIssues,
    },
    placeholders: report.placeholders,
    requiredDefaults: report.requiredDefaults,
    perObject: report.perObject,
    pass2: report.pass2,
    personContact: report.personContact,
    statuses: report.statuses,
    purge: report.purge,
    ...(report.leftToThePlatform ? { leftToThePlatform: report.leftToThePlatform } : {}),
    ...(report.untypedFeedItems ? { untypedFeedItems: report.untypedFeedItems } : {}),
    mappingPath: report.mappingPath,
    contractPath: report.contractPath,
  };
}

/**
 * How a load ended, for the audit trail: a load that lists no failure
 * succeeded; one that lists some put part of its records in the target —
 * inserted, or reused on a reload — or none of them.
 */
function frozenOutcome(report: FrozenLoadReport): AuditOutcome {
  if (report.status === 'completed') return 'success';
  const landed = report.perObject.reduce((sum, o) => sum + o.inserted + o.reused, 0);
  return landed > 0 ? 'partial' : 'failure';
}

/**
 * How a load the cancel stopped ended, for the audit trail: never a success,
 * since it did not write the whole dataset; a failure when the org refused
 * every record it was sent, and nothing landed.
 */
function cancelledFrozenOutcome(
  written: Pick<FrozenLoadReport, 'perObject' | 'placeholders'>,
): AuditOutcome {
  const landed = written.perObject.reduce((sum, o) => sum + o.inserted + o.reused, 0);
  const refused = written.perObject.reduce((sum, o) => sum + o.failed.length, 0);
  return landed === 0 && written.placeholders.length === 0 && refused > 0 ? 'failure' : 'partial';
}

/**
 * What a load did per object, for the audit trail: records inserted and the
 * placeholders created for them, records a reload deactivated or purged, and
 * the ones the org refused — duplicates it skipped among them, since the org
 * would not take them.
 */
function frozenAuditObjects(
  report: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>,
): AuditObjectCounts[] {
  const byObject = new Map<string, AuditObjectCounts>();
  const countsOf = (objectApiName: string): AuditObjectCounts => {
    const counts = byObject.get(objectApiName) ?? emptyCounts(objectApiName);
    byObject.set(objectApiName, counts);
    return counts;
  };
  for (const object of report.perObject) {
    const counts = countsOf(object.objectApiName);
    counts.created += object.inserted;
    counts.failed += object.failed.length + object.skippedDuplicates.length;
  }
  for (const placeholder of report.placeholders) {
    countsOf(placeholder.placeholderObjectApiName).created += 1;
  }
  for (const [objectApiName, deleted] of Object.entries(report.purge.deleted)) {
    countsOf(objectApiName).deleted += deleted;
  }
  for (const [objectApiName, deactivated] of Object.entries(report.purge.deactivated)) {
    countsOf(objectApiName).updated += deactivated;
  }
  for (const failure of report.purge.failures) {
    countsOf(failure.objectApiName).failed += 1;
  }
  return [...byObject.values()];
}

/**
 * Per object, the dataset records the load gave a real id in the target, read
 * back from the mapping store it persists — reused and inserted alike. The
 * store holds this run's mapping only: the loader replaces it whole. Counted,
 * never copied: the ids stay in the sas.
 *
 * @returns `undefined` when the mapping cannot be read back; the lineage then
 *   counts what the load wrote.
 */
async function frozenCarried(
  dataset: FrozenDataset,
  mappingStore: SasReferenceIdMappingStore,
): Promise<Record<string, number> | undefined> {
  try {
    const mapping = await mappingStore.load();
    return Object.fromEntries(
      dataset.objects.map((object) => [
        object.objectApiName,
        object.records.filter((record) => mapping.has(record.referenceId)).length,
      ]),
    );
  } catch {
    return undefined;
  }
}

/**
 * Domain handler for the Frozen Reference Dataset module (`frozen:*`).
 *
 * Covers the whole lifecycle without any UI: project config, coverage-matrix
 * selection, extraction + pseudonymization + 4-point gate + frozen write,
 * replayable load (Production Guard + entry guards, pilot mode) and the
 * chained read-only post-load verification.
 *
 * Security invariants enforced at this boundary:
 *  - the sas/dataset paths go through SasPathGuard (refused inside the repo);
 *  - the pseudonymization salt comes from `SANDFORGE_FROZEN_SALT` only —
 *    its SHA-256 fingerprint is the only salt-derived value ever surfaced;
 *  - source record IDs never cross the bridge (selection summary redacted);
 *  - control violation details are redacted/truncated (residual values).
 */
export class FrozenDatasetHandler implements DomainHandler {
  private registry?: BackgroundOperationRegistry;
  /** What the Monitor's Live Operations panel lists, with a Cancel for each run. */
  private liveTracker?: LiveOperationTracker;

  /** The mappings whose load is being removed, by file: one removal at a time each. */
  private readonly removing = new Set<string>();

  /**
   * Describe caches shared by every discovery this handler builds.
   *
   * GraphDiscoveryService.discover is schema-scoped, not record-scoped — the
   * record id is consumed only by the key-prefix lookup in resolveRootObject —
   * so every candidate root probed by CoverageMatrixSelector replayed a
   * byte-identical describe sequence against the org. Without memoization that
   * is one uncached BFS per candidate, on an org where a single forge run was
   * already measured at 600+ describe round trips.
   *
   * Same keys and options as composition/forgeComposition.ts, which fronts the
   * identical two adapters and has carried this cache since v1.8.
   */
  private readonly describeCache = new SchemaCache<ObjectDescribe>({
    defaultTtl: 5 * 60_000,
    maxSize: 50,
    maxSizeBytes: 200 * 1024 * 1024,
  });

  private readonly describeGlobalCache = new SchemaCache<
    Array<{ name: string; keyPrefix: string | null }>
  >({
    defaultTtl: 5 * 60_000,
    maxSize: 16,
    maxSizeBytes: 50 * 1024 * 1024,
  });

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Drop the describes held for an org that is no longer the org it was: a
   * refreshed sandbox takes production's schema as of the refresh.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    this.describeCache.invalidateByPrefix(`${orgId}::`);
    this.describeGlobalCache.invalidate(orgId);
  }

  /**
   * Inject the shared registry so dataset loads are cancellable.
   * Called from ExtensionHandlers, same as SeedOpsHandler.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** Inject the tracker the Monitor's Live Operations panel lists. */
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
    if (!FROZEN_TYPES.has(msg.type)) return false;

    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    switch (msg.type) {
      case 'frozen:config:get':
        this.handleConfigGet(msg);
        return true;
      case 'frozen:config:save':
        this.handleConfigSave(msg);
        return true;
      case 'frozen:select':
        await this.handleSelect(msg);
        return true;
      case 'frozen:extract':
        await this.handleExtract(msg);
        return true;
      case 'frozen:manifest:get':
        await this.handleManifestGet(msg);
        return true;
      case 'frozen:load':
        await this.handleLoad(msg);
        return true;
      case 'frozen:verify':
        await this.handleVerify(msg);
        return true;
      case 'frozen:remove':
        await this.handleRemove(msg);
        return true;
      case 'frozen:status':
        await this.handleStatus(msg);
        return true;
      default:
        return false;
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────

  private loadConfig(): FrozenProjectConfig | null {
    return this.deps.configStore.get<FrozenProjectConfig>(CONFIG_KEY) ?? null;
  }

  private handleConfigGet(msg: InboundRequest): void {
    const config = this.loadConfig();
    const response = buildResponse(this.deps, msg, 'frozen:config:get:response', {
      config,
      sasDir: this.resolveSasDir(config),
      datasetDir: this.resolveDatasetDir(config),
    });
    this.deps.broker.postToWebview(response);
  }

  private handleConfigSave(msg: InboundRequest): void {
    const parsed = validatePayload(
      frozenConfigSavePayloadSchema,
      msg,
      'frozen:config:save:error',
      this.deps,
    );
    if (!parsed) return;
    this.deps.configStore.set(CONFIG_KEY, parsed.config, FROZEN_CATEGORY);
    const response = buildResponse(this.deps, msg, 'frozen:config:save:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
  }

  // ── Paths (sas is OUTSIDE the repo by construction) ────────────────────

  /** Default sas root: `~/.sandforge-sas` (home — never the workspace repo). */
  private resolveSasDir(config: FrozenProjectConfig | null): string {
    return config?.sasDir ?? path.join(os.homedir(), '.sandforge-sas');
  }

  private resolveDatasetDir(config: FrozenProjectConfig | null): string {
    return config?.datasetDir ?? path.join(this.resolveSasDir(config), 'dataset');
  }

  // ── Engine wiring ──────────────────────────────────────────────────────

  /** Read `{{TOKEN}}` values from the sas (absent file → no tokens). */
  private async loadTokens(sasDir: string, guard: SasPathGuard): Promise<Record<string, string>> {
    if (!(await pathExists(path.join(sasDir, TOKENS_FILE_NAME)))) {
      return {};
    }
    return loadTokensFromSas(sasDir, TOKENS_FILE_NAME, guard);
  }

  /** Forge discovery service, wired on the same connection helper as Forge. */
  private buildDiscoveryService(): GraphDiscoveryService {
    const timeouts = new TimeoutManager(30_000);
    return new GraphDiscoveryService({
      describeObject: async (orgId, objectApiName) => {
        const cacheKey = `${orgId}::${objectApiName}`;
        const cached = this.describeCache.get(cacheKey);
        if (cached) return cached;
        const formatted = await timeouts.withTimeout(
          `frozen:describe:${objectApiName}`,
          async () => {
            const conn = await getJsforceConnection(
              orgId,
              this.deps.orgRegistry,
              this.deps.orgManager,
            );
            const meta = await conn.describe(objectApiName);
            return {
              name: meta.name,
              fields: meta.fields.map((f) => ({
                name: f.name,
                type: f.type,
                referenceTo: f.referenceTo ?? [],
                relationshipName: f.relationshipName ?? null,
                isMasterDetail: f.cascadeDelete === true,
                nillable: f.nillable !== false,
              })),
              childRelationships: (meta.childRelationships ?? []).map((cr) => ({
                childSObject: cr.childSObject,
                field: cr.field,
                relationshipName: cr.relationshipName ?? cr.field,
                isCascadeDelete: cr.cascadeDelete === true,
              })),
            };
          },
          30_000,
        );
        this.describeCache.set(cacheKey, formatted);
        return formatted;
      },
      queryCount: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const result = await conn.query(soql);
        return result.totalSize;
      },
      detectPII: (fields) => {
        const detector = this.deps.infraServices?.piiDetector;
        if (!detector) return [];
        const result = detector.detectPII(
          'unknown',
          fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type })),
        );
        return result.piiFields.map((p) => p.fieldApiName);
      },
      describeGlobal: (orgId) => this.describeGlobal(orgId),
    });
  }

  /** The objects of an org and the key prefix of each, described once and kept. */
  private async describeGlobal(
    orgId: string,
  ): Promise<Array<{ name: string; keyPrefix: string | null }>> {
    const cached = this.describeGlobalCache.get(orgId);
    if (cached) return cached;
    const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
    const r = await conn.describeGlobal();
    const formatted = r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
    this.describeGlobalCache.set(orgId, formatted);
    return formatted;
  }

  /**
   * The key prefix of each object of an org, by object: which object an id
   * belongs to, for the extractor. The describe discovery already asked for.
   */
  private async keyPrefixes(orgId: string): Promise<ReadonlyMap<string, string>> {
    const prefixes = new Map<string, string>();
    for (const { name, keyPrefix } of await this.describeGlobal(orgId)) {
      if (keyPrefix) prefixes.set(name, keyPrefix);
    }
    return prefixes;
  }

  /**
   * Discovery config for a root object.
   *
   * The record id only picks the root object: discovery walks the schema and
   * counts org-wide, so the graph is the same for every root of one object and
   * each run discovers it once.
   */
  private discoveryConfig(sourceOrgId: string, rootRecordId: string): ForgeConfig {
    return {
      inputMode: 'record',
      recordId: rootRecordId,
      depth: 'full',
      sourceOrgId,
      // Discovery is read-only; the target org id is irrelevant to the BFS
      // but required by the ForgeConfig shape.
      targetOrgId: sourceOrgId,
      anonymizePII: false,
      // An object with no record in the whole org has none in any dossier,
      // and reading it costs a query per dossier measured. Measured against a
      // real org, an Opportunity reached 400 objects of which 69 held any.
      skipEmpty: true,
      batchSize: 'auto',
    };
  }

  /** The discovery options of a run: the configured object cap. */
  private discoveryOptions(config: FrozenProjectConfig): { maxNodes: number } {
    return { maxNodes: config.maxNodes ?? DEFAULT_MAX_NODES };
  }

  /** Per-object field describes for the extractor's scope-aware queries. */
  private async describeScopableFields(
    orgId: string,
    objectApiName: string,
  ): Promise<ScopableField[]> {
    const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
    const meta = await conn.describe(objectApiName);
    return meta.fields.map((f) => ({
      name: f.name,
      type: f.type,
      referenceTo: f.referenceTo ?? [],
      // Which lookups are required: the extractor fetches the parents they
      // name when scope did not reach them, and knows no other way.
      nillable: f.nillable !== false,
    }));
  }

  /**
   * The reference-id mapping of the sas, bound to the org the target answers
   * as now (its `Organization.Id`).
   *
   * A refreshed sandbox keeps its registered id and answers with a new one.
   * The mapping is written with that id and read against it, so the records
   * of the org the sandbox was are never taken for records of the org it is.
   * When the org cannot say, the store is bound to nothing and judges nothing.
   *
   * The store asks on first use rather than here: a load reaches its mapping
   * only once the entry guards have passed, and a production org refused by
   * the tier guard must not have been read before the refusal.
   */
  private mappingStoreFor(
    sasDir: string,
    targetOrgId: string,
    guard: SasPathGuard,
  ): SasReferenceIdMappingStore {
    const organizationId = async (): Promise<string | undefined> => {
      try {
        const [row] = await this.buildTargetOrgAccess().query(
          targetOrgId,
          'SELECT Id FROM Organization',
        );
        return typeof row?.Id === 'string' ? row.Id : undefined;
      } catch (err: unknown) {
        this.deps.log(`[WARN] frozen: the target did not say which org it is: ${String(err)}`);
        return undefined;
      }
    };
    return new SasReferenceIdMappingStore(sasDir, { orgId: targetOrgId, organizationId, guard });
  }

  /**
   * Target-org access adapter over jsforce (query / describe / UI API).
   * The UI API `picklist-values` call is the ONLY source that sees
   * RecordType assignment gaps.
   */
  private buildTargetOrgAccess(): TargetOrgAccess {
    return {
      query: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        return queryAll(conn, soql);
      },
      count: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        return (await conn.query(soql)).totalSize;
      },
      describe: async (orgId, objectApiName) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const meta = await conn.describe(objectApiName);
        return {
          name: meta.name,
          // What the load reads to leave out an object the target takes no
          // insert of, instead of sending its records to be refused.
          createable: meta.createable,
          fields: meta.fields.map((f) => ({
            name: f.name,
            type: f.type,
            createable: f.createable ?? false,
            nillable: f.nillable ?? true,
            defaultedOnCreate: f.defaultedOnCreate ?? false,
            referenceTo: f.referenceTo ?? [],
            restrictedPicklist: f.restrictedPicklist ?? false,
            picklistValues: (f.picklistValues ?? []).map((p) => ({
              value: p.value,
              active: p.active ?? true,
            })),
          })),
          // The REST describe carries each record type's developerName;
          // jsforce's type for it leaves the field out.
          recordTypeInfos: (meta.recordTypeInfos ?? []).flatMap((rt) => {
            const developerName = (rt as typeof rt & { developerName?: string }).developerName;
            return developerName
              ? [{ developerName, recordTypeId: rt.recordTypeId, available: rt.available }]
              : [];
          }),
        };
      },
      picklistValues: async (orgId, objectApiName, recordTypeId, fieldApiName) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const res = await conn.request<{ values?: Array<{ value: string }> }>(
          `/services/data/v${conn.version}/ui-api/object-info/${objectApiName}/picklist-values/${recordTypeId}/${fieldApiName}`,
        );
        return (res.values ?? []).map((v) => v.value);
      },
    };
  }

  /** Map the project config to the engine's FrozenLoadConfig. */
  private toLoadConfig(config: FrozenProjectConfig): FrozenLoadConfig {
    return {
      protectedOrgIds: config.protectedOrgIds,
      identityKeys: config.identityKeys,
      undeletableObjects: config.undeletableObjects,
      requiredLookupPlaceholders: config.requiredLookupPlaceholders,
      requiredFieldDefaults: config.requiredFieldDefaults,
      picklistRules: config.picklistRules,
      defaultPicklistRule: config.defaultPicklistRule,
      duplicateErrorPatterns: config.duplicateErrorPatterns,
      rootObjectApiName: config.rootObject,
    };
  }

  /**
   * Read the frozen artifacts written by FrozenDatasetWriter back into an
   * engine FrozenDataset. Throws an actionable error when nothing was frozen.
   */
  private async readFrozenDataset(
    datasetDir: string,
    guard: SasPathGuard,
  ): Promise<{ dataset: FrozenDataset; manifest: FrozenManifest }> {
    const dir = guard.assertOutsideRepo(datasetDir);
    const manifestPath = guard.assertOutsideRepo(path.join(dir, 'manifest.json'));
    if (!(await pathExists(manifestPath))) {
      throw new Error(
        `No frozen dataset found at ${dir} — run a selection (frozen:select) then an ` +
          'extraction (frozen:extract) first.',
      );
    }
    const manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));

    const objects: FrozenObjectData[] = [];
    const dataDir = guard.assertOutsideRepo(path.join(dir, 'data'));
    if (await pathExists(dataDir)) {
      for (const file of (await fs.readdir(dataDir)).sort()) {
        if (!file.endsWith('.json')) continue;
        const filePath = guard.assertOutsideRepo(path.join(dataDir, file));
        const payload = JSON.parse(await fs.readFile(filePath, 'utf8')) as FrozenObjectData;
        objects.push({ objectApiName: payload.objectApiName, records: payload.records });
      }
    }

    const readOptional = async <T>(name: string, fallback: T): Promise<T> => {
      const filePath = guard.assertOutsideRepo(path.join(dir, name));
      if (!(await pathExists(filePath))) return fallback;
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
    };
    const recordTypes = await readOptional<Record<string, FrozenRecordTypeRef[]>>(
      'record-types.json',
      {},
    );
    const personContactSidecar = await readOptional<PersonContactLink[]>(
      'personcontact-sidecar.json',
      [],
    );
    const platformRecords = await readOptional<{ standardPricebook?: string }>(
      PLATFORM_RECORDS_FILE_NAME,
      {},
    );

    return {
      dataset: {
        datasetVersion: manifest.version,
        objects,
        recordTypes,
        personContactSidecar,
        ...(platformRecords.standardPricebook
          ? { standardPricebook: platformRecords.standardPricebook }
          : {}),
      },
      manifest,
    };
  }

  /** Classify an engine error into an actionable bridge error code. */
  private errorCodeFor(err: unknown, fallback: string): string {
    if (err instanceof LoadGuardError) return 'GUARD_REFUSED';
    if (err instanceof InsideRepoPathError) return 'SAS_PATH_REFUSED';
    if (err instanceof MissingSaltError) return 'SALT_MISSING';
    if (err instanceof VolumetryBudgetExceededError) return 'BUDGET_EXCEEDED';
    if (err instanceof LoadConfigError) return 'LOAD_CONFIG';
    if (err instanceof TimeoutError) return 'TIMEOUT';
    return fallback;
  }

  /** Load the saved config or emit the actionable CONFIG_MISSING error. */
  private requireConfig(msg: InboundRequest, errorType: string): FrozenProjectConfig | null {
    const config = this.loadConfig();
    if (!config) {
      sendHandlerError(
        this.deps,
        msg.type,
        errorType,
        msg,
        new Error(
          'No frozen dataset configuration saved — save the project configuration first ' +
            '(frozen:config:save: coverage axes, root object, budget, load rules).',
        ),
        { code: 'CONFIG_MISSING' },
      );
      return null;
    }
    return config;
  }

  // ── frozen:select ──────────────────────────────────────────────────────

  private async handleSelect(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenSelectPayloadSchema,
      msg,
      'frozen:select:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:select:error');
    if (!config) return;

    const operationId = `frozen-select-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'frozen', 'Running coverage-matrix selection');

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const query = (soql: string) => queryAll(conn, soql);
      const tokens = await this.loadTokens(sasDir, guard);
      const discovery = this.buildDiscoveryService();
      const discoveryOptions = this.discoveryOptions(config);
      const extractor = new FrozenDatasetExtractor({
        query,
        describeFields: (objectApiName) =>
          this.describeScopableFields(parsed.sourceOrgId, objectApiName),
        keyPrefixes: () => this.keyPrefixes(parsed.sourceOrgId),
      });
      // One graph for the run: it is the root object's, whichever root asks.
      let graphOnce: Promise<ForgeGraph> | undefined;
      const graphFor = (rootRecordId: string): Promise<ForgeGraph> =>
        (graphOnce ??= discovery
          .discover(this.discoveryConfig(parsed.sourceOrgId, rootRecordId), discoveryOptions)
          .then((graph) => withoutExcluded(graph, config.excludedObjects)));
      // Volumetry = real extraction-scope footprint: the probe runs the
      // scope-aware extraction over the retained roots and counts per object.
      // Bounded by the configured budget (default 2 500 records).
      const measureVolumetry = async (rootRecordIds: string[]): Promise<Record<string, number>> => {
        if (rootRecordIds.length === 0) return {};
        const graph = await graphFor(rootRecordIds[0]);
        const extracted = await extractor.extract({
          graph,
          rootObject: config.rootObject,
          rootRecordIds,
          asOf: new Date().toISOString(),
          sasDir,
          excludedFields: config.excludedFields,
          // By name as well: an object discovery never reached has no node
          // to leave out, and the extraction would fetch it past the cap.
          excludedObjects: config.excludedObjects,
          tokens,
          guard,
        });
        const measured: Record<string, number> = {};
        for (const objectData of extracted.objects) {
          measured[objectData.objectApiName] = objectData.records.length;
        }
        return measured;
      };
      // Each candidate is judged on its own records, measured the same way.
      const checkHealth = new ScopedDossierHealthChecker(
        measureVolumetry,
        config.expectedObjects ?? [],
      );

      const selector = new CoverageMatrixSelector({ query, checkHealth, measureVolumetry });
      const result = await new TimeoutManager(SELECT_TIMEOUT_MS).withTimeout('frozen:select', () =>
        selector.select({
          rootObject: config.rootObject,
          axes: config.axes,
          edgeCases: config.edgeCases,
          budgetMaxRecords: config.budgetMaxRecords,
          candidatesPerCombination: config.candidatesPerCombination,
          tokens,
        }),
      );

      const selectionPath = await writeSelectionToSas(sasDir, result, guard);
      // A discovery that failed has already said so through every candidate
      // it turned away; the summary just carries no graph.
      const graph = graphOnce ? await graphOnce.catch(() => undefined) : undefined;
      const response = buildResponse(this.deps, msg, 'frozen:select:response', {
        selection: toSelectionSummary(
          result,
          selectionPath,
          graph ? graphCoverage(graph, discoveryOptions.maxNodes) : undefined,
        ),
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, {
        roots: result.roots.length,
        total: result.volumetry.total,
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:select', 'frozen:select:error', msg, err, {
        code: this.errorCodeFor(err, 'SELECT_ERROR'),
        retryable: err instanceof TimeoutError,
      });
    }
  }

  // ── frozen:extract ─────────────────────────────────────────────────────

  private async handleExtract(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenExtractPayloadSchema,
      msg,
      'frozen:extract:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:extract:error');
    if (!config) return;

    const operationId = `frozen-extract-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'frozen', 'Extracting + pseudonymizing dataset');

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const datasetDir = guard.assertOutsideRepo(this.resolveDatasetDir(config));
      // The salt comes from the environment ONLY — MissingSaltError is
      // actionable (never invent a second salt: determinism would be lost).
      const pseudonymizer = DeterministicPseudonymizer.fromEnv();

      if (!(await pathExists(path.join(sasDir, SELECTION_FILE_NAME)))) {
        sendHandlerError(
          this.deps,
          'frozen:extract',
          'frozen:extract:error',
          msg,
          new Error(
            `No selection found in ${sasDir} — run the coverage-matrix selection first ` +
              '(frozen:select).',
          ),
          { code: 'SELECTION_MISSING' },
        );
        return;
      }
      const selection = await readSelectionFromSas(sasDir, guard);
      const rootRecordIds = selection.roots.map((r) => r.rootRecordId);
      if (rootRecordIds.length === 0) {
        sendHandlerError(
          this.deps,
          'frozen:extract',
          'frozen:extract:error',
          msg,
          new Error(
            'The last selection kept no root: every combination was uncovered, and the ' +
              'selection says why for each. Adjust the axes or the expected objects, then ' +
              'run the selection again.',
          ),
          { code: 'SELECTION_EMPTY' },
        );
        return;
      }
      const tokens = await this.loadTokens(sasDir, guard);
      const rulesPath = config.rulesFilePath ?? path.join(sasDir, DEFAULT_RULES_FILE_NAME);
      if (!(await pathExists(rulesPath))) {
        throw new LoadConfigError(
          `Pseudonymization rules file not found at ${rulesPath} — it is the source of truth ` +
            '(object.field → generator). Create it, or set rulesFilePath in the configuration.',
        );
      }
      const rules = parsePseudonymRules(JSON.parse(await fs.readFile(rulesPath, 'utf8')));

      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const discovery = this.buildDiscoveryService();
      const discoveryOptions = this.discoveryOptions(config);
      const graph = withoutExcluded(
        await discovery.discover(
          this.discoveryConfig(parsed.sourceOrgId, rootRecordIds[0]),
          discoveryOptions,
        ),
        config.excludedObjects,
      );
      const extractor = new FrozenDatasetExtractor({
        query: (soql) => queryAll(conn, soql),
        describeFields: (objectApiName) =>
          this.describeScopableFields(parsed.sourceOrgId, objectApiName),
        keyPrefixes: () => this.keyPrefixes(parsed.sourceOrgId),
      });

      const author = parsed.author ?? 'sandforge';
      const datasetVersion = config.datasetVersion ?? DEFAULT_DATASET_VERSION;

      const { extracted, frozen, report } = await new TimeoutManager(
        EXTRACT_TIMEOUT_MS,
      ).withTimeout('frozen:extract', async () => {
        const extracted = await extractor.extract({
          graph,
          rootObject: config.rootObject,
          rootRecordIds,
          asOf: new Date().toISOString(),
          sasDir,
          excludedFields: config.excludedFields,
          excludedObjects: config.excludedObjects,
          tokens,
          guard,
        });
        const frozen = new FrozenDatasetAnonymizer().anonymize({
          extracted,
          rules,
          pseudonymizer,
          datasetVersion,
        });
        const report = new NonReidentificationControl().run(extracted, frozen, rules, { author });
        return { extracted, frozen, report };
      });

      // The 4-point gate result is ALWAYS surfaced (PASS or FAIL).
      const controlMsg = buildResponse(this.deps, msg, 'frozen:control:result', {
        report: sanitizeControlReport(report),
      });
      this.deps.broker.postToWebview(controlMsg);

      if (!report.passed) {
        // A FAIL means nothing is written, hence nothing versioned.
        sendHandlerError(
          this.deps,
          'frozen:extract',
          'frozen:extract:error',
          msg,
          new Error(
            'Non-reidentification control FAILED — nothing was written. Fix the rules file ' +
              'and re-run the extraction (see frozen:control:result for the failing checks).',
          ),
          { code: 'CONTROL_FAILED' },
        );
        return;
      }

      // What the dataset holds — not what was read: an object left out for
      // its files is named in the coverage, not counted as frozen.
      const measured: Record<string, number> = {};
      for (const objectData of frozen.objects) {
        measured[objectData.objectApiName] = objectData.records.length;
      }
      const org = this.deps.orgManager.getOrg(parsed.sourceOrgId);
      const manifest = buildFrozenManifest({
        version: datasetVersion,
        source: {
          orgId: parsed.sourceOrgId,
          orgAlias: org?.alias,
          decisionDate: selection.selectedAt,
        },
        saltFingerprint: pseudonymizer.saltFingerprint,
        rulesVersion: rules.rulesVersion,
        volumetry: {
          budgetMax: selection.volumetry.budgetMax,
          measured,
          measuredAt: new Date().toISOString(),
        },
        nonReidentification: report,
        author,
        coverage: {
          ...graphCoverage(graph, discoveryOptions.maxNodes),
          unboundedObjects: extracted.unboundedObjects,
          filesLeftOut: frozen.filesLeftOut ?? [],
          // What the dataset does not hold because no load could write it: a
          // tracked change, and what cannot go in without one.
          ...((extracted.leftToThePlatform ?? []).length > 0
            ? { leftToThePlatform: leftToThePlatformCoverage(extracted.leftToThePlatform ?? []) }
            : {}),
          // What it holds and cannot load as it is, for an object the
          // configuration leaves out.
          ...(extracted.exclusionCosts ? { exclusionCosts: extracted.exclusionCosts } : {}),
        },
      });

      const writeResult = await new FrozenDatasetWriter(guard).write(
        datasetDir,
        frozen,
        manifest,
        report,
      );
      const response = buildResponse(this.deps, msg, 'frozen:extract:response', {
        datasetDir: writeResult.dir,
        files: writeResult.files,
        recordCount: datasetRecordCount(frozen),
        manifest: toManifestInfo(manifest),
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, {
        records: datasetRecordCount(frozen),
        version: manifest.version,
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:extract', 'frozen:extract:error', msg, err, {
        code: this.errorCodeFor(err, 'EXTRACT_ERROR'),
        retryable: err instanceof TimeoutError,
      });
    }
  }

  // ── frozen:manifest:get ────────────────────────────────────────────────

  private async handleManifestGet(msg: InboundRequest): Promise<void> {
    const config = this.loadConfig();
    const datasetDir = this.resolveDatasetDir(config);
    let manifest: FrozenManifestInfo | null = null;
    try {
      const guard = new SasPathGuard();
      const manifestPath = guard.assertOutsideRepo(path.join(datasetDir, 'manifest.json'));
      if (await pathExists(manifestPath)) {
        manifest = toManifestInfo(
          parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8'))),
        );
      }
    } catch (err: unknown) {
      logger.warn(`frozen:manifest:get — unreadable manifest: ${String(err)}`);
    }
    const response = buildResponse(this.deps, msg, 'frozen:manifest:get:response', {
      manifest,
      datasetDir,
    });
    this.deps.broker.postToWebview(response);
  }

  // ── frozen:load ────────────────────────────────────────────────────────

  private async handleLoad(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(frozenLoadPayloadSchema, msg, 'frozen:load:error', this.deps);
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:load:error');
    if (!config) return;
    const productionGuard = this.deps.infraServices?.productionGuard;
    if (!productionGuard) {
      // No run was minted: the request's id stands in, as for a guard refusal.
      recordWriteRun(this.deps, {
        action: 'frozen_load',
        module: 'frozen',
        operationId: msg.id,
        orgId: parsed.targetOrgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      sendHandlerError(
        this.deps,
        'frozen:load',
        'frozen:load:error',
        msg,
        new Error(PRODUCTION_GUARD_MISSING.message),
        { code: PRODUCTION_GUARD_MISSING.code },
      );
      return;
    }

    const operationId = `frozen-load-${this.deps.nextId()}`;
    const description = parsed.pilot ? 'Pilot load (one root folder)' : 'Loading frozen dataset';
    sendOperationStarted(this.deps, operationId, 'frozen', description);
    // Listed in Live Operations while it runs, where Cancel reaches the
    // registry's controller below, as a Sync or a Seed run is.
    this.liveTracker?.register(operationId, 'frozen', description);
    /** Whether the load's end was posted: the verification chained after it cannot post another. */
    let ended = false;

    // A throwaway `new AbortController()` was handed to BulkDataWriter, so its
    // signal could never fire and the load was never registered —
    // execution:abort answered "Operation not found" and the write continued.
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    this.registry?.register(operationId, 'frozen', description, tracked, abortController);

    // Throttle load progress events to ~10/s (same rationale as forge).
    const throttledProgress = throttle((event: FrozenLoadProgressEvent) => {
      const progressMsg = buildResponse(this.deps, msg, 'frozen:load:progress', { ...event });
      this.deps.broker.postToWebview(progressMsg);
      // The loader counts its progress in phases, not in records: the list
      // shows its share done and its step, and no record count.
      if (!ended) {
        this.liveTracker?.updateProgress(operationId, event.progress, 0, 0, event.message);
      }
    }, 100);

    /** The most telling of the guard's decisions, one per DML batch. */
    let guardDecision: GuardDecision | undefined;
    /** Whether a batch went through: a refusal after one no longer stopped a run that wrote nothing. */
    let batchLetThrough = false;
    /** The load is recorded once: the verification chained after it can still fail. */
    let recorded = false;
    /** What the dataset is called in its lineage, once its manifest is read. */
    let datasetLabel: string | undefined;
    const recordLoad = (
      outcome: AuditOutcome,
      objects?: AuditObjectCounts[],
      carried?: Record<string, number>,
    ): void => {
      if (recorded) return;
      recorded = true;
      recordWriteRun(this.deps, {
        action: 'frozen_load',
        module: 'frozen',
        operationId,
        orgId: parsed.targetOrgId,
        outcome,
        guard: guardDecision,
        objects,
        source: { origin: 'dataset', label: datasetLabel },
        carried,
      });
    };

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const datasetDir = guard.assertOutsideRepo(this.resolveDatasetDir(config));
      const { dataset, manifest } = await this.readFrozenDataset(datasetDir, guard);
      datasetLabel = manifest.version;

      const orgAccess = this.buildTargetOrgAccess();
      const conn = await getJsforceConnection(
        parsed.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const robustnessConfig = robustnessConfigOf(this.deps);
      const bulkManager = bulkManagerOf(this.deps);
      const writerStoppedBy = (signal: AbortSignal | undefined): BulkDataWriter =>
        new BulkDataWriter({
          connection: conn,
          bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
          bulkManager,
          retryConfig: robustnessConfig.retry,
          ...(signal ? { signal } : {}),
          onProgress: () => undefined,
          log: (message) => this.deps.log(message),
        });
      const bulkWriter = writerStoppedBy(abortController.signal);
      // When no mock detection is configured the guard is explicitly
      // disabled (status surfaces mockDetectionConfigured=false) — the
      // remediation is always a config deploy, never a DML on the source.
      const mockDetector = config.mockDetection
        ? new CustomMetadataCalloutMockDetector(orgAccess, config.mockDetection)
        : { areCalloutsMocked: async (): Promise<boolean> => true };
      const mappingStore = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      const targetClock = removalOrg(conn, 'frozen:load');

      const loader = new FrozenDatasetLoader({
        orgAccess,
        writer: createBulkDmlWriter(bulkWriter),
        // The statuses a reload's purge set to Draft are given back on its
        // way out, whatever stopped it: through the writer above, the cancel
        // that stopped the reload would stop that write too.
        restoringWriter: createBulkDmlWriter(writerStoppedBy(undefined)),
        guard: productionGuard,
        mockDetector,
        recordTypeResolver: new TargetRecordTypeIdResolver(orgAccess),
        mappingStore,
        config: this.toLoadConfig(config),
        sasGuard: guard,
        // The target's clock, read as the removal of a load reads it: what a
        // reload judges the records of a load the target did not date by.
        serverTime: () => targetClock.serverTime(),
      });

      const targetOrg = this.deps.orgManager.getOrg(parsed.targetOrgId);
      const report = await loader.load({
        orgId: parsed.targetOrgId,
        orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
        dataset,
        manifest,
        sasDir,
        reload: parsed.reload,
        pilot: parsed.pilot ? {} : undefined,
        onProgress: (event) => throttledProgress(event),
        onGuardDecision: (decision) => {
          guardDecision = strongerDecision(guardDecision, decision);
          if (decision === 'allowed' || decision === 'confirmed') batchLetThrough = true;
        },
        // The controller the registry aborts: the load stops before its next
        // write, where it used to run to its end.
        signal: abortController.signal,
      });
      throttledProgress.flush();
      recordLoad(
        frozenOutcome(report),
        frozenAuditObjects(report),
        await frozenCarried(dataset, mappingStore),
      );

      const lastRun: FrozenLastRun = {
        contractPath: report.contractPath,
        datasetDir,
        manifestPath: path.join(datasetDir, 'manifest.json'),
        targetOrgId: parsed.targetOrgId,
        status: report.status,
        at: new Date().toISOString(),
      };
      this.deps.configStore.set(LAST_RUN_KEY, lastRun, FROZEN_CATEGORY);

      const response = buildResponse(this.deps, msg, 'frozen:load:response', {
        report: toLoadReportInfo(report),
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { status: report.status });
      ended = true;
      this.liveTracker?.complete(operationId);

      // Chained post-load verification — read-only.
      await this.runVerification(msg, {
        orgId: parsed.targetOrgId,
        contractPath: report.contractPath,
        manifestPath: lastRun.manifestPath,
        dataset,
        mappingStore,
        config,
        onProgress: throttledProgress,
      });
      settle();
    } catch (err: unknown) {
      throttledProgress.flush();
      if (err instanceof FrozenLoadCancelledError) {
        // Ended the way a cancelled Sync or Seed ends: recorded with what it
        // wrote, aborted in the registry — already, when the cancel came
        // through it — and posted as a completion that says so. The page
        // hears it on the load's error channel, which settles its request.
        recordLoad(cancelledFrozenOutcome(err.written), frozenAuditObjects(err.written));
        this.registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
        sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, err, {
          code: 'LOAD_CANCELLED',
        });
        settle();
        return;
      }
      // Stopped when the guard refused the first batch it was asked about:
      // nothing was written. After a batch went through, the load failed —
      // recorded with what it wrote, when it says, which its mapping names;
      // the code is the one of what it failed on.
      const stopped =
        (guardDecision === 'refused' || guardDecision === 'declined') && !batchLetThrough;
      const failed = err instanceof FrozenLoadFailedError ? err : undefined;
      const cause = failed ? failed.cause : err;
      recordLoad(
        stopped ? 'stopped' : 'failure',
        failed ? frozenAuditObjects(failed.written) : undefined,
      );
      sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, err, {
        code: this.errorCodeFor(cause, 'LOAD_ERROR'),
        retryable: cause instanceof TimeoutError,
      });
      // The load's end, as every write run posts it: with the error alone,
      // the recent operations and the side panel showed a failed load running
      // for the rest of the session.
      if (!ended) {
        sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
        this.liveTracker?.fail(operationId, extractErrorMessage(err));
      }
      settle(err);
    }
  }

  // ── frozen:verify ──────────────────────────────────────────────────────

  private async handleVerify(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenVerifyPayloadSchema,
      msg,
      'frozen:verify:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:verify:error');
    if (!config) return;
    const lastRun = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    if (!lastRun) {
      sendHandlerError(
        this.deps,
        'frozen:verify',
        'frozen:verify:error',
        msg,
        new Error('No load run recorded — run a load (frozen:load) before verifying.'),
        { code: 'NO_LOAD' },
      );
      return;
    }

    const throttledProgress = throttle((event: FrozenLoadProgressEvent) => {
      const progressMsg = buildResponse(this.deps, msg, 'frozen:load:progress', { ...event });
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const mappingStore = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      // Verified against a sandbox refreshed since the load, every record
      // would read as missing, and the verdict would blame the load.
      if (await mappingStore.isStale()) {
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            'The target org was refreshed after the last load: the records that load wrote are gone. Load the dataset again, then verify.',
          ),
          { code: 'TARGET_REFRESHED' },
        );
        return;
      }
      // Its records went: every one would read as missing, and the verdict
      // would blame the load.
      const last = await mappingStore.recorded();
      const removed = last?.removal;
      if (removed) {
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            `The records the last load created were removed on ${removed.removedAt}. Load the dataset again, then verify.`,
          ),
          { code: 'LOAD_REMOVED' },
        );
        return;
      }
      if (!last) {
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            'The sas holds no mapping of the last load: nothing names the records to verify. Load the dataset again, then verify.',
          ),
          { code: 'NO_LOAD' },
        );
        return;
      }
      // The records the mapping names are counted against the contract of the
      // load that wrote them, or not at all. A load that stopped part way
      // keeps its mapping and writes no contract: verified after it, its
      // records were judged by the contract of the load before, and the
      // verdict was written into the manifest.
      if (!contractCountsLoad(readCountingContract(guard, lastRun.contractPath), last)) {
        // The last load's contract is in the sas it wrote to. With `sasDir`
        // set to another since, the mapping read is that one's, and the
        // refusal blamed a load that had stopped part way.
        const sasChanged = lastRun.contractPath !== countingContractPath(guard, sasDir);
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            sasChanged
              ? `The sas directory changed since the last load: its counting contract is in ${path.dirname(lastRun.contractPath)}, and the mapping read is the one in ${sasDir}. Set sasDir back to the sas the load wrote to, or load the dataset again, then verify.`
              : 'The last load stopped part way — it was cancelled, or failed once it had written — and wrote no counting contract: the one in the sas counts an earlier load, and would judge this one by it. Load the dataset again, then verify.',
          ),
          { code: sasChanged ? 'SAS_CHANGED' : 'LOAD_STOPPED' },
        );
        return;
      }
      const { dataset } = await this.readFrozenDataset(lastRun.datasetDir, guard);
      await this.runVerification(msg, {
        orgId: parsed.targetOrgId,
        contractPath: lastRun.contractPath,
        manifestPath: lastRun.manifestPath,
        dataset,
        mappingStore,
        config,
        onProgress: throttledProgress,
      });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:verify', 'frozen:verify:error', msg, err, {
        code: this.errorCodeFor(err, 'VERIFY_ERROR'),
        retryable: err instanceof TimeoutError,
      });
    }
  }

  /** Shared verification runner (chained after load + standalone verify). */
  private async runVerification(
    msg: InboundRequest,
    args: {
      orgId: string;
      contractPath: string;
      manifestPath: string;
      dataset: FrozenDataset;
      mappingStore: SasReferenceIdMappingStore;
      config: FrozenProjectConfig;
      onProgress: (event: FrozenLoadProgressEvent) => void;
    },
  ): Promise<void> {
    try {
      const verifier = new PostLoadVerifier({
        orgAccess: this.buildTargetOrgAccess(),
        sasGuard: new SasPathGuard(),
      });
      const mapping = await args.mappingStore.load();
      const verdict = await verifier.verify({
        orgId: args.orgId,
        contractPath: args.contractPath,
        dataset: args.dataset,
        mapping,
        mandatoryLookups: args.config.mandatoryLookups,
        presenceKeys: args.config.presenceKeys,
        manifestPath: args.manifestPath,
        author: 'sandforge',
        onProgress: args.onProgress,
      });
      this.deps.configStore.set(
        LAST_VERIFY_KEY,
        { status: verdict.status, measuredAt: verdict.measuredAt },
        FROZEN_CATEGORY,
      );
      const response = buildResponse(this.deps, msg, 'frozen:verify:result', { verdict });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:verify', 'frozen:verify:error', msg, err, {
        code: this.errorCodeFor(err, 'VERIFY_ERROR'),
        retryable: err instanceof TimeoutError,
      });
    }
  }

  // ── frozen:remove ──────────────────────────────────────────────────────

  /**
   * Remove from its target org the records the last load created, as the sas
   * mapping names them — never what the request names: the request says which
   * load, the mapping says what it created, and nothing it linked or reused
   * goes. Once the last load's records went, or when it created none, the
   * load removed is the newest one before it whose records the loads after it
   * left in the org: see {@link loadToRemove}.
   *
   * Refused before anything is read from the org when no load wrote a mapping,
   * when the mapping holds another load than the one confirmed, predates loads
   * keeping what they created, was removed already, holds nothing created, or
   * is being removed now. Then Production Guard judges the delete — a
   * production org is refused, a missing guard refuses too — the target is
   * asked whether it is still the org the load wrote to, and Forge's removal
   * runs: children before their parents, what records staying in the org
   * depend on kept, what changed since the load kept unless included. It runs
   * on the registry and in Live Operations, where Cancel stops it before its
   * next call to the org. The audit trail records it whatever the outcome; the
   * mapping forgets the records that went, keeps what the removal left on the
   * others for the next one, and is marked once records went, so the removal
   * is not offered twice.
   */
  private async handleRemove(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenRemovePayloadSchema,
      msg,
      'frozen:remove:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:remove:error');
    if (!config) return;
    const refuse = (message: string, code: string): void => this.refuseRemove(msg, message, code);

    let store: SasReferenceIdMappingStore;
    let load: RecordedLoad | undefined;
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      store = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      load = loadToRemove(await store.recordedLoads());
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, err, {
        code: this.errorCodeFor(err, 'REMOVE_ERROR'),
      });
      return;
    }
    if (!load) {
      refuse('No load was recorded in this sas: there is nothing to remove.', 'NO_LOAD');
      return;
    }
    if (load.orgId !== parsed.targetOrgId || load.endedAt !== parsed.loadedAt) {
      refuse(
        'Another load was recorded since this one was shown, and nothing was removed: check what a removal takes now, then confirm it again.',
        'LOAD_CHANGED',
      );
      return;
    }
    if (!load.created) {
      refuse(
        'This load was recorded before loads kept what they created: its records cannot be told from the ones it linked, and cannot be removed from here. A reload purges them, except those the load may have linked to.',
        'NOT_RECORDED',
      );
      return;
    }
    if (load.removal) {
      refuse(
        `The records this load created were already removed, on ${load.removal.removedAt}.`,
        'ALREADY_REMOVED',
      );
      return;
    }
    const plan = loadCreatedRecords(load);
    if (plan.length === 0) {
      refuse('This load created no record to remove.', 'NOTHING_TO_REMOVE');
      return;
    }
    const claim = store.filePath;
    if (this.removing.has(claim)) {
      refuse('The records of this load are being removed already.', 'DUPLICATE');
      return;
    }
    // Claimed before Production Guard is consulted: its confirmation waits on
    // a person, and a second click meanwhile would ask, and remove, twice.
    this.removing.add(claim);
    try {
      await this.removeLoad(msg, {
        store,
        load,
        plan,
        includeChanged: parsed.includeChanged === true,
      });
    } finally {
      this.removing.delete(claim);
    }
  }

  /** Answer a `frozen:remove` that removes nothing, on its error channel. */
  private refuseRemove(msg: InboundRequest, message: string, code: string): void {
    sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, new Error(message), {
      code,
    });
  }

  /**
   * The removal of {@link handleRemove} once the request is known to name a
   * load whose records can be removed: Production Guard, the target's
   * identity, then the removal itself.
   */
  private async removeLoad(
    msg: InboundRequest,
    args: {
      store: SasReferenceIdMappingStore;
      load: RecordedLoad;
      plan: ForgeRunObjectRecords[];
      includeChanged: boolean;
    },
  ): Promise<void> {
    const { store, load, plan, includeChanged } = args;
    const orgId = load.orgId;
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    const refuse = (message: string, code: string): void => this.refuseRemove(msg, message, code);

    // Production Guard judges the delete before anything is read, as on every
    // write path; without it nothing is deleted.
    const productionGuard = this.deps.infraServices?.productionGuard;
    if (!productionGuard) {
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId: msg.id,
        orgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      refuse(PRODUCTION_GUARD_MISSING.message, PRODUCTION_GUARD_MISSING.code);
      return;
    }
    const targetOrg = this.deps.orgManager.getOrg(orgId);
    const { check, decision } = await consultProductionGuard(productionGuard, {
      orgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation: 'delete',
      objectName: plan.map((o) => o.objectApiName).join(', '),
      recordCount: total,
      module: 'frozen',
    });
    if (decision === 'refused' || decision === 'declined') {
      // No removal started, so no operation id was minted: the request's stands in.
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId: msg.id,
        orgId,
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
          'frozen:remove',
          'frozen:remove:error',
          msg,
          new Error('Operation cancelled by user (production confirmation declined).'),
          { code: 'GUARD_DECLINED', retryable: true },
        );
      }
      return;
    }

    // Asked once the guard let the delete go: a production org it refused
    // must not have been read. A refreshed sandbox took the load's records
    // with it.
    let stale: boolean;
    try {
      stale = await store.isStale();
    } catch (err: unknown) {
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId: msg.id,
        orgId,
        outcome: 'failure',
        guard: decision,
      });
      sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, err, {
        code: this.errorCodeFor(err, 'REMOVE_ERROR'),
        retryable: true,
      });
      return;
    }
    if (stale) {
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId: msg.id,
        orgId,
        outcome: 'stopped',
        guard: decision,
        code: 'TARGET_REFRESHED',
      });
      refuse(
        'The target org was refreshed after the load: the records it created went with the refresh, and nothing is removed.',
        'TARGET_REFRESHED',
      );
      return;
    }

    const operationId = `frozen-remove-${this.deps.nextId()}`;
    const description = `Removing ${total} record(s) a Frozen load created`;
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    sendOperationStarted(this.deps, operationId, 'frozen', description);
    this.registry?.register(operationId, 'frozen', description, tracked, abortController);
    this.liveTracker?.register(operationId, 'frozen', description, total);
    /** What the removal failed on, so the registry lists it as failed. */
    let runError: unknown;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      // The load's span as the target dated its writes, read back as it
      // ended; this machine's clock is never compared with the org's. A load
      // the target did not date — recorded before loads kept it, or whose
      // dates could not all be read back — is dated by this machine's clock,
      // as it began and as it wrote its last record, read on the org's clock
      // as the removal starts.
      const span = load.writtenBetween;
      const began = load.startedAt === undefined ? Number.NaN : Date.parse(load.startedAt);
      const ended = Date.parse(load.endedAt);
      const outcome = await removeRunRecords(removalOrg(conn, 'frozen:remove'), plan, {
        ...(span
          ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
          : {
              ...(Number.isFinite(began) && Number.isFinite(ended)
                ? { runDurationMs: Math.max(0, ended - began) }
                : {}),
              ...(Number.isFinite(ended) ? { runRecordedAt: new Date(ended) } : {}),
            }),
        removalStamps: load.removalStamps,
        removalSpans: load.removalSpans,
        includeChanged,
        signal: abortController.signal,
        onProgress: (settled, of, objectApiName) => {
          const percent = Math.min(100, Math.round((settled / Math.max(of, 1)) * 100));
          sendOperationProgress(this.deps, operationId, percent, settled, of, objectApiName);
          // A removal cancelled from Live Operations finishes its call to the
          // org; the registry has recorded the stop and hears no more of it.
          if (!abortController.signal.aborted) this.registry?.updateProgress(operationId, percent);
          this.liveTracker?.updateProgress(operationId, percent, settled, of, objectApiName);
        },
      });
      const result: FrozenRemovalResult = {
        status: removalStatus(outcome.objects, outcome.cancelled),
        includeChanged,
        objects: outcome.objects,
        finishedAt: new Date().toISOString(),
      };

      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId,
        orgId,
        outcome: removalAuditOutcome(result),
        guard: decision,
        objects: removalAuditObjects(result.objects),
      });

      // The mapping forgets what went, keeps what the removal left on the
      // rest and when it ran, which the next removal reads as its doing, and
      // is marked once records went, or none was left to go. A removal
      // stopped part way, or one that deleted nothing, is offered again.
      const mark = removalMarks(result.status) ? removalMark(result) : undefined;
      if (
        outcome.gone.length > 0 ||
        Object.keys(outcome.stamps).length > 0 ||
        outcome.span ||
        mark
      ) {
        const kept = await store.recordRemoval(load.endedAt, {
          gone: outcome.gone,
          stamps: outcome.stamps,
          ...(outcome.span ? { span: outcome.span } : {}),
          ...(mark ? { mark } : {}),
        });
        if (!kept) {
          this.deps.log(
            '[WARN] frozen:remove: a load wrote its own mapping during the removal; the removal is not recorded in it',
          );
        }
      }

      const response = buildResponse(this.deps, msg, 'frozen:remove:response', {
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
          runError = new Error('No record this load created could be removed.');
          this.liveTracker?.fail(operationId, 'No record this load created could be removed.');
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
    } catch (error: unknown) {
      runError = error;
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId,
        orgId,
        outcome: 'failure',
        guard: decision,
      });
      sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, error, {
        code: 'REMOVE_ERROR',
        retryable: true,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      this.liveTracker?.fail(operationId, extractErrorMessage(error));
    } finally {
      settle(runError);
    }
  }

  // ── frozen:status ──────────────────────────────────────────────────────

  private async handleStatus(msg: InboundRequest): Promise<void> {
    const config = this.loadConfig();
    const sasDir = this.resolveSasDir(config);
    const datasetDir = this.resolveDatasetDir(config);

    let salt: FrozenStatusInfo['salt'] = { present: false };
    try {
      salt = { present: true, fingerprint: DeterministicPseudonymizer.fromEnv().saltFingerprint };
    } catch {
      salt = { present: false };
    }

    let selection: FrozenStatusInfo['selection'] = null;
    try {
      const guard = new SasPathGuard();
      if (await pathExists(path.join(sasDir, SELECTION_FILE_NAME))) {
        const persisted = await readSelectionFromSas(sasDir, guard);
        selection = {
          selectedAt: persisted.selectedAt,
          rootCount: persisted.roots.length,
          total: persisted.volumetry.total,
          budgetMax: persisted.volumetry.budgetMax,
        };
      }
    } catch {
      selection = null;
    }

    let manifest: FrozenManifestInfo | null = null;
    try {
      const guard = new SasPathGuard();
      const manifestPath = guard.assertOutsideRepo(path.join(datasetDir, 'manifest.json'));
      if (await pathExists(manifestPath)) {
        manifest = toManifestInfo(
          parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8'))),
        );
      }
    } catch {
      manifest = null;
    }

    const lastRun = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    const lastVerify = this.deps.configStore.get<{ status: string; measuredAt: string }>(
      LAST_VERIFY_KEY,
    );

    // Read as written: the page is told what a removal would take without
    // anything being asked of the org — of the load a removal takes next.
    let lastLoad: RecordedLoad | undefined;
    try {
      const guard = new SasPathGuard();
      lastLoad = loadToRemove(
        await new SasReferenceIdMappingStore(guard.assertOutsideRepo(sasDir), {
          guard,
        }).recordedLoads(),
      );
    } catch {
      lastLoad = undefined;
    }

    const status: FrozenStatusInfo = {
      configured: config !== null,
      sasDir,
      datasetDir,
      salt,
      mockDetectionConfigured: config?.mockDetection !== undefined,
      selection,
      manifest,
      lastLoad: lastRun
        ? { status: lastRun.status, orgId: lastRun.targetOrgId, at: lastRun.at }
        : null,
      lastVerify: lastVerify ?? null,
      ...(lastLoad ? { lastLoadRecords: loadRecordsInfo(lastLoad) } : {}),
    };
    const response = buildResponse(this.deps, msg, 'frozen:status:response', { status });
    this.deps.broker.postToWebview(response);
  }
}
