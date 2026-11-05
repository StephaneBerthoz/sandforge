import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AuditObjectCounts,
  AuditOutcome,
  ForgeAutomationWrite,
  ForgeConfig,
  ForgeGraph,
  ForgeRemovalSteps,
  ForgeSweepListing,
  ForgeSweepResult,
  FrozenControlReport,
  FrozenDiscoveryOrigin,
  FrozenGraphCoverage,
  FrozenLastVerifyInfo,
  FrozenLoadEmailsInfo,
  FrozenLoadRecordsInfo,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenRemovalPreview,
  FrozenReloadSweep,
  FrozenReloadSweepListing,
  FrozenRemovalResult,
  FrozenRulesFileInfo,
  FrozenSelectProgress,
  FrozenSelectionSummary,
  FrozenStatusInfo,
  ForgeRunObjectRecords,
  ForgeTargetAutomation,
  GuardDecision,
  MutedAutomation,
  MutePlan,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
} from '@sandforge/shared';
import {
  AUDIT_TRAIL_LIMIT,
  auditMutedOf,
  guardTierOf,
  removalStepsWithSweep,
  removalStepsWrites,
  stillRunningOf,
} from '@sandforge/shared';
import { ProductionGuard, withGivenAnswer } from '../../core/precheck/ProductionGuard.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import {
  consultProductionGuard,
  strongerDecision,
} from '../../core/precheck/consultProductionGuard.js';
import { AuditTrailStore, emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import {
  NOTHING_REMOVED,
  objectsRemovedOf,
  removalOrg,
  removeRunRecords,
  setBackToDraftOf,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../../modules/forge/ForgeRunRemoval.js';
import {
  listSweep,
  sweepAuditDetails,
  sweepAuditObjects,
  sweepAutomationOf,
  type SweepInput,
  type SweepTies,
} from '../../modules/forge/ForgeRunSweep.js';
import {
  otherRunsInSweep,
  removalBeganOf,
  removalSweepOf,
  sweepOrgOf,
  sweepRefusalCode,
  withoutPlatformCopies,
  type LocalRun,
  type OtherModuleRuns,
  type RemovalSweep,
} from './removalSweep.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import {
  isMuteRefusedError,
  muteForRun,
  muteOrgOf,
  type HeldMute,
  type MuteLeaseOptions,
  type RunMute,
} from '../../modules/forge/AutomationMuteLease.js';
import {
  CHECKPOINT_REFUSED,
  checkpointScopeStop,
  takeCheckpointFirst,
  readEmailLimits,
  type LimitsTransport,
} from '../../modules/forge/ForgeRunGate.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
} from '../../modules/forge/targetDeliverability.js';
import { runEmailsDetailsOf, runEmailsSaidOf } from '../../modules/forge/runEmailsSaid.js';
import {
  beforeRunFailedWords,
  type BeforeRunAsk,
  type BeforeRunCheckpoints,
  type BeforeRunOwn,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { seedWrittenBetween } from '../../modules/seed/seedRunSweep.js';
import {
  removalAuditObjects,
  removalAuditOutcome,
  removalMark,
  removalStatus,
  removalStatusWithSweep,
} from '../../modules/forge/removalOutcome.js';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import type {
  BackgroundOperationRegistry,
  PendingStart,
} from '../../core/engine/BackgroundOperationRegistry.js';
import {
  buildResponse,
  sendHandlerError,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  robustnessConfigOf,
  bulkManagerOf,
  ABORTED_BEFORE_START,
  PRODUCTION_GUARD_MISSING,
  undeletableAsker,
} from './HandlerTypes.js';
import { payloadText, WritingOrgs } from './writingOrgs.js';
import {
  validatePayload,
  frozenConfigSavePayloadSchema,
  frozenSelectPayloadSchema,
  frozenExtractPayloadSchema,
  frozenLoadPayloadSchema,
  frozenRemoveAutomationPayloadSchema,
  frozenRemovePayloadSchema,
  frozenRemovePreviewPayloadSchema,
  frozenRemoveSweepPayloadSchema,
  frozenRulesClearPayloadSchema,
  frozenVerifyPayloadSchema,
} from '../validatePayload.js';
import { logger } from '../../logger.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { PIIDetector, personalFieldsByApiName } from '../../core/precheck/PIIDetector.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import {
  DEFAULT_MAX_NODES,
  GraphDiscoveryService,
} from '../../modules/forge/GraphDiscoveryService.js';
import { holdsAPlace } from '../../modules/forge/GraphDiscoveryService.js';
import type {
  DiscoveryOptions,
  ObjectDescribe,
} from '../../modules/forge/GraphDiscoveryService.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import { readPicklistFieldValues } from '../../core/metadata/recordTypePicklists.js';
import type { ScopableField } from '../../modules/forge/ScopedSoqlBuilder.js';
import { queryAllPages } from '../../modules/forge/queryAllPages.js';
import {
  CoverageMatrixSelector,
  CustomMetadataCalloutMockDetector,
  DeterministicPseudonymizer,
  EMPTY_RULES_FILE,
  FrozenDatasetAnonymizer,
  FrozenDatasetExtractor,
  FrozenDatasetLoader,
  FrozenDatasetWriter,
  FrozenLoadCancelledError,
  FrozenLoadFailedError,
  InsideRepoPathError,
  LoadConfigError,
  LoadGuardError,
  LoadRecordsExceededError,
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
  keptWithoutARule,
  leftToThePlatformCoverage,
  loadCreatedRecords,
  loadRecordsInfo,
  loadRecordsKept,
  loadRecordsLeft,
  loadsSweptWith,
  loadToRemove,
  loadTokensFromSas,
  mappedOrgIds,
  parseManifest,
  parsePseudonymRules,
  readCountingContract,
  readDiscoveryFromSas,
  readSelectionFromSas,
  requiredFieldsLeftEmpty,
  rulesFileStateOf,
  schemaStampOf,
  serializePseudonymRules,
  whyNotReused,
  withFieldsCleared,
  withSchemaDefaults,
  writeDiscoveryToSas,
  writeSelectionToSas,
  type ControlViolation,
  type DiscoveringStep,
  type KeptDiscovery,
  type CoverageSelectionResult,
  type FrozenDataset,
  type FrozenDmlWriter,
  type FrozenLoadConfig,
  type FrozenLoadProgressEvent,
  type FrozenLoadReport,
  type FrozenManifest,
  type FrozenObjectData,
  type FrozenRecordTypeRef,
  type NonReidentificationReport,
  type PersonContactLink,
  type RecordedLoad,
  type RuleSchemaField,
  type TargetOrgAccess,
} from '../../modules/frozendataset/index.js';
import {
  commandLineSaltKeeper,
  type FrozenSaltKeeper,
} from '../../modules/frozendataset/FrozenSalt.js';
import {
  auditedLoadsOf,
  lastWriteOfLoad,
  otherSasRunsOf,
  sasMarkOf,
  type MarkedLoad,
} from '../../modules/frozendataset/otherSasLoads.js';
import { loadEmailsOf, type LoadEmails } from '../../modules/frozendataset/loadEmails.js';

/**
 * The writer of a preview: it writes nothing, and says so if a write ever
 * reaches it — a preview reads what the load reads before its first write,
 * and stops there.
 */
const PREVIEW_WRITER: FrozenDmlWriter = {
  insert: async () => {
    throw new Error('A preview writes nothing.');
  },
  update: async () => {
    throw new Error('A preview writes nothing.');
  },
  delete: async () => {
    throw new Error('A preview writes nothing.');
  },
};

/** Message types handled by FrozenDatasetHandler. */
const FROZEN_TYPES = new Set([
  'frozen:config:get',
  'frozen:config:save',
  'frozen:select',
  'frozen:extract',
  'frozen:manifest:get',
  'frozen:load',
  'frozen:load:preview',
  'frozen:verify',
  'frozen:remove',
  'frozen:remove:sweep',
  'frozen:remove:automation',
  'frozen:remove:preview',
  'frozen:status',
  'frozen:rules:clear',
  'frozen:rules:create',
]);

/**
 * The code a reload is refused with, before anything is written, when a
 * removal of the loads it replaces would leave records in the org.
 */
const REPLACE_LEAVES_RECORDS = 'REPLACE_LEAVES_RECORDS';

/** What a removal has found once it knows what it deletes, nothing deleted yet. */
export interface FrozenRemovalQuestion {
  /** What the target runs on what the removal and its sweep delete, or why it could not be read. */
  read: ForgeTargetAutomation | { unread: string };
  /** What each step of the removal writes, what the sweep deletes among its deletes. */
  steps: ForgeRemovalSteps;
  /** The mute asked for, planned from that read, nothing assigned yet. */
  mute: RunMute | undefined;
}

/** Why a removal goes no further, in the words and under the code its error carries. */
export interface FrozenRemovalStop {
  message: string;
  code: string;
}

/**
 * What the command line asks a removal, as the commands that take a run back
 * ask it: once the sweep has read what it takes and Production Guard answered,
 * before the lease, a person answering holding no permission set assigned, and
 * before the first delete. The panel's confirmation lists all this before the
 * org's name is typed; the sweep the command line sends does not read before
 * the removal does, so the question waits for it, on what both delete.
 */
export type FrozenRemovalAsker = (
  question: FrozenRemovalQuestion,
) => Promise<FrozenRemovalStop | undefined>;

/** A removal its asker stopped before its first delete. */
class RemovalStopped extends Error {
  constructor(readonly stop: FrozenRemovalStop) {
    super(stop.message);
    this.name = 'RemovalStopped';
  }
  get code(): string {
    return this.stop.code;
  }
}

/**
 * A load its gate on the emails stopped before its first write: past what the
 * target has left today (`FROZEN_EMAILS_EXCEEDED`), or delivered without the
 * accord (`EMAILS_NOT_ACCEPTED`), with what the gate found, for the panel to
 * say it.
 */
class LoadEmailsStop extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly emails: FrozenLoadEmailsInfo,
    /** The org the load was refused into, by its registered id. */
    readonly orgId: string,
  ) {
    super(message);
    this.name = 'LoadEmailsStop';
  }
}

/**
 * What each step of a load's removal writes: what it deletes — the platform's
 * copies of the load's lines on an object it never wrote among them —, what it
 * sets back to Draft first, and what its sweep deletes beside them.
 */
function removalStepsOfLoad(
  plan: readonly ForgeRunObjectRecords[],
  swept: readonly string[],
): ForgeRemovalSteps {
  const removed = [...new Set(plan.map((object) => object.objectApiName))];
  return removalStepsWithSweep(
    { setToDraft: setBackToDraftOf(removed), delete: objectsRemovedOf(removed) },
    swept,
  );
}

/**
 * Whether a sweep took all it was asked to and left nothing it found: no
 * record refused, kept as changed since, or still waiting, and nothing made
 * late or tied to nothing kept. A reload keeps the load it swept recorded
 * otherwise, for the next sweep of it.
 */
function sweepTookAll(result: ForgeSweepResult): boolean {
  return result.status === 'success' && (result.left ?? []).length === 0;
}

/** What a reload asked of the sweep of each load it replaces. */
interface ReloadSweepAsked {
  includeChanged: boolean;
  sweepLate: boolean;
  sweepUntied: boolean;
}

/**
 * Whether a load's gate on the emails found anything to say: something that
 * still runs sends one, or could not be read. Nothing is said otherwise, as a
 * seed says nothing of a run that sends none.
 */
function saysSomething(info: FrozenLoadEmailsInfo): boolean {
  return info.verdict !== 'nothingSends' || info.counted.length > 0 || info.uncounted !== undefined;
}

/** The sweep of a load swept with a reload or a removal, and how that run judges what it did. */
interface SweepOfALoad {
  loadedAt: string;
  sweep: RemovalSweep;
  judged?: (result: ForgeSweepResult) => ForgeSweepResult;
}

/**
 * A reload's sweep as the reload judges it. What it kept as changed since the
 * load it swept, not asked to include it, it was not asked to take, as what
 * came late is not: said kept, the load kept recorded for the next sweep —
 * which `includeChanged` lets take it — and no failure of the sweep. Counted
 * among what the sweep left, a task a user had edited since the load ended
 * that reload partial, then every reload after it, exit 3, with no reload
 * able to take it. Anything else left — refused, still waiting, a class
 * asked for and kept, a sweep that would not run — stands as it was.
 */
function reloadSweepJudged(result: ForgeSweepResult, asked: ReloadSweepAsked): ForgeSweepResult {
  if (asked.includeChanged || result.refusal !== undefined) return result;
  if (result.status !== 'partial' && result.status !== 'failure') return result;
  const onlyChanged = result.objects.every(
    (object) =>
      object.refused === 0 &&
      object.deleted + object.alreadyGone + object.keptChanged === object.found,
  );
  const classAskedAndLeft = (result.left ?? []).some(
    (left) =>
      (left.class === 'late' && asked.sweepLate) || (left.class === 'untied' && asked.sweepUntied),
  );
  const keptChanged = result.objects.some((object) => object.keptChanged > 0);
  return onlyChanged && !classAskedAndLeft && keptChanged
    ? { ...result, status: 'success' }
    : result;
}

/** ConfigStore category for all frozen-dataset data. */
const FROZEN_CATEGORY = 'frozen';

/** ConfigStore key of the per-project configuration. */
const CONFIG_KEY = 'frozen:config';

/** ConfigStore key of the last load run pointers, whichever org it went to (status). */
const LAST_RUN_KEY = 'frozen:lastRun';

/**
 * ConfigStore key of the last load run pointers of each target org, by its
 * registered id (verify). Kept for the last load alone, a load into another
 * org replaced the pointers of the first: its verification read the other
 * org's contract, and was refused.
 */
const LAST_RUNS_KEY = 'frozen:lastRuns';

/**
 * ConfigStore key of the last verification verdict, whichever org it was of,
 * as it was kept before each org kept its own: read to be moved to the org it
 * was of, then dropped.
 */
const LAST_VERIFY_KEY = 'frozen:lastVerify';

/**
 * ConfigStore key of the last verification verdict of each target org, by its
 * registered id. Kept as one verdict, a verification of one org replaced the
 * other's, and the page showed it beside whichever org was selected.
 */
const LAST_VERIFIES_KEY = 'frozen:lastVerifies';

/** Token file name inside the sas ({{TOKEN}} values for SOQL templates). */
const TOKENS_FILE_NAME = 'tokens.json';

/** Default rules file name when the config does not point at one. */
const DEFAULT_RULES_FILE_NAME = 'rules.json';

/**
 * No rules file where the extraction reads it. Its own code, and the path
 * beside the message, so the panel says it in the interface language and
 * points at the button that writes one: refused in raw English, a first
 * extraction stopped there with nothing on the page saying what to write.
 */
class RulesFileMissingError extends Error {
  constructor(
    readonly rulesPath: string,
    message: string,
  ) {
    super(message);
    this.name = 'RulesFileMissingError';
  }
}

/** Opens a file in an editor of the window. */
type OpenInEditor = (filePath: string) => Promise<void>;

/** The window's own editor, the VS Code API fetched on first use as the other adapters do. */
const openInVsCodeEditor: OpenInEditor = async (filePath) => {
  const vscode = await import('vscode');
  await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
};

/** Default dataset semver when the config does not declare one. */
const DEFAULT_DATASET_VERSION = '0.1.0';

/** Selection / extraction timeouts (long, but bounded — probes + full pull). */
const SELECT_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 15 * 60_000;

/**
 * How long the describes of a graph kept in the sas are held once reused:
 * past the longest step, so an extraction finds them to its end. The next
 * step asks the org again whether its schema changed.
 */
const KEPT_DESCRIBE_TTL_MS = 30 * 60_000;

/** The graph a step reads, where it came from, and — discovered — how to keep it for the next step. */
interface StepGraph {
  /** The graph as discovery answered it, before the configuration's exclusions. */
  graph: ForgeGraph;
  origin: FrozenDiscoveryOrigin;
  /**
   * Keep the graph in the sas with the describes of its objects and of the
   * objects named, those the step read beside them. Absent for a graph
   * reused: it is kept already.
   */
  keep?: (described: Iterable<string>) => Promise<void>;
}

/** How long the read of what the target's flows create may take, for a sweep: as Forge's. */
const SWEEP_AUTOMATION_TIMEOUT_MS = 60_000;

/** How long listing what a sweep would take may take: the automation read, then one read per object. */
const SWEEP_LIST_TIMEOUT_MS = 120_000;

/** Violations per check sent to the webview (cap + see sanitizeViolationDetail). */
const MAX_VIOLATIONS_PER_CHECK = 50;

/** A verification's verdict as it is kept, its org by the key it is kept under. */
type FrozenLastVerify = Omit<FrozenLastVerifyInfo, 'orgId'>;

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
 * Post progress at most once per `delayMs`, save the line that ends a step —
 * an object written, a pass done, a check failed — which goes at once, after
 * the one held back, as Forge lets its terminal events through. The throttle
 * keeps only the last event it holds: an object's closing line went whenever
 * the next came within the interval, and the Load tab never listed it.
 */
function throttleProgress(
  post: (event: FrozenLoadProgressEvent) => void,
  delayMs: number,
): ((event: FrozenLoadProgressEvent) => void) & { flush: () => void } {
  const throttled = throttle(post, delayMs);
  const send = (event: FrozenLoadProgressEvent): void => {
    if (event.status === 'started') {
      throttled(event);
      return;
    }
    throttled.flush();
    post(event);
  };
  return Object.assign(send, { flush: throttled.flush });
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
    ...(result.stopped ? { stopped: result.stopped } : {}),
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
  // The objects that take a place under the cap: an empty table takes none,
  // and counted, it read as the cap raised.
  return {
    objects: graph.nodes.filter(holdsAPlace).length,
    truncated: graph.truncated === true,
    maxNodes,
  };
}

/** What a refused removal adds of the records a load created that no removal takes, if any. */
function keptByThePlatformNote(
  kept: ReadonlyArray<{ objectApiName: string; count: number }>,
): string {
  if (kept.length === 0) return '';
  const objects = kept.map(({ objectApiName, count }) => `${objectApiName} (${count})`).join(', ');
  return ` Kept in the org, the platform does not delete them: ${objects}.`;
}

/**
 * Why a removal of the load a request names takes nothing, or undefined when
 * it has records to take: no load recorded, another load since the one
 * shown, one recorded before loads kept what they created, or none of its
 * records left for a removal. Asked by the removal and by its preview alike,
 * before either reads the org.
 */
function removalRefusalOf(
  load: RecordedLoad | undefined,
  request: { targetOrgId: string; loadedAt: string },
): { message: string; code: string } | undefined {
  if (!load) {
    return {
      message: 'No load into this org was recorded in this sas: there is nothing to remove.',
      code: 'NO_LOAD',
    };
  }
  if (load.orgId !== request.targetOrgId || load.endedAt !== request.loadedAt) {
    return {
      message:
        'Another load was recorded since this one was shown, and nothing was removed: check what a removal takes now, then confirm it again.',
      code: 'LOAD_CHANGED',
    };
  }
  if (!load.created) {
    return {
      message:
        'This load was recorded before loads kept what they created: its records cannot be told from the ones it linked, and cannot be removed from here, nor replaced by a reload, which would delete what someone changed since.',
      code: 'NOT_RECORDED',
    };
  }
  if (loadRecordsLeft(load).length > 0) return undefined;
  // What the load created that no removal takes is said, not counted as
  // nothing created: see `loadRecordsKept`.
  const kept = keptByThePlatformNote(loadRecordsKept(load));
  if (load.removal) {
    return {
      message: `The records this load created were already removed, on ${load.removal.removedAt}.${kept}`,
      code: 'ALREADY_REMOVED',
    };
  }
  return kept
    ? { message: `This load created no record a removal takes.${kept}`, code: 'NOTHING_TO_REMOVE' }
    : { message: 'This load created no record to remove.', code: 'NOTHING_TO_REMOVE' };
}

/**
 * The load's span as the target dated its writes, read back as it ended,
 * and what earlier removals left on its records: what its removal, and the
 * preview of one, read it by. This machine's clock is never compared with
 * the org's. A load the target did not date — recorded before loads kept it,
 * or whose dates could not all be read back — is dated by this machine's
 * clock, as it began and as it wrote its last record, read on the org's clock
 * as the removal starts.
 */
function removalSpanOf(
  load: RecordedLoad,
): Pick<
  RunRemovalOptions,
  | 'runStartedAt'
  | 'runEndedAt'
  | 'runDurationMs'
  | 'runRecordedAt'
  | 'removalStamps'
  | 'removalSpans'
  | 'runUserId'
> {
  const span = load.writtenBetween;
  const began = load.startedAt === undefined ? Number.NaN : Date.parse(load.startedAt);
  const ended = Date.parse(load.endedAt);
  return {
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
    ...(load.runUserId ? { runUserId: load.runUserId } : {}),
  };
}

/**
 * What a removal of the loads a reload replaces would leave in the org, per
 * object, from the preview of each: the records it keeps as changed since,
 * those of an object the user may not delete, those it cannot see and those
 * it could not read. Empty when it would take them all.
 */
function leftByRemovalOf(
  previews: ReadonlyArray<Pick<FrozenRemovalPreview, 'objects'>>,
): Array<{ objectApiName: string; left: number; why: string[] }> {
  const byObject = new Map<string, { left: number; why: Set<string> }>();
  for (const { objects } of previews) {
    for (const object of objects) {
      const parts = [
        object.keptChanged > 0 ? `${object.keptChanged} changed since the load` : '',
        object.undeletable > 0 ? `${object.undeletable} the user may not delete` : '',
        object.notVisible > 0 ? `${object.notVisible} out of the user's sight` : '',
        object.unread > 0 ? `${object.unread} that could not be read` : '',
      ].filter(Boolean);
      const left = object.keptChanged + object.undeletable + object.notVisible + object.unread;
      if (left === 0) continue;
      const entry = byObject.get(object.objectApiName) ?? { left: 0, why: new Set<string>() };
      entry.left += left;
      for (const part of parts) entry.why.add(part);
      byObject.set(object.objectApiName, entry);
    }
  }
  return [...byObject].map(([objectApiName, { left, why }]) => ({
    objectApiName,
    left,
    why: [...why],
  }));
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
    ...(report.heldForExcludedParents
      ? { heldForExcludedParents: report.heldForExcludedParents }
      : {}),
    ...(report.recordTypesGiven ? { recordTypesGiven: report.recordTypesGiven } : {}),
    ...(report.runUserId ? { runUserId: report.runUserId } : {}),
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
 * since it did not write the whole dataset. Stopped when the cancel came
 * before it wrote anything and the org had refused nothing — no record
 * created, none purged — as a run stopped before its first write is recorded;
 * read as partial, a load that wrote nothing said it had put part of the
 * dataset in the target. Cancelled otherwise, its counts saying what it wrote
 * and what the org refused by then: recorded as partial, or failed when the
 * org had refused all it was sent, it read as a load the org cut short.
 */
function cancelledFrozenOutcome(
  written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>,
): AuditOutcome {
  const refused =
    written.perObject.reduce((sum, o) => sum + o.failed.length, 0) + written.purge.failures.length;
  return recordsWritten(written) === 0 && refused === 0 ? 'stopped' : 'cancelled';
}

/**
 * The records a load wrote to its target: those it inserted, the placeholders
 * it created for them, and those a reload purged or deactivated. A checkpoint
 * taken before a load that wrote none is deleted again.
 */
function recordsWritten(
  written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>,
): number {
  const total = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    written.perObject.reduce((sum, o) => sum + o.inserted, 0) +
    written.placeholders.length +
    total(written.purge.deleted) +
    total(written.purge.deactivated)
  );
}

/**
 * The mark of a load of this handler as a checkpoint taken before it names
 * its own: the id of its request, under Frozen Dataset's name, so that no
 * request id of another page's run can ever pass for it.
 */
function frozenMarkOf(requestId: string): string {
  return `frozen:${requestId}`;
}

/** The writes a load makes of the objects of its dataset: it inserts them, then updates what it inserted. */
const LOAD_WRITES = (_objectApiName: string, write: string): boolean =>
  write === 'insert' || write === 'update';

/**
 * A load stopped for the checkpoint it was asked to take first, before its
 * lease and its first write: refused at its scope or at its take, the take
 * failed (`CHECKPOINT_REFUSED`), or the load's Cancel came while it read
 * (`LOAD_CANCELLED`). Nothing was written.
 */
class CheckpointFirstStop extends Error {
  constructor(
    readonly code: typeof CHECKPOINT_REFUSED | 'LOAD_CANCELLED',
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointFirstStop';
  }
}

/**
 * What a load did per object, for the audit trail: records inserted and the
 * placeholders created for them, records a reload deactivated or purged, and
 * the ones the org refused — duplicates it skipped among them, since the org
 * would not take them. Of an object a cancel stopped while it was written, or
 * the load failed at, the records kept from the target, which were neither.
 * Of the records inserted, those the org took only once written again without
 * the fields it refused them on, which lack a value the dataset holds.
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
    if (object.notInserted) counts.notSent = (counts.notSent ?? 0) + object.notInserted;
    if (object.writtenWithoutFields) {
      counts.writtenWithoutFields =
        (counts.writtenWithoutFields ?? 0) + object.writtenWithoutFields.rows;
    }
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
 *  - the pseudonymization salt comes from its keeper (`FrozenSalt`): the
 *    editor's secret storage, `SANDFORGE_FROZEN_SALT` where it is set, a file
 *    on the command line — its SHA-256 fingerprint is the only salt-derived
 *    value ever surfaced;
 *  - source record IDs never cross the bridge (selection summary redacted);
 *  - control violation details are redacted/truncated (residual values).
 */
export class FrozenDatasetHandler implements DomainHandler {
  private registry?: BackgroundOperationRegistry;
  /** What the Monitor's Live Operations panel lists, with a Cancel for each run. */
  private liveTracker?: LiveOperationTracker;
  /**
   * Reads what the target's flows create, for the sweep of a load's removal:
   * the handler's own reader, as Forge reads it, unless another is set. It
   * was Forge's, handed over once Forge's composition had loaded: a sweep
   * asked before that, the Forge page never opened, said the automation was
   * not read.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };
  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;
  /** What keeps the pseudonymization salt between extractions: see {@link setSaltKeeper}. */
  private saltKeeper: FrozenSaltKeeper = commandLineSaltKeeper();
  /** Where the rules file `frozen:rules:create` writes is opened: see {@link setRulesEditor}. */
  private openInEditor: OpenInEditor = openInVsCodeEditor;
  /** The runs of the other modules on an org, for a sweep's untied refusal: see {@link setOtherModuleRuns}. */
  private otherModuleRuns: OtherModuleRuns = () => Promise.resolve([]);

  /** The mappings whose load is being removed, by file: one removal at a time each. */
  private readonly removing = new Set<string>();

  /**
   * The orgs a load's removal or its sweep writes to now, from its request
   * until it ends: a checkpoint of one is refused meanwhile.
   */
  private readonly writing = new WritingOrgs();

  /**
   * The loads under way, by the id of their request, each with the org it
   * writes to, from its request until it ends: a checkpoint of that org is
   * refused meanwhile — but the one a load takes of what it writes before
   * its first write, which names the load's own mark.
   */
  private readonly loading = new Map<string, string>();

  /**
   * What a load asked to take a checkpoint of what it writes before its first
   * write takes it through (`Checkpoint first`). Without it, such a load is
   * refused before its first write.
   */
  private beforeRunCheckpoints?: BeforeRunCheckpoints;

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
    // As many as a discovery describes — four per place under its cap, the
    // cap at most five hundred — so the extraction of every candidate finds
    // the describes the discovery made. Held to fifty, a discovery of a large
    // org pushed out its own first describes before the extraction asked.
    maxSize: 2_000,
    maxSizeBytes: 200 * 1024 * 1024,
    // Gone once their five minutes are up, read or not: kept until read, the
    // describes of a large org's discovery stayed for the life of the window.
    releaseExpired: true,
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

  /** Where `frozen:rules:create` opens the file it writes, in place of the window's editor. */
  setRulesEditor(open: OpenInEditor): void {
    this.openInEditor = open;
  }

  /** Inject the tracker the Monitor's Live Operations panel lists. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /** Inject what a load takes a checkpoint of what it writes before its first write through. */
  setBeforeRunCheckpoints(checkpoints: BeforeRunCheckpoints): void {
    this.beforeRunCheckpoints = checkpoints;
  }

  /**
   * Another reader of the target's automation than the handler's own: the
   * objects the target's flows create as a load's records are written, which
   * the sweep of a load's removal looks at.
   */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** Where and how a load that mutes keeps its lease, in place of the home directory's. */
  setMuteLeases(options: MuteLeaseOptions): void {
    this.muteLeases = options;
  }

  /** Where and how the mute leases are kept, when not the home directory's. */
  private muteLeases: MuteLeaseOptions = {};

  /**
   * What a removal is asked before its first delete, in place of the panel's
   * confirmation, which listed what it fires before the org's name was typed:
   * see {@link FrozenRemovalAsker}. None in the panel.
   */
  setRemovalAsker(asker: FrozenRemovalAsker): void {
    this.removalAsker = asker;
  }

  /** See {@link setRemovalAsker}. */
  private removalAsker: FrozenRemovalAsker | undefined;

  /** The handler's own reader of the target's automation, as Forge reads it, off the activation path. */
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
   * Where the pseudonymization salt is kept: VS Code's secret storage in the
   * editor (`secretStorageSaltKeeper`), the environment or a file on the
   * command line. Until set, `SANDFORGE_FROZEN_SALT` alone.
   */
  setSaltKeeper(keeper: FrozenSaltKeeper): void {
    this.saltKeeper = keeper;
  }

  /**
   * Whether a load of this window, a load's removal or its sweep writes to
   * the registered org now: a checkpoint of it would hold its records half
   * written. `except` is the mark of a load a checkpoint is taken before: its
   * own does not count, and only its own.
   */
  isWritingTo(orgId: string, except?: string): boolean {
    if (this.writing.has(orgId)) return true;
    for (const [requestId, writesTo] of this.loading) {
      if (writesTo === orgId && (except === undefined || except !== frozenMarkOf(requestId))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run a load with the org its request names held as written to, under the
   * id of its request, until it settles, however it ends. A request that
   * names no org holds none.
   */
  private async loadingDuring(msg: InboundRequest, run: () => Promise<void>): Promise<void> {
    const orgId = payloadText(msg, 'targetOrgId');
    if (orgId === undefined) return run();
    this.loading.set(msg.id, orgId);
    try {
      await run();
    } finally {
      this.loading.delete(msg.id);
    }
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
        await this.loadingDuring(msg, () => this.handleLoad(msg));
        return true;
      case 'frozen:load:preview':
        await this.handlePreview(msg);
        return true;
      case 'frozen:verify':
        await this.handleVerify(msg);
        return true;
      case 'frozen:remove':
        await this.writing.during(payloadText(msg, 'targetOrgId'), () => this.handleRemove(msg));
        return true;
      case 'frozen:remove:sweep':
        await this.writing.during(payloadText(msg, 'targetOrgId'), () =>
          this.handleRemoveSweep(msg),
        );
        return true;
      case 'frozen:remove:automation':
        await this.handleRemoveAutomation(msg);
        return true;
      case 'frozen:remove:preview':
        await this.handleRemovePreview(msg);
        return true;
      case 'frozen:status':
        await this.handleStatus(msg);
        return true;
      case 'frozen:rules:clear':
        await this.handleRulesClear(msg);
        return true;
      case 'frozen:rules:create':
        await this.handleRulesCreate(msg);
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

  /**
   * The pseudonymization rules file, absolute: where the configuration
   * points, else `rules.json` in the sas. The extraction reads it and the
   * panel's "clear these" writes it, so both name the same file.
   */
  private resolveRulesPath(config: FrozenProjectConfig | null): string {
    return path.resolve(
      config?.rulesFilePath ?? path.join(this.resolveSasDir(config), DEFAULT_RULES_FILE_NAME),
    );
  }

  /** The rules file where the extraction reads it, as `frozen:status` says it. */
  private async rulesFileInfo(config: FrozenProjectConfig | null): Promise<FrozenRulesFileInfo> {
    const rulesPath = this.resolveRulesPath(config);
    let text: string | null = null;
    try {
      text = (await pathExists(rulesPath)) ? await fs.readFile(rulesPath, 'utf8') : null;
    } catch (err: unknown) {
      return { path: rulesPath, found: true, invalid: extractErrorMessage(err) };
    }
    return { path: rulesPath, ...rulesFileStateOf(text) };
  }

  // ── Engine wiring ──────────────────────────────────────────────────────

  /** Read `{{TOKEN}}` values from the sas (absent file → no tokens). */
  private async loadTokens(sasDir: string, guard: SasPathGuard): Promise<Record<string, string>> {
    if (!(await pathExists(path.join(sasDir, TOKENS_FILE_NAME)))) {
      return {};
    }
    return loadTokensFromSas(sasDir, TOKENS_FILE_NAME, guard);
  }

  /**
   * An object of an org as discovery reads it, described once and kept: the
   * discovery and every extraction of a selection ask for the same objects.
   */
  private async describeObject(orgId: string, objectApiName: string): Promise<ObjectDescribe> {
    const cacheKey = `${orgId}::${objectApiName}`;
    const cached = this.describeCache.get(cacheKey);
    if (cached) return cached;
    const formatted = await new TimeoutManager(30_000).withTimeout(
      `frozen:describe:${objectApiName}`,
      async () => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const meta = await conn.describe(objectApiName);
        return {
          name: meta.name,
          fields: meta.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            referenceTo: f.referenceTo ?? [],
            relationshipName: f.relationshipName ?? null,
            isMasterDetail: f.cascadeDelete === true,
            nillable: f.nillable !== false,
            createable: f.createable !== false,
            updateable: f.updateable !== false,
            restrictedPicklist: f.restrictedPicklist === true,
            defaultedOnCreate: f.defaultedOnCreate === true,
            ...(f.compoundFieldName ? { compoundFieldName: f.compoundFieldName } : {}),
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
  }

  /** Forge discovery service, wired on the same connection helper as Forge. */
  private buildDiscoveryService(): GraphDiscoveryService {
    return new GraphDiscoveryService({
      describeObject: (orgId, objectApiName) => this.describeObject(orgId, objectApiName),
      queryCount: async (orgId, soql) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const result = await conn.query(soql);
        return result.totalSize;
      },
      // By API name and type, as Forge reads them: the detector's patterns
      // read the words of a label, and the API name handed to it as one hid
      // `Notification_Email__c` and `SMS_Number__c` from it.
      detectPII: (fields) => {
        const detector = this.deps.infraServices?.piiDetector;
        return detector ? personalFieldsByApiName(detector, fields) : [];
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

  /**
   * The graph a selection or an extraction reads: the one an earlier step
   * kept in the sas, when it is of the same org, root object and cap, less
   * than a day old, and the org says its schema did not change since — or a
   * discovery of its own, with why the kept one would not do.
   *
   * Each step of the command line is a process of its own, and the describes
   * a discovery makes went with it: run on the Developer Edition source, the
   * selection and the extraction after it sent four hundred requests each,
   * the same two hundred describes and counts twice. Reused, a graph costs
   * the one request that asks the org whether its schema changed since
   * (`If-Modified-Since` on its list of objects, which the org answers with
   * `304 Not Modified` when no object changed); and the describes kept with
   * it serve the step's reads.
   */
  private async graphOfStep(context: {
    step: DiscoveringStep;
    sourceOrgId: string;
    config: FrozenProjectConfig;
    sasDir: string;
    guard: SasPathGuard;
    rootRecordId: string;
    signal?: AbortSignal;
    onProgress?: DiscoveryOptions['onProgress'];
  }): Promise<StepGraph> {
    const { sourceOrgId, config, sasDir, guard } = context;
    const { maxNodes } = this.discoveryOptions(config);
    const wanted = { sourceOrgId, rootObject: config.rootObject, maxNodes };
    const read = await readDiscoveryFromSas(sasDir, guard);
    let reason: string;
    if ('kept' in read) {
      const kept = read.kept;
      const notReused =
        whyNotReused(kept, wanted) ?? (await this.schemaChangeSince(sourceOrgId, kept));
      if (notReused === undefined) {
        this.holdKeptDescribes(sourceOrgId, kept);
        return {
          graph: kept.graph,
          origin: { reusedFrom: kept.step, discoveredAt: kept.discoveredAt },
        };
      }
      reason = notReused;
    } else {
      reason = read.none;
    }

    // The org's clock as the discovery begins: what the next step asks the
    // org whether its schema changed since.
    let schemaStamp: string | undefined;
    try {
      const conn = await getJsforceConnection(
        sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      schemaStamp = schemaStampOf((await conn.soap.getServerTimestamp()).timestamp);
    } catch (err: unknown) {
      this.deps.log(`[WARN] frozen: the source did not give its clock: ${String(err)}`);
    }
    const graph = await this.buildDiscoveryService().discover(
      this.discoveryConfig(sourceOrgId, context.rootRecordId),
      {
        maxNodes,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.onProgress ? { onProgress: context.onProgress } : {}),
      },
    );
    const discoveredAt = new Date().toISOString();
    return {
      graph,
      origin: { rediscovered: reason },
      keep: async (described) => {
        const names = new Set([
          ...graph.nodes.filter((n) => n.included).map((n) => n.objectApiName),
          ...described,
        ]);
        const describes: Record<string, ObjectDescribe> = {};
        for (const name of names) {
          const held = this.describeCache.get(`${sourceOrgId}::${name}`);
          if (held) describes[name] = held;
        }
        await writeDiscoveryToSas(
          sasDir,
          {
            fileVersion: 1,
            ...wanted,
            step: context.step,
            discoveredAt,
            ...(schemaStamp ? { schemaStamp } : {}),
            graph,
            describes,
            objects: this.describeGlobalCache.get(sourceOrgId) ?? [],
          },
          guard,
        );
      },
    };
  }

  /**
   * Whether the source's schema changed since a kept graph was discovered:
   * `undefined` when the org says no object changed since its stamp, why the
   * graph is discovered again otherwise. Changed, what is held of the org is
   * dropped, and its list of objects, which the org sends with its answer,
   * held in its place.
   */
  private async schemaChangeSince(orgId: string, kept: KeptDiscovery): Promise<string | undefined> {
    if (!kept.schemaStamp) return 'the graph kept carries no stamp of the org';
    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const answer: unknown = await conn.request({
        method: 'GET',
        url: '/sobjects',
        headers: { 'If-Modified-Since': new Date(kept.schemaStamp).toUTCString() },
      });
      const sobjects =
        typeof answer === 'object' && answer !== null
          ? (answer as { sobjects?: unknown }).sobjects
          : undefined;
      // Not modified: the org answers with no body.
      if (!Array.isArray(sobjects)) return undefined;
      this.forgetOrg(orgId);
      this.describeGlobalCache.set(
        orgId,
        sobjects.flatMap((s: unknown) => {
          const { name, keyPrefix } = (s ?? {}) as { name?: unknown; keyPrefix?: unknown };
          return typeof name === 'string'
            ? [{ name, keyPrefix: typeof keyPrefix === 'string' ? keyPrefix : null }]
            : [];
        }),
      );
      return `the source's schema changed since the graph kept was discovered, on ${kept.discoveredAt}`;
    } catch (err: unknown) {
      return `the source could not say whether its schema changed: ${extractErrorMessage(err)}`;
    }
  }

  /** Hold the describes and the objects of a kept graph, for the reads of the step that reuses it. */
  private holdKeptDescribes(orgId: string, kept: KeptDiscovery): void {
    for (const [name, described] of Object.entries(kept.describes)) {
      this.describeCache.set(`${orgId}::${name}`, described, KEPT_DESCRIBE_TTL_MS);
    }
    if (kept.objects.length > 0) {
      this.describeGlobalCache.set(orgId, kept.objects, KEPT_DESCRIBE_TTL_MS);
    }
  }

  /**
   * Per-object field describes for the extractor's scope-aware queries, from
   * the describes discovery made and keeps.
   *
   * Each was asked of the org afresh: one describe per object per
   * extraction, and a selection extracts once per candidate and once more to
   * measure what it kept. Counted on an org shaped like a large one, half the
   * calls of a selection were describes of objects discovery had already
   * described.
   */
  private async describeScopableFields(
    orgId: string,
    objectApiName: string,
  ): Promise<ScopableField[]> {
    const described = await this.describeObject(orgId, objectApiName);
    return described.fields.map((f) => ({
      name: f.name,
      type: f.type,
      referenceTo: f.referenceTo,
      // Which lookups are required: the extractor fetches the parents they
      // name when scope did not reach them, and knows no other way.
      nillable: f.nillable !== false,
    }));
  }

  /**
   * The fields of each object the dataset holds, as the rules' defaults read
   * them, from the describes discovery made and keeps. An object the org will
   * not describe has none: its restricted picklists stay cleared, as with no
   * describe at all, and no required field of it is named.
   */
  private async ruleSchemaOf(
    orgId: string,
    objects: ReadonlyArray<{ objectApiName: string }>,
  ): Promise<Map<string, RuleSchemaField[]>> {
    const schema = new Map<string, RuleSchemaField[]>();
    for (const { objectApiName } of objects) {
      try {
        const described = await this.describeObject(orgId, objectApiName);
        schema.set(objectApiName, described.fields);
      } catch (err: unknown) {
        this.deps.log(
          `[WARN] frozen: ${objectApiName} could not be described for the rules: ${String(err)}`,
        );
      }
    }
    return schema;
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
            // What a flag given back to a relation the load linked to reads.
            updateable: f.updateable !== false,
            // What tells a default to give each record a value of its own.
            unique: f.unique === true,
            nameField: f.nameField === true,
          })),
          // The REST describe carries each record type's developerName and
          // whether it is active; jsforce's type for it leaves both out. The
          // rest tells what the target gives a record sent without one.
          recordTypeInfos: (meta.recordTypeInfos ?? []).flatMap((rt) => {
            const { developerName, active } = rt as typeof rt & {
              developerName?: string;
              active?: boolean;
            };
            return developerName
              ? [
                  {
                    developerName,
                    recordTypeId: rt.recordTypeId,
                    available: rt.available,
                    name: rt.name,
                    master: rt.master,
                    defaultRecordTypeMapping: rt.defaultRecordTypeMapping,
                    ...(active === undefined ? {} : { active }),
                  },
                ]
              : [];
          }),
        };
      },
      // The read Forge's record type check makes too, narrowed to one field.
      picklistValues: async (orgId, objectApiName, recordTypeId, fieldApiName) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        return readPicklistFieldValues(conn, objectApiName, recordTypeId, fieldApiName);
      },
      // Only the SOAP API tells it, as it tells a removal.
      userId: async (orgId) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        return (await conn.soap.getUserInfo()).userId;
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
      excludedObjects: config.excludedObjects,
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
    if (err instanceof RulesFileMissingError) return 'RULES_MISSING';
    if (err instanceof LoadGuardError) return 'GUARD_REFUSED';
    if (err instanceof InsideRepoPathError) return 'SAS_PATH_REFUSED';
    if (err instanceof MissingSaltError) return 'SALT_MISSING';
    if (err instanceof VolumetryBudgetExceededError) return 'BUDGET_EXCEEDED';
    if (err instanceof LoadConfigError) return 'LOAD_CONFIG';
    if (err instanceof LoadRecordsExceededError) return 'MAX_RECORDS';
    if (err instanceof TimeoutError) return 'TIMEOUT';
    return fallback;
  }

  /**
   * What an error names beside its message, for the panel to word it in the
   * interface language: the guard that refused a load and what it refused
   * (`guard`, `orgId`, `tier`), the rules file the extraction looked for
   * (`rulesPath`), the figures of a budget gone past (`total`, `budgetMax`,
   * `heaviest`), or what the configuration has to declare (`gaps`). Nothing
   * for any other error.
   */
  private errorDetailOf(err: unknown): Record<string, unknown> | undefined {
    if (err instanceof RulesFileMissingError) return { rulesPath: err.rulesPath };
    if (err instanceof LoadGuardError) return { guard: err.code, ...err.params };
    if (err instanceof VolumetryBudgetExceededError) {
      return { total: err.total, budgetMax: err.budgetMax, heaviest: err.heaviest };
    }
    if (err instanceof LoadConfigError && err.gaps) return { gaps: err.gaps };
    if (err instanceof LoadConfigError && err.recordTypesUntold) {
      return { recordTypesUntold: err.recordTypesUntold };
    }
    if (err instanceof LoadEmailsStop) return { emails: err.emails, orgId: err.orgId };
    return undefined;
  }

  /**
   * The gate of a load on the emails of what still runs as it writes
   * (`loadEmailsOf`), read through the load's connection as the user it
   * writes as: the daily limits and the deliverability only when something
   * sends, and no Apex in a production org, which the entry guards refuse
   * first.
   */
  private loadEmailsFor(input: {
    conn: LimitsTransport;
    orgId: string;
    orgTier: SafetyTier;
    read: ForgeTargetAutomation | { unread: string };
    plan?: Pick<MutePlan, 'assign'>;
    writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
    dataset: FrozenDataset;
    accepted: boolean;
    mayMute: boolean;
  }): Promise<LoadEmails> {
    const org = this.deps.orgManager.getOrg(input.orgId);
    return loadEmailsOf({
      read: input.read,
      ...(input.plan ? { plan: input.plan } : {}),
      writes: input.writes,
      // At most, as Production Guard counts a load: a pilot's or a reload's
      // records found again in the target are among them.
      inserts: input.dataset.objects
        .map((object) => ({ objectApiName: object.objectApiName, rows: object.records.length }))
        .filter((object) => object.rows > 0),
      readLimits: () => readEmailLimits(input.conn),
      readDeliverability: () =>
        input.orgTier === 'production'
          ? Promise.resolve(NO_APEX_IN_PRODUCTION)
          : readEmailDeliverability(input.conn),
      accepted: input.accepted,
      target: org?.alias || org?.username || input.orgId,
      mayMute: input.mayMute,
    });
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

    /*
     * The selection's stop: its time running out, or a cancel — Live
     * Operations' Cancel, or `execution:abort` with this request's id. Either
     * stops it at its next step and stops waiting on the call in flight; what
     * it decided is kept and answered. It used to run under a timeout that
     * threw it all away: run for real on a large org, ten minutes of probing
     * ended on `frozen:select timed out after 600000ms`, nothing kept, and no
     * word on where it was.
     */
    const description = 'Coverage-matrix selection';
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort('timeout'), SELECT_TIMEOUT_MS);
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    this.registry?.register(msg.id, 'frozen', description, tracked, abortController);
    this.liveTracker?.register(msg.id, 'frozen', description);
    /** Say a step to the panel, and to Live Operations. */
    const tell = (step: FrozenSelectProgress): void => {
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:select:progress', { ...step }),
      );
      if (step.phase === 'combination' && step.index !== undefined && step.of) {
        this.liveTracker?.updateProgress(
          msg.id,
          Math.round(((step.index - 1) / step.of) * 100),
          step.index - 1,
          step.of,
          step.combinationKey ?? '',
        );
      }
    };

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      // One answer per statement for the selection: the record types every
      // extraction pulls, the standard price book, a parent two candidates
      // share. Copied as handed out, so no extraction changes another's rows.
      const answered = new Map<string, Promise<Record<string, unknown>[]>>();
      const query = async (soql: string): Promise<Record<string, unknown>[]> => {
        let rows = answered.get(soql);
        if (!rows) {
          rows = queryAll(conn, soql);
          answered.set(soql, rows);
          rows.catch(() => answered.delete(soql));
        }
        return (await rows).map((row) => ({ ...row }));
      };
      const tokens = await this.loadTokens(sasDir, guard);
      const discoveryOptions = this.discoveryOptions(config);
      // The objects the extractions describe, kept with the graph for the
      // next step's reads.
      const described = new Set<string>();
      const extractor = new FrozenDatasetExtractor({
        query,
        describeFields: (objectApiName) => {
          described.add(objectApiName);
          return this.describeScopableFields(parsed.sourceOrgId, objectApiName);
        },
        keyPrefixes: () => this.keyPrefixes(parsed.sourceOrgId),
      });
      // One instant for every measure of the selection, so a statement two
      // candidates' extractions share is the same statement.
      const asOf = new Date().toISOString();
      // One graph for the run: it is the root object's, whichever root asks.
      let graphOnce: Promise<StepGraph> | undefined;
      let reached = 0;
      const graphFor = async (rootRecordId: string): Promise<ForgeGraph> => {
        graphOnce ??= this.graphOfStep({
          step: 'select',
          sourceOrgId: parsed.sourceOrgId,
          config,
          sasDir,
          guard,
          rootRecordId,
          signal: abortController.signal,
          // A line every ten objects: a discovery of a large org reaches
          // hundreds, and the panel and the command line said nothing.
          onProgress: (event) => {
            if (event.phase !== 'object') return;
            if (event.discoveredCount - reached < 10 && event.queueRemaining > 0) return;
            reached = event.discoveredCount;
            tell({ phase: 'discovery', objects: event.discoveredCount });
          },
        });
        return withoutExcluded((await graphOnce).graph, config.excludedObjects);
      };
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
          asOf,
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

      // The type of the field an axis filters on, which says how a probe
      // writes its values: a checkbox's bare, as SOQL takes it.
      const fieldType = async (objectApiName: string, field: string) =>
        (await this.describeObject(parsed.sourceOrgId, objectApiName)).fields.find(
          (f) => f.name.toLowerCase() === field.toLowerCase(),
        )?.type;
      const selector = new CoverageMatrixSelector({
        query,
        checkHealth,
        measureVolumetry,
        fieldType,
      });
      const result = await selector.select(
        {
          rootObject: config.rootObject,
          axes: config.axes,
          edgeCases: config.edgeCases,
          budgetMaxRecords: config.budgetMaxRecords,
          candidatesPerCombination: config.candidatesPerCombination,
          tokens,
        },
        { signal: abortController.signal, onProgress: tell },
      );

      const selectionPath = await writeSelectionToSas(sasDir, result, guard);
      // A discovery that failed has already said so through every candidate
      // it turned away; the summary just carries no graph. One still running
      // when the selection stopped is not waited for, nor kept.
      const found =
        graphOnce && !result.stopped ? await graphOnce.catch(() => undefined) : undefined;
      if (found?.keep) {
        await found.keep(described).catch((err: unknown) => {
          this.deps.log(`[WARN] frozen: the graph could not be kept in the sas: ${String(err)}`);
        });
      }
      const graph = found ? withoutExcluded(found.graph, config.excludedObjects) : undefined;
      const response = buildResponse(this.deps, msg, 'frozen:select:response', {
        selection: {
          ...toSelectionSummary(
            result,
            selectionPath,
            graph ? graphCoverage(graph, discoveryOptions.maxNodes) : undefined,
          ),
          ...(found ? { discovery: found.origin } : {}),
        },
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, {
        roots: result.roots.length,
        total: result.volumetry.total,
        ...(result.stopped ? { stopped: result.stopped.reason } : {}),
      });
      if (result.stopped?.reason === 'cancelled') this.liveTracker?.cancel(msg.id);
      else this.liveTracker?.complete(msg.id);
      settle();
    } catch (err: unknown) {
      this.liveTracker?.fail(msg.id, extractErrorMessage(err));
      settle(err);
      sendHandlerError(this.deps, 'frozen:select', 'frozen:select:error', msg, err, {
        code: this.errorCodeFor(err, 'SELECT_ERROR'),
        retryable: err instanceof TimeoutError,
        extraPayload: this.errorDetailOf(err),
      });
    } finally {
      clearTimeout(timer);
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
      // The salt kept, or — the first time, in the editor — one made and kept
      // from now on: never a second one beside it, or the same records would
      // get other pseudonyms. Where none is kept and none can be (the command
      // line), MissingSaltError says how to give it.
      const salt = await this.saltKeeper.forExtraction();
      const pseudonymizer = new DeterministicPseudonymizer(salt.salt);
      if (salt.created) this.sayTheSaltWasMade(pseudonymizer.saltFingerprint);

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
      const rulesPath = this.resolveRulesPath(config);
      if (!(await pathExists(rulesPath))) {
        throw new RulesFileMissingError(
          rulesPath,
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
      const discoveryOptions = this.discoveryOptions(config);
      // The selection's graph, when it kept one the source still matches.
      const found = await this.graphOfStep({
        step: 'extract',
        sourceOrgId: parsed.sourceOrgId,
        config,
        sasDir,
        guard,
        rootRecordId: rootRecordIds[0],
      });
      const graph = withoutExcluded(found.graph, config.excludedObjects);
      const described = new Set<string>();
      const extractor = new FrozenDatasetExtractor({
        query: (soql) => queryAll(conn, soql),
        describeFields: (objectApiName) => {
          described.add(objectApiName);
          return this.describeScopableFields(parsed.sourceOrgId, objectApiName);
        },
        keyPrefixes: () => this.keyPrefixes(parsed.sourceOrgId),
      });

      const author = parsed.author ?? 'sandforge';
      const datasetVersion = config.datasetVersion ?? DEFAULT_DATASET_VERSION;

      const { extracted, frozen, report, requiredLeftEmpty, keptUnruled } =
        await new TimeoutManager(EXTRACT_TIMEOUT_MS).withTimeout('frozen:extract', async () => {
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
          // The rules with what the source's describes tell them: a
          // restricted picklist's value is a word of the schema, kept — but
          // for one the personal data detector names, a gender or a religion.
          const schema = await this.ruleSchemaOf(parsed.sourceOrgId, extracted.objects);
          const effective = withSchemaDefaults(
            rules,
            schema,
            this.deps.infraServices?.piiDetector ?? new PIIDetector(),
          );
          const frozen = new FrozenDatasetAnonymizer().anonymize({
            extracted,
            rules: effective,
            pseudonymizer,
            datasetVersion,
          });
          const report = new NonReidentificationControl().run(extracted, frozen, effective, {
            author,
          });
          return {
            extracted,
            frozen,
            report,
            requiredLeftEmpty: requiredFieldsLeftEmpty(extracted, effective, schema),
            keptUnruled: keptWithoutARule(extracted, effective),
          };
        });
      if (requiredLeftEmpty.length > 0) {
        this.deps.log(
          `[WARN] frozen: the rules leave ${requiredLeftEmpty.length} required field(s) empty, ` +
            `which a load will ask a value for: ${requiredLeftEmpty.join(', ')}`,
        );
      }
      // Discovered here, the graph is kept for the next extraction, whatever
      // the control says of the rules.
      if (found.keep) {
        await found.keep(described).catch((err: unknown) => {
          this.deps.log(`[WARN] frozen: the graph could not be kept in the sas: ${String(err)}`);
        });
      }

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
          // What the rules leave empty that the source requires, said now
          // rather than at the load that would ask for it.
          ...(requiredLeftEmpty.length > 0 ? { requiredLeftEmpty } : {}),
          // What went in clear text with no rule saying so: the platform's own words.
          ...(keptUnruled.length > 0 ? { keptWithoutARule: keptUnruled } : {}),
          // What the dataset does not hold, read masked: encrypted fields the
          // source's user may not view in clear. Written when it names none
          // too: a manifest without it was written before the extraction left
          // them out, and a load of it leaves out the fields the target
          // encrypts unless told to write them.
          encryptedNotKept: extracted.encryptedNotKept ?? [],
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
        discovery: found.origin,
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
        extraPayload: this.errorDetailOf(err),
      });
    }
  }

  // ── frozen:rules:clear ─────────────────────────────────────────────────

  /**
   * Write a `clear` rule into the rules file for each field the panel names:
   * the fields an extraction kept in clear text without a rule, which its
   * result lists for review. The dataset already written keeps them as it
   * holds them; the next extraction clears them.
   *
   * The panel only showed what a dataset kept without a rule in its manifest
   * and on the command line, and clearing one meant editing the rules file by
   * hand. The file is written whole once its new content is complete, so an
   * interrupted write leaves the rules as they were.
   */
  private async handleRulesClear(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenRulesClearPayloadSchema,
      msg,
      'frozen:rules:clear:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:rules:clear:error');
    if (!config) return;
    try {
      const rulesPath = this.resolveRulesPath(config);
      if (!(await pathExists(rulesPath))) {
        throw new RulesFileMissingError(
          rulesPath,
          `Pseudonymization rules file not found at ${rulesPath} — nothing was written. Create ` +
            'it, or set rulesFilePath in the configuration.',
        );
      }
      const result = withFieldsCleared(
        JSON.parse(await fs.readFile(rulesPath, 'utf8')),
        parsed.fields,
      );
      if (result.cleared.length > 0) {
        const pending = `${rulesPath}.${process.pid}.writing`;
        await fs.writeFile(pending, `${JSON.stringify(result.payload, null, 2)}\n`, 'utf8');
        await fs.rename(pending, rulesPath);
        this.deps.log(
          `[INFO] frozen: ${result.cleared.length} field(s) given a clear rule in ${rulesPath} ` +
            `(rules ${result.rulesVersion}): ${result.cleared.join(', ')}`,
        );
      }
      const response = buildResponse(this.deps, msg, 'frozen:rules:clear:response', {
        rulesPath,
        rulesVersion: result.rulesVersion,
        cleared: result.cleared,
        alreadyRuled: result.alreadyRuled,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:rules:clear', 'frozen:rules:clear:error', msg, err, {
        code: this.errorCodeFor(err, 'RULES_CLEAR_ERROR'),
        extraPayload: this.errorDetailOf(err),
      });
    }
  }

  // ── frozen:rules:create ────────────────────────────────────────────────

  /**
   * Write the empty rules file where the extraction reads it, and open it.
   *
   * An extraction is refused without the file, and nothing in the panel made
   * one or said what it holds: a first-time user was stuck after the
   * selection. Empty is valid and safe — every field without a rule is
   * cleared, and the extraction's result then lists what it kept without a
   * rule for review. A file already there is never written over, whatever it
   * holds: it is opened as it is.
   */
  private async handleRulesCreate(msg: InboundRequest): Promise<void> {
    const rulesPath = this.resolveRulesPath(this.loadConfig());
    let created = false;
    try {
      await fs.mkdir(path.dirname(rulesPath), { recursive: true });
      try {
        // `wx`: the write fails rather than replace a file that is there.
        await fs.writeFile(rulesPath, serializePseudonymRules(EMPTY_RULES_FILE), {
          encoding: 'utf8',
          flag: 'wx',
        });
        created = true;
        this.deps.log(`[INFO] frozen: empty rules file written at ${rulesPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Something is there: a file is left as it is, anything else is no rules file.
        if (!(await fs.stat(rulesPath)).isFile()) {
          throw new Error(`${rulesPath} is not a file: no rules file can be written there.`);
        }
      }
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:rules:create', 'frozen:rules:create:error', msg, err, {
        code: 'RULES_CREATE_ERROR',
      });
      return;
    }
    let opened = false;
    try {
      await this.openInEditor(rulesPath);
      opened = true;
    } catch (err: unknown) {
      // Written is what was asked: an editor that would not open it leaves
      // the file where the line on the page names it.
      this.deps.log(`[WARN] frozen: rules file not opened: ${extractErrorMessage(err)}`);
    }
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, 'frozen:rules:create:response', { rulesPath, created, opened }),
    );
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

  /**
   * The tier a load, its preview and its removal take the target for: the one
   * every guard takes it for (`guardTierOf`). A Developer Edition org says
   * IsSandbox false while it holds nobody's business: Forge cloned into one,
   * and the load refused it as production, leaving those with no sandbox of
   * their own nowhere to load a dataset. A production org of any other
   * edition, or of an edition not known, stays production, and every guard of
   * the load refuses it.
   */
  private targetTier(orgId: string): SafetyTier {
    const org = this.deps.orgManager.getOrg(orgId);
    return guardTierOf(org);
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
    // A reload takes the loads before it back whole, or does not start:
    // nothing purged, nothing inserted. Refused so, it is recorded as a load
    // a check of its own stopped before it started.
    const notReplaced = await this.replaceRefusal(parsed, config);
    if (notReplaced) {
      if (notReplaced.code === REPLACE_LEAVES_RECORDS) {
        recordWriteRun(this.deps, {
          action: 'frozen_load',
          module: 'frozen',
          operationId: msg.id,
          orgId: parsed.targetOrgId,
          outcome: 'stopped',
          code: REPLACE_LEAVES_RECORDS,
        });
      }
      sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, notReplaced.error, {
        code: notReplaced.code,
        retryable: notReplaced.retryable,
      });
      return;
    }

    // The id of the request that started it, as Sync's runs use theirs: the
    // page knows it, and its Cancel reaches the registry's controller below,
    // as Live Operations' does. Minted here, it was an id the page never saw,
    // and the Load tab could not stop the load it started.
    const operationId = msg.id;
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
    const throttledProgress = throttleProgress((event: FrozenLoadProgressEvent) => {
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
    /** When the load began, on this machine's clock: the start of its span for another sas's sweep. */
    const startedAt = new Date().toISOString();
    /** The mark of the sas it writes to, once resolved (`sasMarkOf`). */
    let sasMark: string | undefined;
    /** When the target dated its last write, once its mapping keeps it (`lastWriteOfLoad`). */
    let lastWriteAt: string | undefined;
    /** What its gate made of the emails of what still runs, once judged. */
    let emailsJudged: LoadEmails | undefined;
    const recordLoad = (
      outcome: AuditOutcome,
      objects?: AuditObjectCounts[],
      carried?: Record<string, number>,
      code?: string,
    ): void => {
      if (recorded) return;
      recorded = true;
      // A load that wrote is a run of the window of another sas's loads into
      // the org: marked with its sas and dated from its start, the sweep of
      // those loads tells it from their own (`otherSasRunsOf`).
      const marked = outcome !== 'stopped' && sasMark !== undefined;
      // What the org said of the emails, and that they went with the accord,
      // as a seed's or a sync's entry says it.
      const emailsSaid = emailsJudged
        ? runEmailsDetailsOf(
            runEmailsSaidOf(
              emailsJudged.run.gate,
              emailsJudged.info.accepted && emailsJudged.info.verdict === 'asks',
            ).emails,
          )
        : {};
      const details = {
        ...(marked ? { sas: sasMark, startedAt, ...(lastWriteAt ? { lastWriteAt } : {}) } : {}),
        ...emailsSaid,
      };
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
        ...(code ? { code } : {}),
        ...(mutedAutomation ? { muted: auditMutedOf(mutedAutomation) } : {}),
        ...(checkpoint?.state === 'taken' ? { checkpointId: checkpoint.checkpointId } : {}),
        ...(Object.keys(details).length > 0 ? { details } : {}),
      });
    };
    /** What the load muted of the target's automation, when it was asked to. */
    let mutedAutomation: MutedAutomation | undefined;
    /** The checkpoint the load took before its lease and its first write, when asked. */
    let taken: RunCheckpointTaken | undefined;
    /** What became of it once the load ended: kept when it wrote, deleted when it wrote none. */
    let checkpoint: RunCheckpointInfo | undefined;
    /** Whether the loader had the load: what it wrote is said only by what it reports. */
    let loadStarted = false;
    /** The sweep asked with a reload, one per load it replaces: see `reloadSweepsOf`. */
    let sweeps: SweepOfALoad[] = [];

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      sasMark = sasMarkOf(sasDir);
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

      // Asked to mute, the load reads what the target runs on the objects it
      // writes — it has no gate of its own that does — and plans the mute
      // from it: refused on a production org or for a user who cannot
      // assign, it writes nothing. The lease is taken before the load reads
      // the record types its writes go by, and given back after its last
      // write, or as it ends on anything else. Asked to take a checkpoint
      // first, it reads the same once, for what still runs. A reload's purge
      // deletes before the load inserts: a mute planned from the inserts alone
      // left what fires on those deletes running.
      //
      // Asked with a reload, the sweep of each load it replaces reads what it
      // takes and asks Production Guard first, as a removal's does, before
      // the lease: a person answering holds no permission set assigned. What
      // it deletes is read with the rest, muted with the purge's deletes, and
      // on the command line asked about, refused unaccepted, before anything
      // is written. A stop while it read asks nothing.
      if (parsed.sweep === true && parsed.reload === true && !parsed.pilot) {
        sweeps = await this.reloadSweepsOf({
          conn,
          store: mappingStore,
          sweepLate: parsed.sweepLate === true,
          sweepUntied: parsed.sweepUntied === true,
          includeChanged: parsed.includeChanged === true,
          signal: abortController.signal,
          guard: productionGuard,
          operationId,
        });
        for (const { sweep } of sweeps) await sweep.ask();
      }
      const swept = removalStepsOfLoad(
        [],
        sweeps.flatMap(({ sweep }) => sweep.takes),
      );
      const asker = (swept.delete ?? []).length > 0 ? this.removalAsker : undefined;
      const written = dataset.objects.map((object) => object.objectApiName);
      const purge =
        parsed.reload === true && !parsed.pilot
          ? await this.purgeStepsOf(mappingStore, config)
          : undefined;
      // Read whatever the load is asked: the mute is planned from it, the
      // checkpoint scoped, and the emails of what still runs judged. Read
      // only to mute or take a checkpoint, a load's inserts fired the
      // target's flows with no question about the emails they send. A read
      // that fails asks, as an org that would not say asks.
      const read = await this.targetAutomation
        .read(parsed.targetOrgId, [
          ...new Set([...written, ...(purge?.delete ?? []), ...(swept.delete ?? [])]),
        ])
        .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
      const purgeWrites = purge ? removalStepsWrites(purge) : undefined;
      const sweptWrites = removalStepsWrites(swept);
      const loadWrites = (object: string, write: ForgeAutomationWrite): boolean =>
        LOAD_WRITES(object, write) ||
        purgeWrites?.(object, write) === true ||
        sweptWrites(object, write);
      const mute =
        parsed.muteAutomation === true
          ? await muteForRun(async () => muteOrgOf(conn), read, {
              ...this.muteLeases,
              writes: loadWrites,
            })
          : undefined;
      mutedAutomation = mute?.muted;
      // The command line's question, on what the sweeps delete: the purge's
      // own deletes it asked about before it sent the reload.
      if (asker && !abortController.signal.aborted) {
        const stop = await asker({ read, steps: swept, mute });
        if (stop) throw new RemovalStopped(stop);
      }
      // What stands in the load's way, before anything is taken for it: the
      // entry guards, and Production Guard's question about the whole load,
      // once. The batches it judges still take that answer, and ask nothing.
      const orgTier = this.targetTier(parsed.targetOrgId);
      const answer = await loader.gateLoad({
        orgId: parsed.targetOrgId,
        orgTier,
        dataset,
        manifest,
        reload: parsed.reload,
        pilot: parsed.pilot ? {} : undefined,
        onProgress: (event) => throttledProgress(event),
        onGuardDecision: (decision) => {
          guardDecision = strongerDecision(guardDecision, decision);
        },
      });
      // The emails of what still runs as the load writes, once its guards
      // let it through and before anything is taken for it: past what the
      // target has left today, or delivered without the accord, the load is
      // refused, nothing written, as a seed or a sync is.
      const accepted = parsed.acceptEmails === true;
      const emails = await this.loadEmailsFor({
        conn,
        orgId: parsed.targetOrgId,
        orgTier,
        read,
        ...(mute?.plan ? { plan: mute.plan } : {}),
        writes: loadWrites,
        dataset,
        accepted,
        mayMute: parsed.muteAutomation !== true,
      });
      emailsJudged = emails;
      if (emails.stop)
        throw new LoadEmailsStop(
          emails.stop.code,
          emails.stop.message,
          emails.info,
          parsed.targetOrgId,
        );
      // The checkpoint of what the load writes, taken after the cost its
      // preview said and before the lease and the first write: refused,
      // failed or stopped, the load writes nothing and assigns nothing.
      if (parsed.checkpointFirst !== undefined) {
        taken = await this.takeLoadCheckpoint({
          msg,
          orgId: parsed.targetOrgId,
          written,
          read,
          mute,
          request: parsed.checkpointFirst,
          signal: abortController.signal,
        });
      }
      const held = mute?.prepared ? await mute.prepared.acquire(operationId) : undefined;
      if (held) mutedAutomation = held.outcome;
      // A set the lease does not hold leaves running what it was to keep
      // quiet: a sender among it no gate judged refuses the load, unless the
      // emails were accepted, the lease given back first.
      const relit = held ? emails.run.afterLease(held.outcome, accepted) : undefined;
      if (held && relit) {
        mutedAutomation = await held.release();
        throw new LoadEmailsStop(relit.code, relit.message, emails.info, parsed.targetOrgId);
      }
      loadStarted = true;
      const load = (): Promise<FrozenLoadReport> =>
        loader.load({
          orgId: parsed.targetOrgId,
          orgTier,
          dataset,
          manifest,
          sasDir,
          reload: parsed.reload,
          pilot: parsed.pilot ? {} : undefined,
          ...(parsed.writeEncrypted ? { writeEncrypted: true } : {}),
          ...(parsed.maxRecords !== undefined ? { maxRecords: parsed.maxRecords } : {}),
          onProgress: (event) => throttledProgress(event),
          onGuardDecision: (decision) => {
            guardDecision = strongerDecision(guardDecision, decision);
            if (decision === 'allowed' || decision === 'confirmed') batchLetThrough = true;
          },
          // The controller the registry aborts: the load stops before its next
          // write, where it used to run to its end.
          signal: abortController.signal,
          // Given back after its last write, before it reads what the target
          // gave its records; as it ends, below, whatever it ended on.
          ...(held ? { lease: { giveBack: () => held.release() } } : {}),
          // Under the lease, around the purge: each load's first part before
          // it, its last once the purge's deletes are through. A load whose
          // sweep left what it was to take stays recorded once the purge took
          // its records, as a removal keeps the load it took back: dropped,
          // what its sweep left was tied to no load, and the option its result
          // named took nothing.
          ...(sweeps.length > 0
            ? {
                purgeSweep: {
                  first: async () => {
                    for (const { sweep } of sweeps) await sweep.first();
                  },
                  afterPurge: async () => {
                    for (const { sweep } of sweeps) await sweep.afterRemoval();
                  },
                  stillToSweep: () =>
                    sweeps
                      .filter(({ sweep }) => !sweepTookAll(sweep.result()))
                      .map(({ loadedAt }) => loadedAt),
                },
              }
            : {}),
        });
      const loaded = answer === 'confirmed' ? withGivenAnswer({ approved: true }, load) : load();
      const report = await loaded.finally(async () => {
        if (held) mutedAutomation = await held.release();
      });
      throttledProgress.flush();
      // What each sweep did, recorded beside the load, and said in its report.
      const swepts = await this.settleReloadSweeps(sweeps);
      /** Whether a sweep left what it was asked to take: the load then ends partial. */
      const sweepLeft = swepts.some((swept) => swept.result.status !== 'success');
      // A sweep that left what it was to take ends the load partial, as it
      // ends the removal it is asked with: never a success, in the report,
      // the last run, Live Operations and the command line alike.
      const status: FrozenLoadReportInfo['status'] =
        report.status === 'completed' && sweepLeft ? 'partial' : report.status;
      // Kept once the load wrote a record, whatever it came to; deleted when
      // it wrote none.
      if (taken) checkpoint = await this.settleCheckpoint(taken, recordsWritten(report) > 0);
      lastWriteAt = lastWriteOfLoad(
        await mappingStore.recorded().catch(() => undefined),
        startedAt,
      );
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
        status,
        at: new Date().toISOString(),
      };
      this.recordLastRun(lastRun);

      const response = buildResponse(this.deps, msg, 'frozen:load:response', {
        report: {
          ...toLoadReportInfo(report),
          status,
          ...(mutedAutomation ? { mutedAutomation } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          ...(swepts.length > 0 ? { sweeps: swepts } : {}),
          ...(emailsJudged && saysSomething(emailsJudged.info)
            ? { emails: emailsJudged.info }
            : {}),
        },
      });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { status });
      ended = true;
      // Records the org refused: listed partial, as the report says.
      if (report.status === 'completed-with-errors' || sweepLeft) {
        this.liveTracker?.partial(operationId);
      } else this.liveTracker?.complete(operationId);

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
      // What the sweeps deleted before the load ended so is recorded all the
      // same, and said beside its error.
      const sweptBefore = await this.settleReloadSweeps(sweeps).catch(() => []);
      const withSweeps = sweptBefore.length > 0 ? { sweeps: sweptBefore } : {};
      // The checkpoint taken first: kept once the load wrote a record before
      // it stopped, deleted when it wrote none — its lease refused, a cancel
      // before its first write. One whose load threw saying nothing of what
      // it wrote, once the loader had it, is kept: it may be what takes that
      // back.
      if (taken && checkpoint === undefined) {
        const said =
          err instanceof FrozenLoadCancelledError || err instanceof FrozenLoadFailedError
            ? err.written
            : undefined;
        checkpoint = await this.settleCheckpoint(
          taken,
          said ? recordsWritten(said) > 0 : loadStarted && !isMuteRefusedError(err),
        );
      }
      const withCheckpoint = checkpoint ? { checkpoint } : {};
      if (err instanceof CheckpointFirstStop) {
        // Stopped for the checkpoint asked first, before the lease and the
        // first write: refused or failed, recorded as a load a check of its
        // own stopped before it started; cancelled while it read, ended the
        // way a cancel before the first write ends.
        recordLoad('stopped', undefined, undefined, err.code);
        sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, err, {
          code: err.code,
          // What the panel says of a stop: before the first write, nothing written.
          ...(err.code === 'LOAD_CANCELLED' ? { extraPayload: { written: 0 } } : {}),
        });
        if (err.code === 'LOAD_CANCELLED') {
          this.registry?.abort(operationId);
          sendOperationCompleted(this.deps, operationId, { aborted: true });
          this.liveTracker?.cancel(operationId);
          settle();
        } else {
          sendOperationFailed(this.deps, operationId, err.message, true);
          this.liveTracker?.fail(operationId, err.message);
          settle(err);
        }
        return;
      }
      if (err instanceof FrozenLoadCancelledError) {
        // Ended the way a cancelled Sync or Seed ends: recorded with what it
        // wrote, aborted in the registry — already, when the cancel came
        // through it — and posted as a completion that says so. The page
        // hears it on the load's error channel, which settles its request.
        // Stopped before it wrote, it is recorded as a run a check of its own
        // stopped before it started, under the code that names why: no
        // decision of Production Guard's, it stays in the trail when those
        // are not kept.
        const outcome = cancelledFrozenOutcome(err.written);
        recordLoad(
          outcome,
          frozenAuditObjects(err.written),
          undefined,
          outcome === 'stopped' ? 'LOAD_CANCELLED' : undefined,
        );
        this.registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
        // With the records it wrote before it stopped, which the panel says
        // in its words: the host's name them object by object, in English.
        sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, err, {
          code: 'LOAD_CANCELLED',
          extraPayload: { written: recordsWritten(err.written), ...withCheckpoint, ...withSweeps },
        });
        settle();
        return;
      }
      // Stopped when the guard refused the first batch it was asked about:
      // nothing was written. After a batch went through, the load failed —
      // recorded with what it wrote, when it says, which its mapping names;
      // the code is the one of what it failed on.
      // A mute refused stops the load before its first write; so does what
      // the command line's question on what a reload's sweep deletes stopped,
      // and the gate on the emails.
      const refusedFirst =
        isMuteRefusedError(err) || err instanceof RemovalStopped || err instanceof LoadEmailsStop
          ? err
          : undefined;
      const stopped =
        refusedFirst !== undefined ||
        ((guardDecision === 'refused' || guardDecision === 'declined') && !batchLetThrough);
      const failed = err instanceof FrozenLoadFailedError ? err : undefined;
      const cause = failed ? failed.cause : err;
      recordLoad(
        stopped ? 'stopped' : 'failure',
        failed ? frozenAuditObjects(failed.written) : undefined,
        undefined,
        refusedFirst?.code,
      );
      // Production Guard's refusal once batches went through is a failure
      // with records written, which the host's words alone name: the panel's
      // say nothing was changed, and are given only what stopped the load.
      const detail =
        failed && cause instanceof LoadGuardError
          ? { guard: cause.code }
          : this.errorDetailOf(cause);
      sendHandlerError(this.deps, 'frozen:load', 'frozen:load:error', msg, err, {
        code: refusedFirst?.code ?? this.errorCodeFor(cause, 'LOAD_ERROR'),
        retryable: cause instanceof TimeoutError,
        extraPayload:
          detail || checkpoint || sweptBefore.length > 0
            ? { ...detail, ...withCheckpoint, ...withSweeps }
            : undefined,
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

  /**
   * What the checkpoint of what a load writes is asked of: the objects of its
   * dataset, which it inserts and a reload purges, and the objects what still
   * runs creates as it writes them once the mute's plan holds
   * (`stillRunningOf`). What could not be read creates nothing the scope can
   * name: the checkpoint then holds the dataset's objects.
   */
  private loadCheckpointAsk(input: {
    orgId: string;
    operationId: string;
    written: readonly string[];
    read: ForgeTargetAutomation | { unread: string };
    mute?: Pick<RunMute, 'plan'>;
    request: RunCheckpointRequest;
  }): BeforeRunAsk {
    const { read } = input;
    return {
      module: 'frozen',
      orgId: input.orgId,
      operationId: input.operationId,
      written: [...input.written],
      running:
        'objects' in read ? stillRunningOf(read, input.mute?.plan, LOAD_WRITES) : { firing: [] },
      request: input.request,
    };
  }

  /**
   * What the checkpoint a load asked to take first would hold and cost, and
   * the refusal the load would meet, for its preview: what still runs read
   * for it, the mute planned when asked — nothing assigned — and a plan that
   * cannot be made leaving what the read says runs. Left out, said in the
   * log, when it cannot be scoped: the load says why when it is started.
   */
  private async previewCheckpoint(input: {
    msg: InboundRequest;
    orgId: string;
    written: readonly string[];
    request: RunCheckpointRequest;
    muteAutomation: boolean;
    conn: Parameters<typeof muteOrgOf>[0];
  }): Promise<RunCheckpointEstimate | undefined> {
    const checkpoints = this.beforeRunCheckpoints;
    if (!checkpoints) return undefined;
    const read = await this.targetAutomation
      .read(input.orgId, input.written)
      .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
    const mute = input.muteAutomation
      ? await muteForRun(async () => muteOrgOf(input.conn), read, {
          ...this.muteLeases,
          writes: LOAD_WRITES,
        }).catch((err: unknown) => {
          logger.warn(
            `Frozen preview: the mute could not be planned (${extractErrorMessage(err)})`,
          );
          return undefined;
        })
      : undefined;
    const ask = this.loadCheckpointAsk({
      ...input,
      operationId: input.msg.id,
      read,
      ...(mute ? { mute } : {}),
    });
    return checkpoints.scope(ask, {}).catch((err: unknown) => {
      logger.warn(`Frozen preview: ${beforeRunFailedWords(err)}`);
      return undefined;
    });
  }

  /**
   * Take the checkpoint of what a load writes before its lease and its first
   * write: scoped first, reading no record — refused there, the load is
   * refused — then taken, held to what the scope said it takes, stopped by
   * the load's Cancel. The load's own mark alone does not refuse either.
   *
   * @throws {CheckpointFirstStop} When it is refused, fails or is stopped:
   *   nothing was written, and nothing of the take is kept.
   */
  private async takeLoadCheckpoint(input: {
    msg: InboundRequest;
    orgId: string;
    written: readonly string[];
    read: ForgeTargetAutomation | { unread: string };
    mute?: Pick<RunMute, 'plan'>;
    request: RunCheckpointRequest;
    signal: AbortSignal;
  }): Promise<RunCheckpointTaken> {
    const checkpoints = this.beforeRunCheckpoints;
    if (!checkpoints) {
      throw new CheckpointFirstStop(
        CHECKPOINT_REFUSED,
        beforeRunFailedWords(new Error("SandForge's checkpoints are not set up in this window")),
      );
    }
    const ask = this.loadCheckpointAsk({ ...input, operationId: input.msg.id });
    const own: BeforeRunOwn = { operationId: frozenMarkOf(input.msg.id) };
    let estimate: RunCheckpointEstimate;
    try {
      estimate = await checkpoints.scope(ask, own);
    } catch (err: unknown) {
      throw new CheckpointFirstStop(CHECKPOINT_REFUSED, beforeRunFailedWords(err));
    }
    const refused = checkpointScopeStop(estimate);
    if (refused) throw new CheckpointFirstStop(refused.code, refused.message);
    const took = await takeCheckpointFirst(() =>
      checkpoints.take(ask, own, { planned: estimate, signal: input.signal }),
    );
    if ('stop' in took) {
      throw new CheckpointFirstStop(
        took.stop.code === CHECKPOINT_REFUSED ? CHECKPOINT_REFUSED : 'LOAD_CANCELLED',
        took.stop.message,
      );
    }
    return took.checkpoint;
  }

  /**
   * What becomes of the checkpoint a load took before its first write once it
   * has ended: kept when it wrote a record, deleted when it wrote none. One
   * the checkpoints cannot settle is kept as it was taken, said in the log.
   */
  private async settleCheckpoint(
    taken: RunCheckpointTaken,
    wrote: boolean,
  ): Promise<RunCheckpointInfo> {
    const checkpoints = this.beforeRunCheckpoints;
    if (!checkpoints) return taken;
    try {
      return await checkpoints.settle(taken, wrote);
    } catch (err: unknown) {
      logger.warn(
        `Frozen load: the checkpoint '${taken.name}' taken before it is kept, as it could not be settled (${extractErrorMessage(err)})`,
      );
      return taken;
    }
  }

  /**
   * Keep the pointers of a load: as the last load, and as the last load into
   * its org. The last load of before, recorded when the pointers were kept
   * for the last load alone, is kept for its org first, so that a load into
   * another org does not take its verification away.
   */
  private recordLastRun(run: FrozenLastRun): void {
    // While the load it followed is still the last one: see `orgOfOldVerify`.
    this.moveOldVerify();
    const byOrg = { ...this.lastRuns() };
    const before = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    if (before && byOrg[before.targetOrgId] === undefined) byOrg[before.targetOrgId] = before;
    byOrg[run.targetOrgId] = run;
    this.deps.configStore.set(LAST_RUNS_KEY, byOrg, FROZEN_CATEGORY);
    this.deps.configStore.set(LAST_RUN_KEY, run, FROZEN_CATEGORY);
  }

  /** Keep the verdict of a verification as the last one of its org. */
  private recordLastVerify(orgId: string, verify: FrozenLastVerify): void {
    this.moveOldVerify();
    this.deps.configStore.set(
      LAST_VERIFIES_KEY,
      { ...this.lastVerifies(), [orgId]: verify },
      FROZEN_CATEGORY,
    );
  }

  /** The verdict of the last verification of each org, by its registered id. */
  private lastVerifies(): Record<string, FrozenLastVerify> {
    return this.deps.configStore.get<Record<string, FrozenLastVerify>>(LAST_VERIFIES_KEY) ?? {};
  }

  /**
   * The org the verdict kept for every org at once was of, when that can be
   * told. It names none: it is the last load's when it was measured after
   * that load — every verification is of the last load into its org — and
   * no other org has a load recorded, which it could have been of instead.
   * Until loads were kept per org, that was always so: a verification read
   * the last load's contract alone. Measured before the last load, or when
   * another org has a load it may have been of, it is given to no org rather
   * than shown as the verdict of one it was not of.
   */
  private orgOfOldVerify(verify: FrozenLastVerify): string | undefined {
    const last = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    if (!last || Date.parse(last.at) > Date.parse(verify.measuredAt)) return undefined;
    const others = Object.keys(this.lastRuns()).filter((orgId) => orgId !== last.targetOrgId);
    return others.length === 0 ? last.targetOrgId : undefined;
  }

  /**
   * Move the verdict kept for every org at once to the org it was of, unless
   * that org has one of its own, and drop it: the org it was of is told by
   * the loads recorded, which the next load changes.
   */
  private moveOldVerify(): void {
    const old = this.deps.configStore.get<FrozenLastVerify>(LAST_VERIFY_KEY);
    if (!old) return;
    const orgId = this.orgOfOldVerify(old);
    const byOrg = this.lastVerifies();
    if (orgId !== undefined && byOrg[orgId] === undefined) {
      this.deps.configStore.set(LAST_VERIFIES_KEY, { ...byOrg, [orgId]: old }, FROZEN_CATEGORY);
    }
    this.deps.configStore.delete(LAST_VERIFY_KEY);
  }

  /**
   * The verdict of the last verification of each org, the one kept for every
   * org at once given to the org it was of: read as kept, nothing moved.
   */
  private lastVerifyInfos(): FrozenLastVerifyInfo[] {
    const byOrg = { ...this.lastVerifies() };
    const old = this.deps.configStore.get<FrozenLastVerify>(LAST_VERIFY_KEY);
    const oldOrg = old ? this.orgOfOldVerify(old) : undefined;
    if (old && oldOrg !== undefined && byOrg[oldOrg] === undefined) byOrg[oldOrg] = old;
    return Object.entries(byOrg).map(([orgId, verify]) => ({
      orgId,
      status: verify.status,
      measuredAt: verify.measuredAt,
    }));
  }

  /** The pointers of the last load into each org, by its registered id. */
  private lastRuns(): Record<string, FrozenLastRun> {
    return this.deps.configStore.get<Record<string, FrozenLastRun>>(LAST_RUNS_KEY) ?? {};
  }

  /**
   * The pointers of the last load into `orgId`: kept per org, or the last
   * load of before when it went to that org.
   */
  private lastRunOf(orgId: string): FrozenLastRun | undefined {
    const own = this.lastRuns()[orgId];
    if (own) return own;
    const last = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    return last?.targetOrgId === orgId ? last : undefined;
  }

  /**
   * The last load into each org, as {@link lastRunOf} finds it: the page
   * offers to verify only an org one went into, the verification's own
   * refusal standing behind it.
   */
  private lastLoadInfos(): FrozenStatusInfo['lastLoads'] {
    const byOrg = { ...this.lastRuns() };
    const last = this.deps.configStore.get<FrozenLastRun>(LAST_RUN_KEY);
    if (last && byOrg[last.targetOrgId] === undefined) byOrg[last.targetOrgId] = last;
    return Object.values(byOrg).map((run) => ({
      status: run.status,
      orgId: run.targetOrgId,
      at: run.at,
    }));
  }

  // ── frozen:load:preview ────────────────────────────────────────────────

  /**
   * What a load into the target with the same options would do, read before
   * anything is written: see {@link FrozenDatasetLoader.planLoad}. It reads
   * the dataset, the sas and the target as the load does before its first
   * write — the entry guards included, so a target the load would refuse is
   * refused here, saying why — and writes nothing: the loader it builds holds
   * a writer that refuses every write. No run is started, nothing goes into
   * the audit trail, and Production Guard, which judges writes, is not asked.
   */
  private async handlePreview(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenLoadPayloadSchema,
      msg,
      'frozen:load:preview:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:load:preview:error');
    if (!config) return;
    const notReplaced = await this.replaceRefusal(parsed, config);
    if (notReplaced) {
      sendHandlerError(
        this.deps,
        'frozen:load:preview',
        'frozen:load:preview:error',
        msg,
        notReplaced.error,
        { code: notReplaced.code, retryable: notReplaced.retryable },
      );
      return;
    }
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const datasetDir = guard.assertOutsideRepo(this.resolveDatasetDir(config));
      const { dataset, manifest } = await this.readFrozenDataset(datasetDir, guard);
      const orgAccess = this.buildTargetOrgAccess();
      const conn = await getJsforceConnection(
        parsed.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetClock = removalOrg(conn, 'frozen:load:preview');
      const loader = new FrozenDatasetLoader({
        orgAccess,
        writer: PREVIEW_WRITER,
        guard: this.deps.infraServices?.productionGuard ?? new ProductionGuard(),
        mockDetector: config.mockDetection
          ? new CustomMetadataCalloutMockDetector(orgAccess, config.mockDetection)
          : { areCalloutsMocked: async (): Promise<boolean> => true },
        recordTypeResolver: new TargetRecordTypeIdResolver(orgAccess),
        mappingStore: this.mappingStoreFor(sasDir, parsed.targetOrgId, guard),
        config: this.toLoadConfig(config),
        sasGuard: guard,
        serverTime: () => targetClock.serverTime(),
        // What it cannot evaluate, listed beside what it would insert: the
        // target's validation rules, read as Forge's pre-flight and Sync's
        // simulation read them.
        readValidationRules: async (objectApiNames) => {
          const { toolingQueriesOver, toolingValidationRules } =
            await import('../../modules/forge/TargetGapReader.js');
          const { toolingRetrievesOver } =
            await import('../../modules/forge/TargetAutomationReader.js');
          const tooling = conn.tooling;
          // Each rule with the field it shows its error on by its API name,
          // read back from the label a French org answers; and its formula,
          // retrieved 25 a request, so a rule that refuses only a change of a
          // record is left out of what may refuse an insert.
          return toolingValidationRules(
            async (soql) =>
              (
                await queryAllPages<Record<string, unknown>>(
                  {
                    query: async (q) => tooling.query<Record<string, unknown>>(q),
                    queryMore: async (url) => tooling.queryMore<Record<string, unknown>>(url),
                  },
                  soql,
                )
              ).records,
            toolingQueriesOver(conn),
            toolingRetrievesOver(conn),
          )(objectApiNames);
        },
      });
      const plan = await loader.planLoad({
        orgId: parsed.targetOrgId,
        orgTier: this.targetTier(parsed.targetOrgId),
        dataset,
        manifest,
        sasDir,
        reload: parsed.reload,
        pilot: parsed.pilot ? {} : undefined,
        ...(parsed.writeEncrypted ? { writeEncrypted: true } : {}),
      });
      // Asked for the checkpoint first, the preview says what it would hold
      // and cost, and the refusal a load would meet: Frozen has no question
      // of its own before it writes, and the checkpoint's cost is that of the
      // target's tables, said here before the load is started. Nothing is
      // taken, nothing assigned.
      const checkpoint =
        parsed.checkpointFirst !== undefined
          ? await this.previewCheckpoint({
              msg,
              orgId: parsed.targetOrgId,
              written: dataset.objects.map((object) => object.objectApiName),
              request: parsed.checkpointFirst,
              muteAutomation: parsed.muteAutomation === true,
              conn,
            })
          : undefined;
      // What the load's gate would make of the emails of what still runs,
      // read as it reads them — the mute planned when asked, nothing
      // assigned — and the refusal it would meet: a dry run that let by what
      // its load then refused would have a plan apply what it cannot.
      const emails = await this.previewEmails({
        conn,
        orgId: parsed.targetOrgId,
        dataset,
        store: this.mappingStoreFor(sasDir, parsed.targetOrgId, guard),
        config,
        parsed,
      });
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:load:preview:response', {
          plan: {
            ...plan,
            ...(checkpoint ? { checkpoint } : {}),
            ...(emails ? { emails } : {}),
          },
        }),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:load:preview', 'frozen:load:preview:error', msg, err, {
        code: this.errorCodeFor(err, 'PREVIEW_ERROR'),
        retryable: err instanceof TimeoutError,
        extraPayload: this.errorDetailOf(err),
      });
    }
  }

  /**
   * The emails of a load's preview, judged as the load judges them before its
   * first write: what the target runs on what it would insert, and on what a
   * reload's purge would delete; the mute planned when it is asked, nothing
   * assigned. Undefined, said in the log, when they could not be judged.
   */
  private async previewEmails(input: {
    conn: LimitsTransport & Parameters<typeof muteOrgOf>[0];
    orgId: string;
    dataset: FrozenDataset;
    store: SasReferenceIdMappingStore;
    config: FrozenProjectConfig;
    parsed: { reload?: boolean; pilot?: boolean; muteAutomation?: boolean; acceptEmails?: boolean };
  }): Promise<FrozenLoadEmailsInfo | undefined> {
    const { parsed } = input;
    try {
      const purge =
        parsed.reload === true && !parsed.pilot
          ? await this.purgeStepsOf(input.store, input.config)
          : undefined;
      const purgeWrites = purge ? removalStepsWrites(purge) : undefined;
      const writes = (object: string, write: ForgeAutomationWrite): boolean =>
        LOAD_WRITES(object, write) || purgeWrites?.(object, write) === true;
      const read = await this.targetAutomation
        .read(input.orgId, [
          ...new Set([
            ...input.dataset.objects.map((object) => object.objectApiName),
            ...(purge?.delete ?? []),
          ]),
        ])
        .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
      const mute =
        parsed.muteAutomation === true
          ? await muteForRun(async () => muteOrgOf(input.conn), read, {
              ...this.muteLeases,
              writes,
            }).catch(() => undefined)
          : undefined;
      const emails = await this.loadEmailsFor({
        conn: input.conn,
        orgId: input.orgId,
        orgTier: this.targetTier(input.orgId),
        read,
        ...(mute?.plan ? { plan: mute.plan } : {}),
        writes,
        dataset: input.dataset,
        accepted: parsed.acceptEmails === true,
        mayMute: parsed.muteAutomation !== true,
      });
      return saysSomething(emails.info) ? emails.info : undefined;
    } catch (err: unknown) {
      logger.warn(`Frozen preview: the emails could not be judged (${extractErrorMessage(err)})`);
      return undefined;
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
    // The last load into the org asked about: a load into another org since
    // leaves it its contract, its mapping and its dataset.
    const lastRun = this.lastRunOf(parsed.targetOrgId);
    if (!lastRun) {
      sendHandlerError(
        this.deps,
        'frozen:verify',
        'frozen:verify:error',
        msg,
        new Error(
          'No load into this org is recorded — run a load (frozen:load) into it before verifying.',
        ),
        { code: 'NO_LOAD' },
      );
      return;
    }

    const throttledProgress = throttleProgress((event: FrozenLoadProgressEvent) => {
      const progressMsg = buildResponse(this.deps, msg, 'frozen:load:progress', { ...event });
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      // The sas first: the last load's contract is in the sas it wrote to,
      // and still there unless that sas was moved, emptied or replaced. With
      // `sasDir` set to another since, every refusal below described that
      // other sas's mapping — a refresh, a removal, no mapping at all — and a
      // sas moved there rather than copied ended on the contract it took with
      // it, as a file that could not be read. Told by its folder: a load
      // recorded when the sas kept one contract for every org names that one.
      const sasChanged =
        path.dirname(lastRun.contractPath) !==
        path.dirname(countingContractPath(guard, sasDir, parsed.targetOrgId));
      const contractThere = await pathExists(lastRun.contractPath);
      if (sasChanged || !contractThere) {
        const loadSas = path.dirname(lastRun.contractPath);
        let message: string;
        if (!sasChanged) {
          message = `The sas changed since the last load: ${sasDir} no longer holds the counting contract the last load wrote there. Load the dataset again, then verify.`;
        } else if (contractThere) {
          message = `The sas directory changed since the last load: its counting contract is in ${loadSas}, and the mapping read is the one in ${sasDir}. Set sasDir back to the sas the load wrote to, or load the dataset again, then verify.`;
        } else {
          message = `The sas directory changed since the last load: the load wrote to ${loadSas}, which no longer holds its counting contract, and the mapping read is the one in ${sasDir}. Move the sas back to ${loadSas} and set sasDir to it, or load the dataset again, then verify.`;
        }
        // With the folders, for the panel to say the same in its words.
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(message),
          {
            code: 'SAS_CHANGED',
            extraPayload: { sasDir, loadSas, sasMoved: sasChanged, contractThere },
          },
        );
        return;
      }
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
      // would blame the load. A removal that left some took only part of it:
      // said as gone, the load read as removed whole, and loaded again
      // without Reload, the dataset would go in beside what the removal left.
      const last = await mappingStore.recorded();
      const removed = last?.removal;
      if (last && removed) {
        const left = loadRecordsLeft(last).reduce((sum, object) => sum + object.ids.length, 0);
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            left > 0
              ? `The removal of ${removed.removedAt} took part of the records the last load created and left ${left} in the org: a verification would read the ones it took as missing. Remove what is left, or reload the dataset, which purges or finds it again; then verify.`
              : `The records the last load created were removed on ${removed.removedAt}. Load the dataset again, then verify.`,
          ),
          { code: 'LOAD_REMOVED', extraPayload: { left } },
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
      //
      // What to do names the reload and the removal, which the panel and the
      // command line both offer. It said to load the dataset again, and a load
      // that is not a reload writes it again beside what the stopped load
      // wrote, which stays in the org.
      if (!contractCountsLoad(readCountingContract(guard, lastRun.contractPath), last)) {
        sendHandlerError(
          this.deps,
          'frozen:verify',
          'frozen:verify:error',
          msg,
          new Error(
            'The last load stopped part way — it was cancelled, or failed once it had written — and wrote no counting contract: the one in the sas counts an earlier load, and would judge this one by it. Reload the dataset, which purges or finds again what the stopped load wrote, or remove that load before loading the dataset again; then verify. Loaded again without a reload, the dataset would go in beside what the stopped load wrote.',
          ),
          { code: 'LOAD_STOPPED' },
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
      this.recordLastVerify(args.orgId, {
        status: verdict.status,
        measuredAt: verdict.measuredAt,
      });
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
   * goes. A removal that left some of them in the org — kept, or refused —
   * is followed by one of what it left. Once the last load's records all
   * went, or when it created none, the load removed is the newest one before
   * it whose records the loads after it left in the org: see
   * {@link loadToRemove}.
   *
   * Refused before anything is read from the org when no load wrote a mapping,
   * when the mapping holds another load than the one confirmed, predates loads
   * keeping what they created, had its records all removed already, holds
   * nothing created, or is being removed now. A sweep asked of a load whose
   * records all went runs alone, as of a Forge run: asked again after a removal
   * whose sweep alone failed, it was refused as nothing to do, what that sweep
   * was to take still in the org. Then Production Guard judges the
   * delete — a production org is refused, a missing guard refuses too — the
   * target is asked whether it is still the org the load wrote to, and Forge's
   * removal runs: children before their parents, what records staying in the
   * org depend on kept, what changed since the load kept unless included. What
   * the target runs as they go is listed by the confirmation, from
   * `frozen:remove:automation`; asked to mute it, the removal reads it again on
   * what it and its sweep delete, and holds the lease from before its first
   * delete to its end. It
   * runs on the registry and in Live Operations, under the id of the request,
   * where Cancel — Live Operations' or the removal card's — stops it before
   * its next call to the org. The audit trail records it whatever the outcome;
   * the mapping forgets the records that went, keeps what the removal left on
   * the others for the next one, and is marked once records went, so the
   * removal is not offered again once none is left.
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
    let recorded: RecordedLoad[];
    let load: RecordedLoad | undefined;
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      store = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      recorded = await store.recordedLoads();
      load = loadToRemove(recorded);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, err, {
        code: this.errorCodeFor(err, 'REMOVE_ERROR'),
      });
      return;
    }
    const refused = removalRefusalOf(load, parsed);
    const sweepAlone = parsed.sweep === true && refused?.code === 'ALREADY_REMOVED';
    if ((refused && !sweepAlone) || !load) {
      if (refused) refuse(refused.message, refused.code);
      return;
    }
    // What an earlier removal left, when one did: a removal that ended
    // partial marked the load, and the next one was refused as done already
    // while the status still counted the records it left.
    const plan = loadRecordsLeft(load);
    const claim = store.filePath;
    if (this.removing.has(claim)) {
      refuse('The records of this load are being removed already.', 'DUPLICATE');
      return;
    }
    // Claimed before Production Guard is consulted: its confirmation waits on
    // a person, and a second click meanwhile would ask, and remove, twice.
    this.removing.add(claim);
    // Held as long, under the id the removal will run under: the card offers
    // Cancel as soon as it asks, and a cancel sent while the guard asked was
    // refused as a removal not found — which then ran once confirmed.
    const pending = this.registry?.holdUntilStart(msg.id);
    try {
      await this.removeLoad(msg, {
        store,
        load,
        plan,
        includeChanged: parsed.includeChanged === true,
        sweep: parsed.sweep === true,
        sweepLate: parsed.sweep === true && parsed.sweepLate === true,
        sweepUntied: parsed.sweep === true && parsed.sweepUntied === true,
        alongside: parsed.sweep === true ? loadsSweptWith(recorded, load) : [],
        muteAutomation: parsed.muteAutomation === true,
        pending,
      });
    } finally {
      this.removing.delete(claim);
      pending?.release();
    }
  }

  // ── frozen:remove:automation ───────────────────────────────────────────

  /**
   * What the target runs as a removal of the load takes its records back, for
   * the confirmation to list before the user types the org's name, and for the
   * command line's `--preview`: on the objects each step of the removal writes,
   * and those a sweep ticked with it deletes, which the page names as its list
   * reads them. Refused, before the org is read, as the removal is. Read only.
   *
   * A removal deletes, and the target runs what fires on a delete: a Frozen
   * removal read nothing of it, and its flows ran with no question and no way
   * to keep them quiet, where Forge's, Sync's and Seed's list them and offer the
   * box that mutes them. So does a reload's purge, asked with `reload`: read
   * for what every load before it left, and what names one load does not refuse it.
   */
  private async handleRemoveAutomation(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenRemoveAutomationPayloadSchema,
      msg,
      'frozen:remove:automation:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:remove:automation:error');
    if (!config) return;
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const store = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      let steps: ForgeRemovalSteps;
      /** The purge's own steps, said apart from what the reload's sweep deletes. */
      let purge: ForgeRemovalSteps | undefined;
      if (parsed.reload === true) {
        // What a sweep asked with the reload takes is deleted around the
        // purge, and fires as much.
        steps = await this.purgeStepsOf(store, config, parsed.sweptObjects ?? []);
        if ((parsed.sweptObjects ?? []).length > 0) purge = await this.purgeStepsOf(store, config);
      } else {
        const load = loadToRemove(await store.recordedLoads());
        const refused = removalRefusalOf(load, parsed);
        // What a sweep alone deletes fires as much as what goes with a removal.
        const sweepAlone = parsed.sweptObjects !== undefined && refused?.code === 'ALREADY_REMOVED';
        if ((refused && !sweepAlone) || !load) {
          if (refused) {
            sendHandlerError(
              this.deps,
              'frozen:remove:automation',
              'frozen:remove:automation:error',
              msg,
              new Error(refused.message),
              { code: refused.code },
            );
          }
          return;
        }
        steps = removalStepsOfLoad(loadRecordsLeft(load), parsed.sweptObjects ?? []);
      }
      const reader = this.targetAutomation;
      const automation = await new TimeoutManager(SWEEP_AUTOMATION_TIMEOUT_MS).withTimeout(
        'frozen:remove:automation',
        () => reader.read(parsed.targetOrgId, steps.delete ?? []),
      );
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:remove:automation:response', {
          loadedAt: parsed.loadedAt,
          automation,
          steps,
          ...(purge ? { purge } : {}),
        }),
      );
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'frozen:remove:automation',
        'frozen:remove:automation:error',
        msg,
        err,
        {
          code:
            err instanceof TimeoutError ? 'TIMEOUT' : this.errorCodeFor(err, 'AUTOMATION_ERROR'),
          retryable: true,
        },
      );
    }
  }

  /**
   * What a reload's purge writes, step by step: what every load recorded into
   * the org left for a removal. What the configuration has it deactivate is no
   * delete. What the reload finds again by its keys it does not delete either,
   * which is known only once it has read the target: said here, it is said of
   * an object the purge may spare. A target refreshed since took those records
   * with it, and leaves a sweep nothing to take.
   *
   * @param swept - The objects a sweep asked with the reload deletes records of.
   */
  private async purgeStepsOf(
    store: SasReferenceIdMappingStore,
    config: FrozenProjectConfig,
    swept: readonly string[] = [],
  ): Promise<ForgeRemovalSteps> {
    if (await store.isStale()) return removalStepsOfLoad([], []);
    const deactivated = config.undeletableObjects ?? {};
    const left = (await store.recordedLoads())
      .flatMap((load) => loadRecordsLeft(load))
      .filter(({ objectApiName }) => !Object.hasOwn(deactivated, objectApiName));
    return removalStepsOfLoad(left, swept);
  }

  // ── frozen:remove:preview ──────────────────────────────────────────────

  /**
   * What a removal of the load would do, read as {@link handleRemove} reads
   * it before its first write, and nothing written, to the org or to the sas:
   * refused first, before the org is read, as the removal is — no load
   * recorded, another load since the one named, one recorded before loads
   * kept what they created, none of its records left to take — then Forge's
   * removal, stopped before its first write (`RunRemovalOptions.previewOnly`),
   * per object. Nothing is asked: Production Guard is not consulted for a
   * confirmation, and what it would refuse is said among the refusals, with a
   * target refreshed since the load, which a removal refuses too. No run is
   * started, the sweep is not read, and nothing goes into the audit trail.
   */
  private async handleRemovePreview(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenRemovePreviewPayloadSchema,
      msg,
      'frozen:remove:preview:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:remove:preview:error');
    if (!config) return;
    const fail = (err: unknown, code: string, retryable = false): void =>
      sendHandlerError(
        this.deps,
        'frozen:remove:preview',
        'frozen:remove:preview:error',
        msg,
        err,
        {
          code,
          retryable,
        },
      );
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const store = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      const load = loadToRemove(await store.recordedLoads());
      const refused = removalRefusalOf(load, parsed);
      if (refused || !load) {
        if (refused) fail(new Error(refused.message), refused.code);
        return;
      }
      const planned = loadRecordsLeft(load).reduce((sum, object) => sum + object.ids.length, 0);
      const refusals = this.removalGuardRefusals(load.orgId, planned);
      let preview: Omit<FrozenRemovalPreview, 'refusals'>;
      if (await store.isStale()) {
        // Its records went with the refresh: a removal reads none of them.
        refusals.push({
          code: 'TARGET_REFRESHED',
          message:
            'The target org was refreshed after the load: the records it created went with the refresh, and a removal removes nothing.',
        });
        preview = { ...this.unreadPreviewOf(load, parsed.includeChanged === true), planned };
      } else {
        const conn = await getJsforceConnection(
          load.orgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        );
        preview = await this.previewRemovalOf(conn, load, parsed.includeChanged === true);
      }
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:remove:preview:response', {
          preview: {
            ...preview,
            refusals: refusals.map(({ message }) => message),
            refusalCodes: refusals.map(({ code }) => code),
          },
        }),
      );
    } catch (err: unknown) {
      fail(err, this.errorCodeFor(err, 'REMOVE_PREVIEW_ERROR'), true);
    }
  }

  /**
   * What Production Guard would refuse a removal of `planned` records of the
   * load for, asked without a confirmation, under the code the removal is
   * refused with: nothing for a sandbox or a Developer Edition org, the
   * delete of a production org refused, and without the guard, everything.
   * A delete it would ask about, of a production org whose override lets it
   * through, is declined where the question is answered no without anyone
   * asked — a command line's —, as the removal then ends `GUARD_DECLINED`:
   * the preview said nothing of it.
   */
  private removalGuardRefusals(
    orgId: string,
    planned: number,
  ): Array<{ code: string; message: string }> {
    const productionGuard = this.deps.infraServices?.productionGuard;
    if (!productionGuard) return [{ ...PRODUCTION_GUARD_MISSING }];
    const orgTier = this.targetTier(orgId);
    const check = productionGuard.check({
      orgId,
      orgTier,
      operation: 'delete',
      objectName: 'the records a Frozen load created',
      recordCount: planned,
      module: 'frozen',
    });
    if (!check.allowed) {
      return [
        {
          code: 'GUARD_BLOCKED',
          message: `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
        },
      ];
    }
    const declined = productionGuard.declinedWithoutAsking(check, orgTier);
    return declined === undefined
      ? []
      : [
          {
            code: 'GUARD_DECLINED',
            message:
              `Production Guard asks before this delete, and its question is answered no: ` +
              `${declined} (${check.impactSummary}). Nothing would be deleted.`,
          },
        ];
  }

  /**
   * What a removal of `load` would do, read before its first write and
   * nothing written: Forge's removal of the records the mapping says the load
   * created and no removal took yet, stopped before its first write, dated as
   * the removal dates the load (`removalSpanOf`).
   */
  private async previewRemovalOf(
    conn: Awaited<ReturnType<typeof getJsforceConnection>>,
    load: RecordedLoad,
    includeChanged: boolean,
  ): Promise<Omit<FrozenRemovalPreview, 'refusals'>> {
    const plan = loadRecordsLeft(load);
    const outcome = await removeRunRecords(removalOrg(conn, 'frozen:remove:preview'), plan, {
      ...removalSpanOf(load),
      includeChanged,
      previewOnly: true,
    });
    if (!outcome.preview) throw new Error('The removal preview stopped before it was through.');
    return {
      ...this.unreadPreviewOf(load, includeChanged),
      planned: plan.reduce((sum, object) => sum + object.ids.length, 0),
      objects: outcome.preview.objects.map((object): FrozenRemovalPreview['objects'][number] => ({
        objectApiName: object.objectApiName,
        planned: object.planned,
        toDelete: object.toDelete,
        alreadyGone: object.alreadyGone,
        changedSince: object.changedSince,
        keptChanged: object.keptChanged,
        changedBy: object.changedBy,
        undeletable: object.undeletable,
        notVisible: object.notVisible,
        unread: object.unread,
        reasons: object.reasons,
      })),
      userNames: outcome.preview.userNames,
    };
  }

  /** A preview of the load's removal with nothing read of the org: its load, and what stays. */
  private unreadPreviewOf(
    load: RecordedLoad,
    includeChanged: boolean,
  ): Omit<FrozenRemovalPreview, 'refusals'> {
    const keptByThePlatform = loadRecordsKept(load);
    return {
      loadedAt: load.endedAt,
      includeChanged,
      planned: 0,
      objects: [],
      userNames: {},
      ...(load.removal ? { leftBy: load.removal.removedAt } : {}),
      ...(keptByThePlatform.length > 0 ? { keptByThePlatform } : {}),
    };
  }

  /**
   * Why a reload, which replaces the loads before it, may not start, or
   * undefined when it may: a removal of them would leave records in the org —
   * kept as changed since the load, of an object the user may not delete, out
   * of the user's sight, unread — or one of them was recorded before loads
   * kept what they created: loaded again beside what they leave, the dataset
   * would stand in the target twice, and the reload's purge would delete what
   * someone changed since, which the removal keeps. Read with the removal's
   * own preview of each load whose records are still to take, before
   * anything is written. The panel's Reload is asked as the command line's
   * is: it sent a reload alone, which purged without a word the records
   * someone had changed since the load. A load that is no reload, a pilot,
   * which purges nothing, and a target refreshed since its loads, which took
   * their records, are not asked.
   *
   * @returns The refusal, under {@link REPLACE_LEAVES_RECORDS}; or the failure
   *   of the reads that would tell, which refuses the request too.
   */
  private async replaceRefusal(
    request: { targetOrgId: string; reload?: boolean; pilot?: boolean },
    config: FrozenProjectConfig,
  ): Promise<{ error: unknown; code: string; retryable: boolean } | undefined> {
    if (request.reload !== true || request.pilot === true) return undefined;
    let refusal: string | undefined;
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const store = this.mappingStoreFor(sasDir, request.targetOrgId, guard);
      const loads = await store.recordedLoads();
      if (loads.length === 0 || (await store.isStale())) return undefined;
      if (loads.some((load) => !load.created)) {
        refusal =
          'A load recorded before loads kept what they created is in this sas: which of its records it created cannot be told, and a reload leaves in place those it may have linked, so it would not replace that load whole. Nothing was written.';
      } else {
        const conn = await getJsforceConnection(
          request.targetOrgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        );
        const previews: Array<Omit<FrozenRemovalPreview, 'refusals'>> = [];
        for (const load of loads) {
          if (loadRecordsLeft(load).length === 0) continue;
          previews.push(await this.previewRemovalOf(conn, load, false));
        }
        const left = leftByRemovalOf(previews);
        if (left.length > 0) {
          const total = left.reduce((sum, object) => sum + object.left, 0);
          refusal =
            `A removal of the loads this reload replaces would leave ${total} of their records in ` +
            `the org — ${left.map((o) => `${o.objectApiName} (${o.left}: ${o.why.join(', ')})`).join('; ')}: ` +
            'loaded again, the dataset would stand beside them, and the reload would delete what ' +
            'was changed since. Nothing was written. Take the load back first with a removal — ' +
            'records changed since go too when it is told to include them — then load the ' +
            'dataset again.';
        }
      }
    } catch (err: unknown) {
      return { error: err, code: this.errorCodeFor(err, 'LOAD_ERROR'), retryable: true };
    }
    return refusal === undefined
      ? undefined
      : { error: new Error(refusal), code: REPLACE_LEAVES_RECORDS, retryable: false };
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
      /** Sweep what the target's automation made for the load, around its records: see `sweepOfRemoval`. */
      sweep: boolean;
      /** With the sweep, take too what it lists as made late, or tied to nothing of the load. */
      sweepLate?: boolean;
      sweepUntied?: boolean;
      /**
       * With the sweep, the other loads it sweeps around the load's records,
       * each as its removal would: see `loadsSweptWith`.
       */
      alongside: readonly RecordedLoad[];
      /** Mute what it fires, what its sweep deletes included, through the target's own bypass. */
      muteAutomation: boolean;
      /** The hold a cancel of the removal before it started reaches. */
      pending?: PendingStart;
    },
  ): Promise<void> {
    const { store, load, plan, includeChanged, sweep, pending } = args;
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
    // A sweep alone deletes none of the load's records: Production Guard
    // judges its deletes once it has found them.
    const { check, decision } =
      total > 0
        ? await consultProductionGuard(productionGuard, {
            orgId,
            // The tier the load took the org for: a Developer Edition org it may
            // load into is one it may take its records back from, as for Forge.
            orgTier: this.targetTier(orgId),
            operation: 'delete',
            objectName: plan.map((o) => o.objectApiName).join(', '),
            recordCount: total,
            module: 'frozen',
          })
        : { check: undefined, decision: 'allowed' as const };
    if (check && (decision === 'refused' || decision === 'declined')) {
      // No removal started: recorded under the id of the request, which a removal runs under.
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
          new Error('Operation cancelled by user (confirmation declined).'),
          { code: 'GUARD_DECLINED', retryable: true },
        );
      }
      return;
    }
    /**
     * Whether the card's Cancel came before the removal started — while the
     * guard asked, or the target was read — in which case it does not start:
     * recorded as stopped, under the code of a run cancelled before it
     * started, and answered as a removal cancelled before it deleted anything.
     */
    const cancelledBeforeStart = (): boolean => {
      if (!pending?.signal.aborted) return false;
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId: msg.id,
        orgId,
        outcome: 'stopped',
        guard: decision,
        code: ABORTED_BEFORE_START,
      });
      const result: FrozenRemovalResult = {
        status: 'cancelled',
        includeChanged,
        objects: [],
        finishedAt: new Date().toISOString(),
      };
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:remove:response', { result, operationId: msg.id }),
      );
      return true;
    };
    if (cancelledBeforeStart()) return;

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
    if (cancelledBeforeStart()) return;

    // The id of the request that started it, as a load runs under its own:
    // the removal card knows it, and its Cancel reaches the registry's
    // controller below as Live Operations' does. Minted here, it was an id
    // the card never saw, and only Live Operations could stop the removal.
    const operationId = msg.id;
    const description =
      total > 0
        ? `Removing ${total} record(s) a Frozen load created`
        : "Sweeping what the target's automation made for a Frozen load";
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
    /** The sweep asked with the removal, in its parts around the load's records. */
    let sweeping: RemovalSweep | undefined;
    /** The sweeps of the other loads it sweeps with it, in the same parts: see `loadsSweptWith`. */
    const alongside: Array<{ loadedAt: string; sweep: RemovalSweep }> = [];
    /** What the removal muted of the target's automation, when it was asked to. */
    let mutedAutomation: MutedAutomation | undefined;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const sweptWith = new Set([load, ...args.alongside].map((swept) => swept.endedAt));
      // Made by the removal in its parts: the first once it has read the
      // load's records — a child the sweep deletes under one of them restamps
      // that record when a roll-up counts it, which read afterwards was a
      // change since the load —, what goes with them holding none of them
      // back, and the last once they are gone.
      sweeping = sweep
        ? await this.sweepOfRemoval({
            conn,
            load,
            store,
            includeChanged,
            sweepLate: args.sweepLate === true,
            sweepUntied: args.sweepUntied === true,
            signal: abortController.signal,
            guard: productionGuard,
            operationId,
            // A sweep alone has no entry of the removal's to name its mute.
            muted: () => (total === 0 ? mutedAutomation : undefined),
            sweptWith,
          })
        : undefined;
      // Each load kept for what a reload's sweep left of it is swept with this
      // one, in the same parts, as the reload sweeps every load it replaces:
      // run for real, the removal swept the last load's window alone, and the
      // tasks the reloads' sweeps had left stayed until deleted by hand.
      for (const [index, other] of (sweeping ? args.alongside : []).entries()) {
        alongside.push({
          loadedAt: other.endedAt,
          sweep: await this.sweepOfRemoval({
            conn,
            load: other,
            store,
            includeChanged,
            sweepLate: args.sweepLate === true,
            sweepUntied: args.sweepUntied === true,
            signal: abortController.signal,
            guard: productionGuard,
            // One entry per load swept, apart in the audit trail.
            operationId: `${operationId}-${index + 2}`,
            muted: () => undefined,
            sweptWith,
          }),
        });
      }
      const sweepParts = sweeping;
      const sweeps = [...(sweeping ? [sweeping] : []), ...alongside.map(({ sweep }) => sweep)];
      /** Each sweep's part in turn: whether any deleted anything. */
      const inTurn = async (part: (sweep: RemovalSweep) => Promise<boolean>): Promise<boolean> => {
        let wrote = false;
        for (const one of sweeps) if (await part(one)) wrote = true;
        return wrote;
      };
      // The sweep reads what it takes and asks Production Guard here, before
      // the lease: a person answering holds no permission set assigned. It
      // deletes at its turn, once the removal has read the load's records.
      for (const one of sweeps) await one.ask();
      // Asked to mute, or on the command line, the removal reads what its
      // deletes fire, what the sweep deletes among them, plans the mute from
      // it, and takes the lease before its first delete; it is given back as
      // the removal ends, whatever it ended on. Refused, nothing goes. The
      // panel's confirmation listed what fires before the org's name was typed:
      // what a mute silences is read here, on what the sweep really takes. A
      // stop while the sweep read asks nothing: the removal stops at its next
      // call. A sweep alone that found nothing to take fires nothing.
      let removalMute: RunMute | undefined;
      const asker = this.removalAsker;
      const steps = removalStepsOfLoad(
        plan,
        sweeps.flatMap((one) => one.takes),
      );
      if (
        (args.muteAutomation || asker) &&
        !abortController.signal.aborted &&
        (steps.delete ?? []).length > 0
      ) {
        const reader = this.targetAutomation;
        const read = await new TimeoutManager(SWEEP_AUTOMATION_TIMEOUT_MS)
          .withTimeout('frozen:remove automation', () => reader.read(orgId, steps.delete ?? []))
          .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
        if (args.muteAutomation) {
          removalMute = await muteForRun(async () => muteOrgOf(conn), read, {
            ...this.muteLeases,
            writes: removalStepsWrites(steps),
          });
        }
        const stop = await asker?.({ read, steps, mute: removalMute });
        if (stop) throw new RemovalStopped(stop);
      }
      mutedAutomation = removalMute?.muted;
      let held: HeldMute | undefined;
      // The lease, taken right before the first delete, once every question
      // is answered: the removal asks what to do of the records its user may
      // not delete after reading them, and a lease taken before it kept the
      // sets assigned while the question stayed open, for nothing once it was
      // answered no. A stop before then assigns nothing.
      const takeLease = async (): Promise<void> => {
        const prepared = removalMute?.prepared;
        if (!prepared || abortController.signal.aborted) return;
        held = await prepared.acquire(operationId);
        mutedAutomation = held.outcome;
      };
      // Nothing of the load to remove: the sweep alone, and no record of it goes.
      const sweepAlone = async (): Promise<RunRemovalOutcome> => {
        await takeLease();
        await inTurn((one) => one.first());
        await inTurn((one) => one.afterRemoval());
        return NOTHING_REMOVED;
      };
      const outcome = await (
        total === 0
          ? sweepAlone()
          : removeRunRecords(removalOrg(conn, 'frozen:remove'), plan, {
              ...removalSpanOf(load),
              ...(sweepParts
                ? {
                    sweep: () => inTurn((one) => one.first()),
                    afterRemoval: () => inTurn((one) => one.afterRemoval()),
                    // The other loads' records all went: what their sweeps
                    // take holds none of this one's back.
                    automationMade: sweepParts.automationMade,
                  }
                : {}),
              onUndeletable: undeletableAsker(this.deps, orgId, 'frozen:remove'),
              beforeFirstWrite: takeLease,
              includeChanged,
              signal: abortController.signal,
              onProgress: (settled, of, objectApiName) => {
                const percent = Math.min(100, Math.round((settled / Math.max(of, 1)) * 100));
                sendOperationProgress(this.deps, operationId, percent, settled, of, objectApiName);
                // A removal cancelled from Live Operations finishes its call to the
                // org; the registry has recorded the stop and hears no more of it.
                if (!abortController.signal.aborted) {
                  this.registry?.updateProgress(operationId, percent);
                }
                this.liveTracker?.updateProgress(operationId, percent, settled, of, objectApiName);
              },
            })
      ).finally(async () => {
        if (held) mutedAutomation = await held.release();
      });
      // What the sweep did, in all its parts, recorded beside the removal.
      const sweepResult = await sweeping?.settle();
      const otherLoadSweeps = await this.settleReloadSweeps(alongside);
      // A removal after one that marked the load takes what that one left:
      // the result and the audit trail say so, with when it ended.
      const leftBy = load.removal?.removedAt;
      // What the load created that the platform does not delete was never
      // sent: said as kept, never counted as refused. Sent, the business
      // hours of a load were refused, and the removal ended partial.
      const keptByThePlatform = loadRecordsKept(load);
      // The sweep has its own entry in the audit trail: this one says what
      // became of the load's records.
      const ownStatus = removalStatus(outcome.objects, outcome.cancelled);
      const result: FrozenRemovalResult = {
        // A sweep of another load that did not take all it was asked to ends
        // it partial, as its own sweep does.
        status: otherLoadSweeps.reduce(
          (status, swept) => removalStatusWithSweep(status, swept.result),
          removalStatusWithSweep(ownStatus, sweepResult),
        ),
        includeChanged,
        objects: outcome.objects,
        finishedAt: new Date().toISOString(),
        ...(leftBy ? { leftBy } : {}),
        ...(sweepResult ? { sweep: sweepResult } : {}),
        ...(otherLoadSweeps.length > 0 ? { otherLoadSweeps } : {}),
        ...(keptByThePlatform.length > 0 ? { keptByThePlatform } : {}),
        ...(mutedAutomation ? { mutedAutomation } : {}),
      };

      // A sweep alone removed none of the load's records: its own entry says what it did.
      if (total > 0) {
        recordWriteRun(this.deps, {
          action: 'cleanup_delete',
          module: 'frozen',
          operationId,
          orgId,
          outcome: removalAuditOutcome({ status: ownStatus }),
          guard: decision,
          objects: removalAuditObjects(result.objects),
          ...(leftBy ? { leftBy } : {}),
          ...(mutedAutomation ? { muted: auditMutedOf(mutedAutomation) } : {}),
        });
      }

      // The mapping forgets what went, keeps what the removal left on the
      // rest and when it ran, which the next removal reads as its doing, and
      // is marked once records went, cancelled or not, adding to what the
      // removals before it took. A removal that left records in the org —
      // kept, refused, or not reached before a cancel — is offered again for
      // those; so is one that took nothing.
      const mark = removalMark(result, total, load.removal);
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
      // The loads before it that a sweep took all it found of go, once they
      // name none of their records, as a reload lets them go; the others stay
      // for the next sweep.
      const took = [
        ...(sweepResult && sweepTookAll(sweepResult) ? [load.endedAt] : []),
        ...otherLoadSweeps
          .filter((swept) => sweepTookAll(swept.result))
          .map((swept) => swept.loadedAt),
      ];
      await store.letSweptGo(took).catch(() => false);

      const response = buildResponse(this.deps, msg, 'frozen:remove:response', {
        result,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      // A sweep alone ends as the sweep did, or as the first of the others'
      // that left what it was to take.
      const sweptLeft = [sweepResult, ...otherLoadSweeps.map((swept) => swept.result)].find(
        (swept) => swept !== undefined && swept.status !== 'success',
      );
      const failed =
        result.status === 'failure'
          ? 'No record this load created could be removed.'
          : total === 0 && sweptLeft
            ? (sweptLeft.refusal ?? 'The sweep left records in the org.')
            : undefined;
      if (
        result.status === 'cancelled' ||
        sweepResult?.status === 'cancelled' ||
        otherLoadSweeps.some((swept) => swept.result.status === 'cancelled')
      ) {
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
      } else {
        sendOperationCompleted(this.deps, operationId, {
          status: failed && total === 0 ? 'failure' : result.status,
        });
        if (failed) {
          runError = new Error(failed);
          this.liveTracker?.fail(operationId, failed);
        } else if (result.status === 'partial') {
          this.liveTracker?.partial(operationId);
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
    } catch (error: unknown) {
      runError = error;
      // What the sweep deleted before the removal threw is recorded all the same.
      await sweeping?.settle().catch(() => undefined);
      for (const { sweep: other } of alongside) await other.settle().catch(() => undefined);
      // A mute refused, a lease that could not be taken, or what the command
      // line's question stopped: before the first delete.
      const stopped =
        isMuteRefusedError(error) || error instanceof RemovalStopped ? error : undefined;
      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'frozen',
        operationId,
        orgId,
        outcome: stopped ? 'stopped' : 'failure',
        guard: decision,
        ...(stopped ? { code: stopped.code } : {}),
      });
      sendHandlerError(this.deps, 'frozen:remove', 'frozen:remove:error', msg, error, {
        code: stopped?.code ?? 'REMOVE_ERROR',
        retryable: true,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      this.liveTracker?.fail(operationId, extractErrorMessage(error));
    } finally {
      settle(runError);
    }
  }

  /**
   * The sweep asked with a reload: one per load it replaces, as a removal of
   * that load makes it ({@link sweepOfRemoval}), in its parts around the
   * purge, each recorded in the audit trail beside the load. The purge took
   * what the loads before it created and left what the target's automation
   * made for them: run for real three times on the trap org, the tasks its
   * flow opens on each contact went from 30 to 60 to 90, and the removal that
   * followed swept the window of the last load alone. None of a target a
   * refresh took the loads' records from, nor of a load that does not say
   * what it created, which a reload refuses.
   */
  private async reloadSweepsOf(
    context: {
      conn: Parameters<typeof removalOrg>[0];
      store: SasReferenceIdMappingStore;
      signal: AbortSignal;
      guard: ProductionGuard;
      operationId: string;
    } & ReloadSweepAsked,
  ): Promise<SweepOfALoad[]> {
    if (await context.store.isStale()) return [];
    const loads = (await context.store.recordedLoads()).filter((load) => load.created);
    // Every load it replaces is swept in the same go: none is another run of the others'.
    const sweptWith = new Set(loads.map((load) => load.endedAt));
    const asked: ReloadSweepAsked = {
      includeChanged: context.includeChanged,
      sweepLate: context.sweepLate,
      sweepUntied: context.sweepUntied,
    };
    const judged = (result: ForgeSweepResult): ForgeSweepResult => reloadSweepJudged(result, asked);
    const sweeps: SweepOfALoad[] = [];
    for (const [index, load] of loads.entries()) {
      sweeps.push({
        loadedAt: load.endedAt,
        judged,
        sweep: await this.sweepOfRemoval({
          conn: context.conn,
          load,
          store: context.store,
          // The reload is refused when a removal would keep records of the
          // loads changed since; what their sweep finds changed since it
          // keeps, and says, unless asked to take it, as a removal is.
          includeChanged: context.includeChanged,
          sweepLate: context.sweepLate,
          sweepUntied: context.sweepUntied,
          signal: context.signal,
          guard: context.guard,
          // One entry per load swept, apart in the audit trail.
          operationId: index === 0 ? context.operationId : `${context.operationId}-${index + 1}`,
          // The load's own entry names its mute.
          muted: () => undefined,
          sweptWith,
          judged,
        }),
      });
    }
    return sweeps;
  }

  /**
   * What each sweep asked with a reload did, per load it replaced: recorded
   * once in the audit trail beside the load, whatever the load ended on, and
   * what it found made for its load kept for the next one while the mapping
   * still records that load.
   */
  private async settleReloadSweeps(
    sweeps: ReadonlyArray<SweepOfALoad>,
  ): Promise<FrozenReloadSweep[]> {
    const settled: FrozenReloadSweep[] = [];
    for (const { loadedAt, sweep, judged } of sweeps) {
      const result = await sweep.settle();
      settled.push({ loadedAt, result: judged ? judged(result) : result });
    }
    return settled;
  }

  /**
   * The sweep of a load's removal, in its parts around the load's records
   * (`removalSweepOf`): what the target's automation made for the load, as
   * its user, tied to what the load created, that its mapping does not hold
   * — what came late or is tied to nothing only when asked too — judged by
   * Production Guard as a delete before its first one, recorded in the audit
   * trail beside the removal as a `cleanup_delete` with a `sweep` detail,
   * whatever it ended on.
   *
   * Its first part runs before the load's records go, where Forge swept
   * after a run's: a record the automation hung under one of the load's
   * would otherwise hold it back as a record that stays. Run for real, a
   * removal kept eight appointments and seven work orders for the feed items
   * the target's automation created under them during the load.
   */
  private sweepOfRemoval(context: {
    conn: Parameters<typeof removalOrg>[0];
    load: RecordedLoad;
    store: SasReferenceIdMappingStore;
    includeChanged: boolean;
    sweepLate: boolean;
    sweepUntied: boolean;
    signal: AbortSignal;
    guard: ProductionGuard;
    operationId: string;
    /** What a sweep alone muted, which no entry of the removal's records. */
    muted: () => MutedAutomation | undefined;
    /** The loads swept in the same go, by when each wrote its last record: see `tiesOfLoad`. */
    sweptWith: ReadonlySet<string>;
    /** How the run it is asked with judges what it did: a reload's (`reloadSweepJudged`). */
    judged?: (result: ForgeSweepResult) => ForgeSweepResult;
  }): Promise<RemovalSweep> {
    const { conn, load } = context;
    return removalSweepOf({
      input: () =>
        this.sweepInputOfLoad(
          removalOrg(conn, 'frozen:remove sweep'),
          load,
          context.signal,
          context.store,
          context.sweptWith,
        ),
      org: sweepOrgOf(conn, 'frozen:remove sweep', context.signal),
      options: {
        includeChanged: context.includeChanged,
        removalSpans: load.removalSpans,
        sweepLate: context.sweepLate,
        sweepUntied: context.sweepUntied,
      },
      guard: context.guard,
      guardOf: {
        orgId: load.orgId,
        orgTier: this.targetTier(load.orgId),
        operation: 'delete',
        module: 'frozen',
      },
      onGuardDecision: (swept, guard) => {
        const result = context.judged ? context.judged(swept) : swept;
        const details = sweepAuditDetails(result, '');
        delete details.forgeId;
        const muted = context.muted();
        recordWriteRun(this.deps, {
          action: 'cleanup_delete',
          module: 'frozen',
          operationId: `${context.operationId}-sweep`,
          orgId: load.orgId,
          outcome: result.status === 'refused' ? 'stopped' : result.status,
          ...(guard ? { guard } : {}),
          ...(result.status === 'refused' ? { code: sweepRefusalCode(guard) } : {}),
          objects: sweepAuditObjects(result),
          details: { ...details, loadedAt: load.endedAt },
          ...(muted ? { muted: auditMutedOf(muted) } : {}),
        });
      },
      keepMade: async (made, late, gone) => {
        await context.store.recordMade(load.endedAt, made, late, gone);
      },
    });
  }

  /**
   * What a sweep of a load's removal is told of the load, from its mapping:
   * when the target dated its writes, what it created, every record the
   * mapping holds — created, linked or reused, never swept — and what the
   * target's automation creates as the load's objects are written, read now.
   *
   * A load the target did not date as it ended — killed part way, its
   * records read back from its journal, or whose dates could not all be read
   * then — is dated by the records it created, read back now from the org and
   * its recycle bin, from the first `CreatedDate` to the last, as a Sync or
   * Seed run is (`seedWrittenBetween`). The sweep refused it: "The target did
   * not date this run's writes", the trap's flow having opened a task on each
   * contact of a load killed under it, which no removal then took.
   */
  private async sweepInputOfLoad(
    org: Pick<RemovalOrg, 'query' | 'queryDeleted'>,
    load: RecordedLoad,
    signal?: AbortSignal,
    store?: Pick<SasReferenceIdMappingStore, 'recordedLoads'>,
    sweptWith: ReadonlySet<string> = new Set(),
  ): Promise<SweepInput> {
    const created = loadCreatedRecords(load);
    const reader = this.targetAutomation;
    let automation: ForgeTargetAutomation | { error: string };
    try {
      automation = await new TimeoutManager(SWEEP_AUTOMATION_TIMEOUT_MS).withTimeout(
        'frozen:remove sweep automation',
        () =>
          reader.read(
            load.orgId,
            created.map((object) => object.objectApiName),
          ),
      );
    } catch (err: unknown) {
      automation = { error: extractErrorMessage(err) };
    }
    const writtenBetween = load.writtenBetween ?? (await seedWrittenBetween(org, created, signal));
    // The sweep takes only what is tied to the load's records.
    const { ties, sweptAlong } = await this.tiesOfLoad(load, writtenBetween, store, sweptWith);
    const remap = new Set(
      [...load.mapping.values(), ...sweptAlong].map((recordId) => recordId.slice(0, 15)),
    );
    return withoutPlatformCopies(
      {
        writtenBetween,
        created,
        remap,
        automation: sweepAutomationOf(automation),
        ...(load.runUserId ? { runUserId: load.runUserId } : {}),
        ties,
        ...(signal ? { signal } : {}),
      },
      org,
    );
  }

  /** Where the runs of the other modules on an org are read from, for a sweep to be told of them. */
  setOtherModuleRuns(runs: OtherModuleRuns): void {
    this.otherModuleRuns = runs;
  }

  /** The Frozen loads the audit trail records into an org, whichever sas they wrote to. */
  private auditedLoadsInto(orgId: string): MarkedLoad[] {
    try {
      return auditedLoadsOf(
        new AuditTrailStore(this.deps.configStore).list({ orgId, limit: AUDIT_TRAIL_LIMIT })
          .entries,
      );
    } catch {
      return [];
    }
  }

  /** The mark of the sas the saved configuration names, its loads' (`sasMarkOf`). */
  private sasMarkInUse(): string | undefined {
    const config = this.loadConfig();
    return config ? sasMarkOf(this.resolveSasDir(config)) : undefined;
  }

  /**
   * What ties a record to the load beside its records (`SweepTies`): the
   * records of the other loads this sas recorded into the same org in its
   * window, when its first removal began, and what earlier sweeps found made
   * for it. What the load's mute kept quiet its mapping does not keep.
   *
   * A load swept in the same go (`sweptWith`) — one a reload replaces with it,
   * or one a removal sweeps beside the load it removes — is no other run: what
   * is tied to nothing in its window its own sweep takes, asked the same. Its
   * records are never swept all the same, as the load's mapping's are not
   * (`sweptAlong`). On the trap org, the reload that had replaced a load two
   * minutes later counted as another run of this machine in that load's
   * window, though their writes stood a minute apart: `--sweep-untied` was
   * refused of it at that reload and at every one after, and its thirty tasks
   * were deleted by hand.
   */
  private async tiesOfLoad(
    load: RecordedLoad,
    writtenBetween: SweepInput['writtenBetween'],
    store: Pick<SasReferenceIdMappingStore, 'recordedLoads'> | undefined,
    sweptWith: ReadonlySet<string>,
  ): Promise<{ ties: SweepTies; sweptAlong: string[] }> {
    const others: LocalRun[] = [];
    const sweptAlong: string[] = [];
    const recorded = (await store?.recordedLoads().catch(() => [])) ?? [];
    for (const other of recorded) {
      if (other.endedAt === load.endedAt || other.orgId !== load.orgId) continue;
      const ids = loadCreatedRecords(other).flatMap((object) => object.ids);
      if (sweptWith.has(other.endedAt)) {
        sweptAlong.push(...ids);
        continue;
      }
      const first = Date.parse(other.writtenBetween?.first ?? other.startedAt ?? other.endedAt);
      const last = Date.parse(other.writtenBetween?.last ?? other.endedAt);
      others.push({ ids, from: first, to: Number.isFinite(last) ? last : first });
    }
    // The runs of the other modules on the org, and a run writing to it now.
    others.push(...(await this.otherModuleRuns(load.orgId, writtenBetween).catch(() => [])));
    // The loads another sas wrote into the org, which this sas's mapping
    // does not know: the audit trail records them with the sas they wrote to.
    others.push(
      ...otherSasRunsOf(this.auditedLoadsInto(load.orgId), {
        sasMark: this.sasMarkInUse(),
        own: recorded.filter((other) => other.orgId === load.orgId),
      }),
    );
    const began = removalBeganOf(load.removalSpans);
    return {
      ties: {
        otherRuns: otherRunsInSweep(writtenBetween, others),
        ...(began ? { removalBegan: began } : {}),
        ...(load.madeEarlier ? { madeEarlier: load.madeEarlier } : {}),
        ...(load.lateEarlier ? { lateEarlier: load.lateEarlier } : {}),
      },
      sweptAlong,
    };
  }

  /**
   * Read what a sweep asked with the removal of a load would take, for the
   * removal's confirmation to list before the user types the org's name — and
   * for the command line's `--sweep-list`: per object, what the load's user
   * created during the load that its mapping does not hold, a few of each by
   * name, what could not be looked at, and why a sweep would be refused. The
   * load is named, never records. Read only.
   */
  private async handleRemoveSweep(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      frozenRemoveSweepPayloadSchema,
      msg,
      'frozen:remove:sweep:error',
      this.deps,
    );
    if (!parsed) return;
    const config = this.requireConfig(msg, 'frozen:remove:sweep:error');
    if (!config) return;
    const refuse = (message: string, code: string): void =>
      sendHandlerError(
        this.deps,
        'frozen:remove:sweep',
        'frozen:remove:sweep:error',
        msg,
        new Error(message),
        { code },
      );
    try {
      const guard = new SasPathGuard();
      const sasDir = guard.assertOutsideRepo(this.resolveSasDir(config));
      const store = this.mappingStoreFor(sasDir, parsed.targetOrgId, guard);
      if (parsed.reload === true) {
        await this.listReloadSweeps(msg, store, parsed);
        return;
      }
      const recorded = await store.recordedLoads();
      const load = loadToRemove(recorded);
      if (!load) {
        refuse(
          'No load into this org was recorded in this sas: there is nothing to sweep.',
          'NO_LOAD',
        );
        return;
      }
      if (load.orgId !== parsed.targetOrgId || load.endedAt !== parsed.loadedAt) {
        refuse(
          'Another load was recorded since this one was shown: check what a removal takes now.',
          'LOAD_CHANGED',
        );
        return;
      }
      // What the removal's sweep takes for each other load it sweeps with
      // this one, listed as that load's own (`loadsSweptWith`).
      const alongside = loadsSweptWith(recorded, load);
      const sweptWith = new Set([load, ...alongside].map((swept) => swept.endedAt));
      const { listing, otherLoads } = await new TimeoutManager(SWEEP_LIST_TIMEOUT_MS).withTimeout(
        'frozen:remove:sweep',
        async () => {
          const conn = await getJsforceConnection(
            load.orgId,
            this.deps.orgRegistry,
            this.deps.orgManager,
          );
          const org = sweepOrgOf(conn, 'frozen:remove:sweep');
          const listOf = async (swept: RecordedLoad): Promise<ForgeSweepListing> =>
            listSweep(
              org,
              await this.sweepInputOfLoad(org, swept, undefined, store, sweptWith),
              swept.removalSpans,
            );
          const others: FrozenReloadSweepListing[] = [];
          for (const other of alongside) {
            others.push({ loadedAt: other.endedAt, listing: await listOf(other) });
          }
          return { listing: await listOf(load), otherLoads: others };
        },
      );
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'frozen:remove:sweep:response', {
          loadedAt: load.endedAt,
          listing,
          ...(otherLoads.length > 0 ? { otherLoads } : {}),
        }),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'frozen:remove:sweep', 'frozen:remove:sweep:error', msg, err, {
        code: err instanceof TimeoutError ? 'TIMEOUT' : this.errorCodeFor(err, 'SWEEP_ERROR'),
        retryable: true,
      });
    }
  }

  /**
   * What the sweep asked with a reload would take, per load it replaces —
   * each listed as the sweep of that load's removal lists it — for the
   * reload's confirmation and its dry run to say before anything is
   * written; read only. Refused, as a removal's list is, when the load shown
   * is not among them any more: another load was recorded since.
   */
  private async listReloadSweeps(
    msg: InboundRequest,
    store: SasReferenceIdMappingStore,
    request: { targetOrgId: string; loadedAt: string },
  ): Promise<void> {
    // A target refreshed since took the loads' records with it, and leaves a
    // sweep nothing to take: said as such, not as another load recorded since,
    // which the command line now reads before a reload and stopped it on.
    // A load that does not say what it created is swept by no reload, which
    // refuses it in its own words.
    const recorded = (await store.isStale()) ? undefined : await store.recordedLoads();
    const loads = (recorded ?? []).filter((load) => load.created);
    if (recorded && !recorded.some((load) => load.endedAt === request.loadedAt)) {
      sendHandlerError(
        this.deps,
        'frozen:remove:sweep',
        'frozen:remove:sweep:error',
        msg,
        new Error(
          'Another load was recorded since this one was shown: check what a reload replaces now.',
        ),
        { code: 'LOAD_CHANGED' },
      );
      return;
    }
    const listed = await new TimeoutManager(SWEEP_LIST_TIMEOUT_MS).withTimeout(
      'frozen:remove:sweep',
      async () => {
        if (loads.length === 0) return [];
        const conn = await getJsforceConnection(
          request.targetOrgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        );
        const org = sweepOrgOf(conn, 'frozen:remove:sweep');
        const sweptWith = new Set(loads.map((load) => load.endedAt));
        const all: FrozenReloadSweepListing[] = [];
        for (const load of loads) {
          all.push({
            loadedAt: load.endedAt,
            listing: await listSweep(
              org,
              await this.sweepInputOfLoad(org, load, undefined, store, sweptWith),
              load.removalSpans,
            ),
          });
        }
        return all;
      },
    );
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, 'frozen:remove:sweep:response', {
        loadedAt: request.loadedAt,
        reload: true,
        loads: listed,
      }),
    );
  }

  /**
   * Say, once, that the first extraction made the salt, where it is kept and
   * how a teammate gets it: kept for good, it is what every later extraction
   * pseudonymizes with, and nobody had been asked.
   */
  private sayTheSaltWasMade(fingerprint: string): void {
    sendNotification(
      this.deps,
      'info',
      'Frozen dataset salt',
      `This first extraction made the salt every pseudonym is drawn with (fingerprint ` +
        `${fingerprint}) and keeps it in VS Code's secret storage: every later extraction ` +
        'pseudonymizes the same records the same way. A teammate who extracts this dataset ' +
        'needs the same salt: copy it with "SandForge: Copy Frozen Dataset Salt" and give it ' +
        'to them as you would a password; they set it with "SandForge: Use a Frozen Dataset ' +
        'Salt". Whoever holds it can tell which source value a pseudonym was drawn from.',
      { autoDismissMs: null, code: 'FROZEN_SALT_CREATED' },
    );
  }

  // ── frozen:status ──────────────────────────────────────────────────────

  private async handleStatus(msg: InboundRequest): Promise<void> {
    const config = this.loadConfig();
    const sasDir = this.resolveSasDir(config);
    const datasetDir = this.resolveDatasetDir(config);

    let salt: FrozenStatusInfo['salt'] = { present: false };
    try {
      const kept = await this.saltKeeper.read();
      if (kept) {
        salt = {
          present: true,
          fingerprint: new DeterministicPseudonymizer(kept.salt).saltFingerprint,
          source: kept.source,
        };
      }
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

    // Read as written: the page is told what a removal would take without
    // anything being asked of the org — of the load a removal takes next, in
    // each org the sas holds a mapping of. The page shows the one of the
    // target it has selected.
    const loadRecords: FrozenLoadRecordsInfo[] = [];
    try {
      const guard = new SasPathGuard();
      const sas = guard.assertOutsideRepo(sasDir);
      for (const orgId of await mappedOrgIds(sas, guard)) {
        try {
          const load = loadToRemove(
            await new SasReferenceIdMappingStore(sas, { guard, orgId }).recordedLoads(),
          );
          if (load) loadRecords.push(loadRecordsInfo(load));
        } catch {
          // A mapping that cannot be read hides no other org's.
        }
      }
    } catch {
      loadRecords.length = 0;
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
      lastLoads: this.lastLoadInfos(),
      lastVerifies: this.lastVerifyInfos(),
      ...(loadRecords.length > 0 ? { loadRecords } : {}),
      rules: await this.rulesFileInfo(config),
    };
    const response = buildResponse(this.deps, msg, 'frozen:status:response', { status });
    this.deps.broker.postToWebview(response);
  }
}
