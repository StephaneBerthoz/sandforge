import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeConfig,
  FrozenControlReport,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenSelectionSummary,
  FrozenStatusInfo,
} from '@sandforge/shared';
import { orgTypeToGuardTier, RobustnessConfigSchema } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationCompleted,
} from './HandlerTypes.js';
import {
  validatePayload,
  frozenConfigSavePayloadSchema,
  frozenSelectPayloadSchema,
  frozenExtractPayloadSchema,
  frozenLoadPayloadSchema,
  frozenVerifyPayloadSchema,
} from '../validatePayload.js';
import { logger } from '../../logger.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { GraphDiscoveryService } from '../../modules/forge/GraphDiscoveryService.js';
import type { ScopableField } from '../../modules/forge/ScopedSoqlBuilder.js';
import {
  CoverageMatrixSelector,
  CustomMetadataCalloutMockDetector,
  DeterministicPseudonymizer,
  ForgeGraphHealthChecker,
  FrozenDatasetAnonymizer,
  FrozenDatasetExtractor,
  FrozenDatasetLoader,
  FrozenDatasetWriter,
  InsideRepoPathError,
  LoadConfigError,
  LoadGuardError,
  MissingSaltError,
  NonReidentificationControl,
  PostLoadVerifier,
  SELECTION_FILE_NAME,
  SasPathGuard,
  SasReferenceIdMappingStore,
  TargetRecordTypeIdResolver,
  VolumetryBudgetExceededError,
  buildFrozenManifest,
  createBulkDmlWriter,
  datasetRecordCount,
  loadTokensFromSas,
  parseManifest,
  parsePseudonymRules,
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
  };
}

/**
 * Map a selection result to its REDACTED bridge summary: source record IDs
 * stay in the sas — a real↔anonymized correspondence table never crosses
 * the bridge (spec §1).
 */
function toSelectionSummary(
  result: CoverageSelectionResult,
  selectionPath: string,
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
  };
}

/** Map an engine load report to its bridge DTO (alignedRecords dropped). */
function toLoadReportInfo(report: FrozenLoadReport): FrozenLoadReportInfo {
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
    purge: report.purge,
    mappingPath: report.mappingPath,
    contractPath: report.contractPath,
  };
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
  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
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
        this.handleManifestGet(msg);
        return true;
      case 'frozen:load':
        await this.handleLoad(msg);
        return true;
      case 'frozen:verify':
        await this.handleVerify(msg);
        return true;
      case 'frozen:status':
        this.handleStatus(msg);
        return true;
      default:
        return false;
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────

  private loadConfig(): FrozenProjectConfig | null {
    return this.deps.configStore.get<FrozenProjectConfig>(CONFIG_KEY) ?? null;
  }

  private handleConfigGet(msg: BaseMessage): void {
    const config = this.loadConfig();
    const response = buildResponse(this.deps, msg, 'frozen:config:get:response', {
      config,
      sasDir: this.resolveSasDir(config),
      datasetDir: this.resolveDatasetDir(config),
    });
    this.deps.broker.postToWebview(response);
  }

  private handleConfigSave(msg: BaseMessage): void {
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
  private loadTokens(sasDir: string, guard: SasPathGuard): Record<string, string> {
    if (!fs.existsSync(path.join(sasDir, TOKENS_FILE_NAME))) {
      return {};
    }
    return loadTokensFromSas(sasDir, TOKENS_FILE_NAME, guard);
  }

  /** Forge discovery service, wired on the same connection helper as Forge. */
  private buildDiscoveryService(): GraphDiscoveryService {
    const timeouts = new TimeoutManager(30_000);
    return new GraphDiscoveryService({
      describeObject: (orgId, objectApiName) =>
        timeouts.withTimeout(
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
        ),
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
      describeGlobal: async (orgId) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const r = await conn.describeGlobal();
        return r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
      },
    });
  }

  /** Record-scoped discovery config for one candidate root (same as Forge). */
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
      skipEmpty: false,
      batchSize: 'auto',
    };
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
    }));
  }

  /**
   * Target-org access adapter over jsforce (query / describe / UI API).
   * The UI API `picklist-values` call is the ONLY source that sees
   * RecordType assignment gaps (spec pitfall 2).
   */
  private buildTargetOrgAccess(): TargetOrgAccess {
    return {
      query: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        return queryAll(conn, soql);
      },
      describe: async (orgId, objectApiName) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const meta = await conn.describe(objectApiName);
        return {
          name: meta.name,
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
  private readFrozenDataset(
    datasetDir: string,
    guard: SasPathGuard,
  ): { dataset: FrozenDataset; manifest: FrozenManifest } {
    const dir = guard.assertOutsideRepo(datasetDir);
    const manifestPath = guard.assertOutsideRepo(path.join(dir, 'manifest.json'));
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `No frozen dataset found at ${dir} — run a selection (frozen:select) then an ` +
          'extraction (frozen:extract) first.',
      );
    }
    const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));

    const objects: FrozenObjectData[] = [];
    const dataDir = guard.assertOutsideRepo(path.join(dir, 'data'));
    if (fs.existsSync(dataDir)) {
      for (const file of fs.readdirSync(dataDir).sort()) {
        if (!file.endsWith('.json')) continue;
        const filePath = guard.assertOutsideRepo(path.join(dataDir, file));
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FrozenObjectData;
        objects.push({ objectApiName: payload.objectApiName, records: payload.records });
      }
    }

    const readOptional = <T>(name: string, fallback: T): T => {
      const filePath = guard.assertOutsideRepo(path.join(dir, name));
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    };
    const recordTypes = readOptional<Record<string, FrozenRecordTypeRef[]>>('record-types.json', {});
    const personContactSidecar = readOptional<PersonContactLink[]>('personcontact-sidecar.json', []);

    return {
      dataset: {
        datasetVersion: manifest.version,
        objects,
        recordTypes,
        personContactSidecar,
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
  private requireConfig(msg: BaseMessage, errorType: string): FrozenProjectConfig | null {
    const config = this.loadConfig();
    if (!config) {
      sendHandlerError(
        this.deps,
        msg.type,
        errorType,
        new Error(
          'No frozen dataset configuration saved — save the project configuration first ' +
            '(frozen:config:save: coverage axes, root object, budget, load rules).',
        ),
        'CONFIG_MISSING',
      );
      return null;
    }
    return config;
  }

  // ── frozen:select ──────────────────────────────────────────────────────

  private async handleSelect(msg: BaseMessage): Promise<void> {
    const parsed = validatePayload(frozenSelectPayloadSchema, msg, 'frozen:select:error', this.deps);
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
      const tokens = this.loadTokens(sasDir, guard);
      const discovery = this.buildDiscoveryService();
      const checkHealth = new ForgeGraphHealthChecker(discovery, parsed.sourceOrgId, {
        rootObject: config.rootObject,
        expectedObjects: config.expectedObjects ?? [],
      });
      const extractor = new FrozenDatasetExtractor({
        query,
        describeFields: (objectApiName) =>
          this.describeScopableFields(parsed.sourceOrgId, objectApiName),
      });
      // Volumetry = real extraction-scope footprint: the probe runs the
      // scope-aware extraction over the retained roots and counts per object.
      // Bounded by the configured budget (default 2 500 records).
      const measureVolumetry = async (rootRecordIds: string[]): Promise<Record<string, number>> => {
        const graph = await discovery.discover(
          this.discoveryConfig(parsed.sourceOrgId, rootRecordIds[0]),
        );
        const extracted = await extractor.extract({
          graph,
          rootObject: config.rootObject,
          rootRecordIds,
          asOf: new Date().toISOString(),
          sasDir,
          excludedFields: config.excludedFields,
          tokens,
          guard,
        });
        const measured: Record<string, number> = {};
        for (const objectData of extracted.objects) {
          measured[objectData.objectApiName] = objectData.records.length;
        }
        return measured;
      };

      const selector = new CoverageMatrixSelector({ query, checkHealth, measureVolumetry });
      const result = await new TimeoutManager(SELECT_TIMEOUT_MS).withTimeout(
        'frozen:select',
        () =>
          selector.select({
            rootObject: config.rootObject,
            axes: config.axes,
            edgeCases: config.edgeCases,
            budgetMaxRecords: config.budgetMaxRecords,
            candidatesPerCombination: config.candidatesPerCombination,
            tokens,
          }),
      );

      const selectionPath = writeSelectionToSas(sasDir, result, guard);
      const response = buildResponse(this.deps, msg, 'frozen:select:response', {
        selection: toSelectionSummary(result, selectionPath),
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, {
        roots: result.roots.length,
        total: result.volumetry.total,
      });
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'frozen:select',
        'frozen:select:error',
        err,
        this.errorCodeFor(err, 'SELECT_ERROR'),
        err instanceof TimeoutError,
      );
    }
  }

  // ── frozen:extract ─────────────────────────────────────────────────────

  private async handleExtract(msg: BaseMessage): Promise<void> {
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

      if (!fs.existsSync(path.join(sasDir, SELECTION_FILE_NAME))) {
        sendHandlerError(
          this.deps,
          'frozen:extract',
          'frozen:extract:error',
          new Error(
            `No selection found in ${sasDir} — run the coverage-matrix selection first ` +
              '(frozen:select).',
          ),
          'SELECTION_MISSING',
        );
        return;
      }
      const selection = readSelectionFromSas(sasDir, guard);
      const rootRecordIds = selection.roots.map((r) => r.rootRecordId);
      const tokens = this.loadTokens(sasDir, guard);
      const rulesPath = config.rulesFilePath ?? path.join(sasDir, DEFAULT_RULES_FILE_NAME);
      if (!fs.existsSync(rulesPath)) {
        throw new LoadConfigError(
          `Pseudonymization rules file not found at ${rulesPath} — it is the source of truth ` +
            '(object.field → generator). Create it, or set rulesFilePath in the configuration.',
        );
      }
      const rules = parsePseudonymRules(JSON.parse(fs.readFileSync(rulesPath, 'utf8')));

      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const discovery = this.buildDiscoveryService();
      const graph = await discovery.discover(
        this.discoveryConfig(parsed.sourceOrgId, rootRecordIds[0]),
      );
      const extractor = new FrozenDatasetExtractor({
        query: (soql) => queryAll(conn, soql),
        describeFields: (objectApiName) =>
          this.describeScopableFields(parsed.sourceOrgId, objectApiName),
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
        // Spec §5: a FAIL means nothing is written, hence nothing versioned.
        sendHandlerError(
          this.deps,
          'frozen:extract',
          'frozen:extract:error',
          new Error(
            'Non-reidentification control FAILED — nothing was written. Fix the rules file ' +
              'and re-run the extraction (see frozen:control:result for the failing checks).',
          ),
          'CONTROL_FAILED',
        );
        return;
      }

      const measured: Record<string, number> = {};
      for (const objectData of extracted.objects) {
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
      });

      const writeResult = new FrozenDatasetWriter(guard).write(datasetDir, frozen, manifest, report);
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
      sendHandlerError(
        this.deps,
        'frozen:extract',
        'frozen:extract:error',
        err,
        this.errorCodeFor(err, 'EXTRACT_ERROR'),
        err instanceof TimeoutError,
      );
    }
  }

  // ── frozen:manifest:get ────────────────────────────────────────────────

  private handleManifestGet(msg: BaseMessage): void {
    const config = this.loadConfig();
    const datasetDir = this.resolveDatasetDir(config);
    let manifest: FrozenManifestInfo | null = null;
    try {
      const guard = new SasPathGuard();
      const manifestPath = guard.assertOutsideRepo(path.join(datasetDir, 'manifest.json'));
      if (fs.existsSync(manifestPath)) {
        manifest = toManifestInfo(parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))));
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

  private async handleLoad(msg: BaseMessage): Promise<void> {
    const parsed = validatePayload(frozenLoadPayloadSchema, msg, 'frozen:load:error', this.deps);
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:load:error');
    if (!config) return;
    const productionGuard = this.deps.infraServices?.productionGuard;
    if (!productionGuard) {
      sendHandlerError(
        this.deps,
        'frozen:load',
        'frozen:load:error',
        new Error('Production Guard is not initialized — infrastructure services missing'),
        'NOT_INITIALIZED',
      );
      return;
    }

    const operationId = `frozen-load-${this.deps.nextId()}`;
    sendOperationStarted(
      this.deps,
      operationId,
      'frozen',
      parsed.pilot ? 'Pilot load (one root folder)' : 'Loading frozen dataset',
    );

    // Throttle load progress events to ~10/s (same rationale as forge).
    const throttledProgress = throttle((event: FrozenLoadProgressEvent) => {
      const progressMsg = buildResponse(this.deps, msg, 'frozen:load:progress', { ...event });
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const datasetDir = guard.assertOutsideRepo(this.resolveDatasetDir(config));
      const { dataset, manifest } = this.readFrozenDataset(datasetDir, guard);

      const orgAccess = this.buildTargetOrgAccess();
      const conn = await getJsforceConnection(
        parsed.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const robustnessConfig = RobustnessConfigSchema.parse(
        this.deps.configStore.get('robustness:config') ?? {},
      );
      const bulkWriter = new BulkDataWriter({
        connection: conn,
        bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
        bulkManager: new BulkApiManager(robustnessConfig.bulk.maxConcurrentJobs),
        retryConfig: robustnessConfig.retry,
        describeTimeoutMs: robustnessConfig.timeouts.describe,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        log: (message) => this.deps.log(message),
      });
      // When no mock detection is configured the guard is explicitly
      // disabled (status surfaces mockDetectionConfigured=false) — the
      // remediation is always a config deploy, never a DML on the source.
      const mockDetector = config.mockDetection
        ? new CustomMetadataCalloutMockDetector(orgAccess, config.mockDetection)
        : { areCalloutsMocked: async (): Promise<boolean> => true };
      const mappingStore = new SasReferenceIdMappingStore(sasDir, {
        orgId: parsed.targetOrgId,
        guard,
      });

      const loader = new FrozenDatasetLoader({
        orgAccess,
        writer: createBulkDmlWriter(bulkWriter),
        guard: productionGuard,
        mockDetector,
        recordTypeResolver: new TargetRecordTypeIdResolver(orgAccess),
        mappingStore,
        config: this.toLoadConfig(config),
        sasGuard: guard,
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
      });
      throttledProgress.flush();

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

      // Chained post-load verification (spec §7) — read-only.
      await this.runVerification(msg, {
        orgId: parsed.targetOrgId,
        contractPath: report.contractPath,
        manifestPath: lastRun.manifestPath,
        dataset,
        mappingStore,
        config,
        onProgress: throttledProgress,
      });
    } catch (err: unknown) {
      throttledProgress.flush();
      sendHandlerError(
        this.deps,
        'frozen:load',
        'frozen:load:error',
        err,
        this.errorCodeFor(err, 'LOAD_ERROR'),
        err instanceof TimeoutError,
      );
    }
  }

  // ── frozen:verify ──────────────────────────────────────────────────────

  private async handleVerify(msg: BaseMessage): Promise<void> {
    const parsed = validatePayload(frozenVerifyPayloadSchema, msg, 'frozen:verify:error', this.deps);
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:verify:error');
    if (!config) return;
    const lastRun = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    if (!lastRun) {
      sendHandlerError(
        this.deps,
        'frozen:verify',
        'frozen:verify:error',
        new Error('No load run recorded — run a load (frozen:load) before verifying.'),
        'NO_LOAD',
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
      const { dataset } = this.readFrozenDataset(lastRun.datasetDir, guard);
      const mappingStore = new SasReferenceIdMappingStore(sasDir, {
        orgId: parsed.targetOrgId,
        guard,
      });
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
      sendHandlerError(
        this.deps,
        'frozen:verify',
        'frozen:verify:error',
        err,
        this.errorCodeFor(err, 'VERIFY_ERROR'),
        err instanceof TimeoutError,
      );
    }
  }

  /** Shared verification runner (chained after load + standalone verify). */
  private async runVerification(
    msg: BaseMessage,
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
      sendHandlerError(
        this.deps,
        'frozen:verify',
        'frozen:verify:error',
        err,
        this.errorCodeFor(err, 'VERIFY_ERROR'),
        err instanceof TimeoutError,
      );
    }
  }

  // ── frozen:status ──────────────────────────────────────────────────────

  private handleStatus(msg: BaseMessage): void {
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
      if (fs.existsSync(path.join(sasDir, SELECTION_FILE_NAME))) {
        const persisted = readSelectionFromSas(sasDir, guard);
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
      if (fs.existsSync(manifestPath)) {
        manifest = toManifestInfo(parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))));
      }
    } catch {
      manifest = null;
    }

    const lastRun = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    const lastVerify = this.deps.configStore.get<{ status: string; measuredAt: string }>(
      LAST_VERIFY_KEY,
    );

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
    };
    const response = buildResponse(this.deps, msg, 'frozen:status:response', { status });
    this.deps.broker.postToWebview(response);
  }
}
