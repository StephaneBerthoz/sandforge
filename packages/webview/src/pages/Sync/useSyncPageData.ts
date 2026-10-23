import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SyncExecutionResult,
  FieldMapping,
  TransformRule,
  SyncConfig,
  SyncObjectConfig,
  SyncDirection,
  SyncMode,
  SyncOperation,
  ConflictStrategy,
  SyncConflictStrategy,
  MappingType,
  TransformRuleType,
  TransformRuleConfig,
  SyncTemplateConfig,
  SyncConfigSaveResponse,
  SyncConfigLoadResponse,
  SyncSimulationResult,
  SyncFileCopyOption,
  SyncWriteOrder,
  SyncEncryptedFieldsMasked,
} from '@sandforge/shared';
import type { PIIScanResponse, SyncDescribeGlobalResponse } from '@sandforge/shared';
import {
  FILE_COPY_CEILING_MB,
  FILE_COPY_DEFAULT_MAX_MB,
  SYNC_CONFLICT_STRATEGIES,
  SYNC_FILES_DEFAULT_RUN_MB,
  SYNC_FILES_MAX_RUN_MB,
} from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useAppStore } from '../../stores/useAppStore';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import { useWebviewPersistedState } from '../../hooks/useWebviewPersistedState';
import type { FieldInfo } from './FieldMappingCanvas';
import type { ObjectSetEntry } from './ObjectSetEditor';
import { runSettingsOf, writesOverHeld } from './heldRecordChoice';

/** Draft state safe to persist (no credentials, no execution results). */
interface SyncDraftState {
  currentStep: number;
  /** The direction the run would be sent, kept for older builds: never read back (see `runSettingsOf`). */
  direction: SyncDirection;
  mode: SyncMode;
  /**
   * As the draft was saved: a draft from a build that offered `manual` can
   * still hold it, and reopens on {@link MANUAL_STRATEGY_REPLACEMENT}.
   */
  conflictStrategy: ConflictStrategy;
  sourceOrgId: string;
  targetOrgId: string;
  /** With mode `delta`: carry the source's deletions. Absent from a draft saved before it existed. */
  propagateDeletes?: boolean;
  /** Copy the files of the records, with the two caps. Absent when off, and from older drafts. */
  files?: SyncFileCopyOption;
  /** Write emails and phone numbers as read. Absent when off — the default — and from older drafts. */
  keepContactPoints?: boolean;
  objectEntries: ObjectSetEntry[];
  /**
   * Field mappings, per object.
   *
   * It used to be one flat list, drawn against the first object's fields and
   * then sent as the mapping of EVERY object of the run. A draft written by
   * that build is dropped rather than guessed at: its list belongs to an object
   * the draft does not name.
   */
  mappingsByObject: Record<string, FieldMapping[]>;
  transforms: TransformRule[];
}

/** PII warning entry for display. */
export interface PIIWarning {
  objectName: string;
  piiFields: Array<{ fieldName: string; piiType: string; confidence: number }>;
}

/** Return type for the useSyncPageData hook. */
export interface SyncPageData {
  /** Available objects from the source org describe-global. */
  availableObjects: string[];
  /** The source's objects the target takes none of, shown and not selectable. */
  unwritableObjects: NonNullable<SyncDescribeGlobalResponse['payload']['unwritable']>;
  /** Source field metadata for the currently described object. */
  sourceFields: FieldInfo[];
  /** Target field metadata for the currently described object. */
  targetFields: FieldInfo[];
  /** Execution result after sync completes. */
  result: SyncExecutionResult | undefined;
  /**
   * What the last simulation found, while the configuration on screen is the
   * one it simulated and until a run or another simulation starts.
   */
  simulation: SyncSimulationResult | undefined;
  /** Whether the sync execution is currently running. */
  isRunning: boolean;
  /** Whether a simulation is under way. */
  isSimulating: boolean;
  /** The id the run or simulation under way is known by in the extension, or null. */
  runOperationId: string | null;
  /** Whether the objects query is loading. */
  objectsLoading: boolean;
  /** Whether the fields mutation is loading. */
  fieldsLoading: boolean;
  /** Error message from any bridge hook. */
  error: string | null;
  /** Clear the error message. */
  clearError: () => void;
  /** PII warnings for objects being synced. */
  piiWarnings: PIIWarning[];
  /** Current wizard step index. */
  currentStep: number;
  /** Set the current wizard step. */
  setCurrentStep: (step: number) => void;
  /** Selected source org ID. */
  sourceOrgId: string;
  /** Selected target org ID. */
  targetOrgId: string;
  /**
   * Whether an object of the run finds a record the target already holds —
   * one written by upsert or update — which is what the choice of
   * `conflictStrategy` is asked for.
   */
  findsHeldRecords: boolean;
  /** Sync mode setting: full, or delta. */
  mode: SyncMode;
  /** Set sync mode. Leaving delta turns deletions off with it. */
  setMode: (m: SyncMode) => void;
  /** Whether a delta run deletes in the target what the source deleted. */
  propagateDeletes: boolean;
  /** Turn deletions on or off; only a delta configuration keeps them on. */
  setPropagateDeletes: (on: boolean) => void;
  /** Whether a run copies the files of the records it writes. */
  copyFiles: boolean;
  /** Turn the files on or off. */
  setCopyFiles: (on: boolean) => void;
  /**
   * Whether a run writes emails and phone numbers as the source holds them;
   * off by default, when every address goes under `.invalid` and every number
   * is a fictional one.
   */
  keepContactPoints: boolean;
  /** Keep them as read, or neutralize them. */
  setKeepContactPoints: (on: boolean) => void;
  /** The largest file copied, and the most a run copies, in MB, as typed. */
  fileCaps: SyncFileCopyOption;
  /** Set one of the two caps, kept within its bounds. */
  setFileCap: (cap: keyof SyncFileCopyOption, megabytes: number) => void;
  /**
   * The objects a delta run cannot write, by API name: those written by
   * insert or delete. The run is refused for them, so the wizard does not go
   * on while delta is on and one is listed.
   */
  deltaBlockers: string[];
  /**
   * What a run does when the target already holds the record, as picked:
   * overwrite it with the source's values, keep the target's, keep the newest,
   * or merge. Sent as the direction and strategy of `runSettingsOf`.
   */
  conflictStrategy: SyncConflictStrategy;
  /** Pick what a run does when the target already holds the record. */
  setConflictStrategy: (cs: SyncConflictStrategy) => void;
  /** Whether the draft asked for manual review and reopened on target wins, to be said. */
  strategyNotice: boolean;
  /** Put the notice away. */
  dismissStrategyNotice: () => void;
  /** Configured object entries for sync. */
  objectEntries: ObjectSetEntry[];
  /** Field mappings between source and target. */
  mappings: FieldMapping[];
  /** The object the mapping step is showing, and the set of objects to choose from. */
  mappedObject: string;
  setMappedObject: (objectApiName: string) => void;
  /** Set field mappings directly (used by auto-match). */
  setMappings: (m: FieldMapping[]) => void;
  /** Transform rules to apply during sync. */
  transforms: TransformRule[];
  /** Handler to change source org selection. */
  handleSourceOrgChange: (orgId: string) => void;
  /** Handler to change target org selection. */
  handleTargetOrgChange: (orgId: string) => void;
  /** Add an object to the sync set by API name. */
  handleAddObject: (apiName: string) => void;
  /** Remove an object from the sync set by index. */
  handleRemoveObject: (index: number) => void;
  /** Update a field on a specific object entry. */
  handleObjectChange: (index: number, field: keyof ObjectSetEntry, value: string | number) => void;
  /** Add a field mapping between source and target fields. */
  handleAddMapping: (srcField: string, tgtField: string) => void;
  /** Remove a field mapping by index. */
  handleRemoveMapping: (index: number) => void;
  /** Change the mapping type for a specific mapping. */
  handleMappingTypeChange: (index: number, type: MappingType) => void;
  /** Add a transform rule of the given type. */
  handleAddTransform: (type: TransformRuleType) => void;
  /** Remove a transform rule by index. */
  handleRemoveTransform: (index: number) => void;
  /** Set one setting of a transform rule, as typed in its input. */
  handleChangeTransformConfig: (index: number, key: string, value: string) => void;
  /** Execute the sync with current configuration. */
  handleExecute: () => void;
  /** Simulate the sync with current configuration: read, compare, write nothing. */
  handleSimulate: () => void;
  /** Save the current configuration under `name` so a schedule can run it. */
  handleSaveConfig: (name: string) => void;
  /**
   * Run a saved configuration now, as it was saved: read back by its id, then
   * sent to the run exactly as the wizard sends its own.
   */
  handleRunSavedConfig: (configId: string, label: string) => void;
  /** The label of the saved configuration the run on the page is of, or null for the wizard's own. */
  savedRunLabel: string | null;
  /** Whether a saved configuration asked to run is being read back, before its run starts. */
  savedRunStarting: boolean;
  /** Whether the configuration on screen is the one the host last confirmed saving. */
  configSaved: boolean;
  /** The order a run writes the objects in, read on Review; null until the extension answers. */
  writeOrder: SyncWriteOrder | null;
  /** Whether that order is being read. */
  writeOrderLoading: boolean;
  /** Whether that order could not be read. */
  writeOrderUnread: boolean;
  /** Per object, the encrypted fields the source's user reads masked, which a run leaves out. */
  writeOrderEncrypted: SyncEncryptedFieldsMasked[];
  /**
   * Whether the configuration on screen copies files and is not saved: the
   * extension refuses a run and a simulation of it, so neither is sent.
   */
  filesNeedSave: boolean;
  /** Apply a pre-built sync template to populate wizard state. */
  handleApplyTemplate: (template: SyncTemplateConfig) => void;
  /** Whether the wizard can advance to the next step. */
  canGoNext: () => boolean;
  /** Whether the sync has completed with results. */
  isFinished: boolean;
  /** Overall progress percentage. */
  overallPercent: number;
  /** Elapsed time in milliseconds. */
  elapsedMs: number;
}

/**
 * The conflict strategies a bidirectional run acts on. `manual` is not one of
 * them: the resolver answered it with the source values and wrote them, like
 * source wins, and no run shows a conflict to anyone before it writes.
 */
export const OFFERED_CONFLICT_STRATEGIES: readonly SyncConflictStrategy[] =
  SYNC_CONFLICT_STRATEGIES;

/**
 * What a draft that asked for `manual` reopens on: target wins, the strategy
 * that writes no value of the source where the target holds a different one —
 * the nearest a run comes to waiting for a decision. Every run of such a draft
 * wrote the source values; reopened on the default, it went on doing so
 * without a word. The page says it changed, and the strategy can be picked
 * again.
 */
export const MANUAL_STRATEGY_REPLACEMENT: SyncConflictStrategy = 'target_wins';

/**
 * The strategy a saved draft reopens on, and whether it had asked for manual
 * review. Anything else no run acts on reopens on the default.
 */
export function draftConflictStrategy(saved: string): {
  strategy: SyncConflictStrategy;
  replacedManual: boolean;
} {
  if (saved === 'manual') return { strategy: MANUAL_STRATEGY_REPLACEMENT, replacedManual: true };
  return {
    strategy: offeredOr<string>(
      OFFERED_CONFLICT_STRATEGIES,
      saved,
      'source_wins',
    ) as SyncConflictStrategy,
    replacedManual: false,
  };
}

/**
 * The modes a run accepts, and what a draft holding anything else reopens on.
 *
 * `incremental` and `cdc` only ever replayed a full sync and are refused by
 * the bridge. The options are gone from the page, so a draft saved while they
 * were offered reopened on a value with no option to change it, and every run
 * from that draft was refused with no way out but clearing the draft. A delta
 * run reads each object from its last good run: see the delta switch on the
 * first step. A draft's direction is not read back at all: the run's is
 * `runSettingsOf` the choice on screen, so a `target_to_source` saved while it
 * was offered goes nowhere.
 */
export const OFFERED_MODES: readonly SyncMode[] = ['full', 'delta'];

/**
 * The operations a delta run writes with: the ones that find their record, so
 * what the overlap reads twice is written twice without a second copy. The
 * bridge refuses a delta configuration holding any other.
 */
const DELTA_OPERATIONS: ReadonlySet<SyncOperation> = new Set<SyncOperation>(['upsert', 'update']);

/** One shared empty list: a fresh `[]` per render would retrigger every memo. */
const EMPTY_MAPPINGS: FieldMapping[] = [];

/** No object the target takes none of: one list, so the picker's props stay the same. */
const NO_UNWRITABLE: NonNullable<SyncDescribeGlobalResponse['payload']['unwritable']> = [];

/** The bounds of each file cap, in MB, as the extension checks them. */
const FILE_CAP_BOUNDS: Readonly<Record<keyof SyncFileCopyOption, number>> = {
  maxFileSizeMB: FILE_COPY_CEILING_MB,
  maxRunMB: SYNC_FILES_MAX_RUN_MB,
};

/**
 * `megabytes` as a cap the extension takes: a whole number from one to the
 * cap's ceiling. A box emptied while typing, or a number past the ceiling,
 * comes back within them rather than refusing the run.
 */
export function boundedCap(cap: keyof SyncFileCopyOption, megabytes: number): number {
  if (!Number.isFinite(megabytes)) return 1;
  return Math.min(FILE_CAP_BOUNDS[cap], Math.max(1, Math.round(megabytes)));
}

/** The caps a draft reopens on: its own, kept within bounds, or the defaults. */
export function fileCapsOf(saved: Partial<SyncFileCopyOption> | undefined): SyncFileCopyOption {
  return {
    maxFileSizeMB: boundedCap(
      'maxFileSizeMB',
      // The largest file a configuration copies unless it sets another: a Forge run's.
      saved?.maxFileSizeMB ?? FILE_COPY_DEFAULT_MAX_MB,
    ),
    maxRunMB: boundedCap('maxRunMB', saved?.maxRunMB ?? SYNC_FILES_DEFAULT_RUN_MB),
  };
}

/** A draft value the page can still offer, or the default it falls back to. */
export function offeredOr<T>(offered: readonly T[], value: T, fallback: T): T {
  return offered.includes(value) ? value : fallback;
}

/**
 * The transform settings TransformBuilder types into, all of them text. They
 * are listed so a key from the outside cannot reach the rule's config, and
 * `length` is left out: it is the only numeric setting and is read apart.
 */
const TEXT_TRANSFORM_CONFIG_KEYS = [
  'prefix',
  'suffix',
  'search',
  'replace',
  'regex',
  'defaultValue',
  'dateFormat',
  'numberFormat',
  'formula',
] as const;

type TextTransformConfigKey = (typeof TEXT_TRANSFORM_CONFIG_KEYS)[number];

function isTextTransformConfigKey(key: string): key is TextTransformConfigKey {
  return (TEXT_TRANSFORM_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Extracts all data-fetching logic, bridge queries, mutations, and derived state
 * from SyncPage into a single composable hook.
 *
 * This hook manages:
 * - Bridge query for object describe-global
 * - Bridge mutations for field describe, sync execution, preview, and PII scan
 * - Wizard step state and navigation logic
 * - All form state (orgs, mode, what to do with a record the target holds, objects, mappings, transforms)
 * - Error notification effects
 * - Auto-navigation to results step on completion
 * - PII scan trigger on review step
 * - Field fetch trigger on field-mapping step
 */
export function useSyncPageData(): SyncPageData {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);

  const defaultDraft: SyncDraftState = {
    currentStep: 0,
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    sourceOrgId: '',
    targetOrgId: '',
    objectEntries: [],
    mappingsByObject: {},
    transforms: [],
  };

  const [draft, setDraft] = useWebviewPersistedState<SyncDraftState>('syncDraft', defaultDraft);
  // Opened from Home's sync recommendation: a fresh draft on the two orgs it
  // named, rather than whatever draft was left for another pair.
  const [startingDraft] = useState<SyncDraftState>(() => {
    const intent = useAppStore.getState().navigationIntent;
    if (intent?.route !== 'sync') return draft;
    return {
      ...defaultDraft,
      sourceOrgId: intent.sourceOrgId ?? '',
      targetOrgId: intent.targetOrgId ?? '',
    };
  });
  const initialDraft = useRef(startingDraft);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  useEffect(() => {
    if (useAppStore.getState().navigationIntent?.route === 'sync') clearNavigationIntent();
  }, [clearNavigationIntent]);

  // A run's progress and its results are not kept with the draft, so a draft
  // left on the results step reopens on the step that starts a run.
  const [currentStep, setCurrentStep] = useState(Math.min(initialDraft.current.currentStep, 4));
  const [sourceOrgId, setSourceOrgId] = useState(initialDraft.current.sourceOrgId);
  const [targetOrgId, setTargetOrgId] = useState(initialDraft.current.targetOrgId);
  const [mode, setModeValue] = useState<SyncMode>(
    offeredOr(OFFERED_MODES, initialDraft.current.mode, 'full'),
  );
  const [propagateDeletes, setPropagateDeletesValue] = useState<boolean>(
    initialDraft.current.propagateDeletes === true && initialDraft.current.mode === 'delta',
  );
  const [copyFiles, setCopyFiles] = useState<boolean>(initialDraft.current.files !== undefined);
  const [keepContactPoints, setKeepContactPoints] = useState<boolean>(
    initialDraft.current.keepContactPoints === true,
  );
  const [fileCaps, setFileCaps] = useState<SyncFileCopyOption>(() =>
    fileCapsOf(initialDraft.current.files),
  );
  const setFileCap = useCallback((cap: keyof SyncFileCopyOption, megabytes: number) => {
    setFileCaps((prev) => ({ ...prev, [cap]: boundedCap(cap, megabytes) }));
  }, []);
  /** What the configuration carries of the files: the caps while on, nothing while off. */
  const files = copyFiles ? fileCaps : undefined;
  // Deletions are carried by a delta run only: the bridge refuses them on a
  // full one, so leaving delta turns them off rather than leaving a switch on
  // that no run would honour.
  const setMode = useCallback((m: SyncMode) => {
    setModeValue(m);
    if (m !== 'delta') setPropagateDeletesValue(false);
  }, []);
  const setPropagateDeletes = useCallback(
    (on: boolean) => setPropagateDeletesValue(on && mode === 'delta'),
    [mode],
  );
  const [savedStrategy] = useState(() =>
    draftConflictStrategy(initialDraft.current.conflictStrategy),
  );
  const [conflictStrategy, setConflictStrategyValue] = useState<SyncConflictStrategy>(
    savedStrategy.strategy,
  );
  const [strategyNotice, setStrategyNotice] = useState(savedStrategy.replacedManual);
  // A strategy picked by hand is the answer the notice asked for.
  const setConflictStrategy = useCallback((cs: SyncConflictStrategy) => {
    setConflictStrategyValue(cs);
    setStrategyNotice(false);
  }, []);
  const [objectEntries, setObjectEntries] = useState<ObjectSetEntry[]>(
    initialDraft.current.objectEntries,
  );
  // What the run is sent for the choice: the read of the target's records
  // only where a write finds one and the source's values are not simply
  // written over it. See `runSettingsOf`.
  const findsHeldRecords = objectEntries.some((entry) => writesOverHeld(entry.operation));
  const { direction, conflictStrategy: sentStrategy } = runSettingsOf(
    conflictStrategy,
    findsHeldRecords,
  );
  /*
   * The object the mapping step is showing. Step 1 describes one object at a
   * time, so the mappings drawn there belong to that object; `mappings` and
   * `setMappings` below are a window onto its entry, which keeps every caller
   * in the page unchanged.
   */
  const [mappingsByObject, setMappingsByObject] = useState<Record<string, FieldMapping[]>>(
    initialDraft.current.mappingsByObject ?? {},
  );
  const [mappedObject, setMappedObject] = useState<string>(
    initialDraft.current.objectEntries[0]?.objectApiName ?? '',
  );
  const mappings = useMemo(
    () => mappingsByObject[mappedObject] ?? EMPTY_MAPPINGS,
    [mappingsByObject, mappedObject],
  );
  const setMappings = useCallback(
    (next: FieldMapping[] | ((prev: FieldMapping[]) => FieldMapping[])) => {
      setMappingsByObject((prev) => {
        const current = prev[mappedObject] ?? EMPTY_MAPPINGS;
        const value = typeof next === 'function' ? next(current) : next;
        return { ...prev, [mappedObject]: value };
      });
    },
    [mappedObject],
  );
  const [transforms, setTransforms] = useState<TransformRule[]>(initialDraft.current.transforms);
  const [error, setError] = useState<string | null>(null);

  // Auto-save draft on any form state change
  useEffect(() => {
    setDraft({
      currentStep,
      direction,
      mode,
      propagateDeletes,
      files,
      ...(keepContactPoints ? { keepContactPoints: true } : {}),
      conflictStrategy,
      sourceOrgId,
      targetOrgId,
      objectEntries,
      mappingsByObject,
      transforms,
    });
  }, [
    currentStep,
    direction,
    mode,
    propagateDeletes,
    files,
    keepContactPoints,
    conflictStrategy,
    sourceOrgId,
    targetOrgId,
    objectEntries,
    mappingsByObject,
    transforms,
    setDraft,
  ]);

  /** Set when the run is fired, so elapsed time is real rather than a literal 0. */
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);

  // Bridge query: the objects the source's user may read, and once the target
  // is picked, those the target takes — what its user may create is read
  // there, not in the source.
  const objectsQuery = useBridgeQuery<SyncDescribeGlobalResponse['payload']>(
    'sync:describe-global',
    { orgId: sourceOrgId, ...(targetOrgId ? { targetOrgId } : {}) },
    { responseType: 'sync:describe-global:response', skip: !sourceOrgId },
  );

  // Bridge mutation: fetch field details for an object
  const fieldsMutation = useBridgeMutation<{
    objectApiName: string;
    sourceFields: FieldInfo[];
    targetFields: FieldInfo[];
  }>('sync:describe-fields', { responseType: 'sync:describe-fields:response' });

  // Bridge mutation: execute sync
  const executeMutation = useBridgeMutation<SyncExecutionResult>('sync:execute', {
    responseType: 'sync:execute:response',
    // A bulk write runs past the 30 s default on real volumes, and a paused
    // run waits on a person; operation:progress keeps flowing meanwhile.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
  });

  // Bridge mutation: simulate sync — the same reads, nothing written
  const simulateMutation = useBridgeMutation<SyncSimulationResult>('sync:simulate', {
    responseType: 'sync:simulate:response',
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
  });

  // Bridge mutation: persist the configuration a schedule runs by id
  const saveConfigMutation = useBridgeMutation<SyncConfigSaveResponse['payload']>(
    'sync:config:save',
    { responseType: 'sync:config:save:response' },
  );

  // Bridge mutation: read a saved configuration back, to run it as saved
  const loadConfigMutation = useBridgeMutation<SyncConfigLoadResponse['payload']>(
    'sync:config:load',
    { responseType: 'sync:config:load:response' },
  );
  /** The saved configuration asked to run now, until it is read back and sent to the run. */
  const [savedRunAsked, setSavedRunAsked] = useState<string | null>(null);
  /** The label of the saved configuration the run on the page is of; null for the wizard's own. */
  const [savedRunLabel, setSavedRunLabel] = useState<string | null>(null);

  /**
   * The configuration last sent to be saved, and the id it was saved under. A
   * schedule runs whatever is stored under its configuration id, so the id is
   * reused only while the configuration is unchanged: saving the same thing
   * twice updates one entry, and saving a different pair, strategy or object
   * set creates another instead of repointing a schedule built on the first.
   */
  const [lastSaved, setLastSaved] = useState<{ id: string; fingerprint: string } | null>(null);
  const configFingerprint = JSON.stringify({
    sourceOrgId,
    targetOrgId,
    direction,
    mode,
    propagateDeletes,
    files,
    keepContactPoints,
    conflictStrategy: sentStrategy,
    objectEntries,
    mappings,
    transforms,
  });

  // PII scan for selected objects before sync execution
  const piiScan = useBridgeMutation<PIIScanResponse['payload']>('precheck:pii-scan');

  // State for PII warnings
  const [piiWarnings, setPiiWarnings] = useState<PIIWarning[]>([]);

  // Update PII warnings when scan completes
  useEffect(() => {
    if (piiScan.data?.success && piiScan.data.results) {
      setPiiWarnings(piiScan.data.results.filter((r) => r.piiFields.length > 0));
    }
  }, [piiScan.data]);

  // Derive available objects from bridge query
  const availableObjects = objectsQuery.data?.objects ?? [];
  const unwritableObjects = objectsQuery.data?.unwritable ?? NO_UNWRITABLE;

  // Derive fields from bridge mutation
  const sourceFields = fieldsMutation.data?.sourceFields ?? [];
  const targetFields = fieldsMutation.data?.targetFields ?? [];

  // Derive execution result and running state from bridge mutation
  const result = executeMutation.data;
  const isRunning = executeMutation.loading;
  // A simulation stands for the configuration it was run on and no other:
  // once the orgs, objects, mappings, transforms or strategy change, its
  // findings say nothing of what a run would now do, and the run it offers
  // would not be the one simulated.
  const simulatedConfig = JSON.stringify({
    sourceOrgId,
    targetOrgId,
    direction,
    mode,
    propagateDeletes,
    files,
    keepContactPoints,
    conflictStrategy: sentStrategy,
    objectEntries,
    mappingsByObject,
    transforms,
  });
  const [simulatedFor, setSimulatedFor] = useState<string | null>(null);
  const simulation = simulatedFor === simulatedConfig ? simulateMutation.data : null;
  const isSimulating = simulateMutation.loading;
  // Reading a saved configuration back is the start of its run: nothing else
  // starts meanwhile.
  const busy = isRunning || isSimulating || loadConfigMutation.loading;

  // SyncOpsHandler emits operation:progress throughout the run; nothing
  // consumed it, so the bar sat at 0 % and the timer at 0.0s for the whole
  // sync — a healthy long run looked identical to a hung one.
  // Read for this run only: SyncOpsHandler uses the request id as the
  // operationId, and every panel receives every run's events. A simulation
  // is known the same way.
  const { getProgress } = useOperationProgress();
  const runOperationId = isRunning
    ? executeMutation.requestId
    : isSimulating
      ? simulateMutation.requestId
      : null;
  const syncProgress = runOperationId !== null ? getProgress(runOperationId) : undefined;
  const overallPercent = syncProgress?.percentage ?? 0;
  const elapsedMs = useElapsedSince(busy ? syncStartedAt : null);

  // Show error notifications from bridge hooks
  useEffect(() => {
    const bridgeError =
      objectsQuery.error ??
      fieldsMutation.error ??
      executeMutation.error ??
      simulateMutation.error ??
      saveConfigMutation.error ??
      loadConfigMutation.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('sync.title'),
        message: bridgeError,
      });
    }
  }, [
    objectsQuery.error,
    fieldsMutation.error,
    executeMutation.error,
    simulateMutation.error,
    saveConfigMutation.error,
    loadConfigMutation.error,
    addNotification,
    t,
  ]);

  // Navigate to results step when execution completes
  useEffect(() => {
    if (result && !isRunning) {
      setCurrentStep(5);
    }
  }, [result, isRunning]);

  // And when a simulation answers: the results step shows what it found.
  useEffect(() => {
    if (simulation && !isSimulating) {
      setCurrentStep(5);
    }
  }, [simulation, isSimulating]);

  // Trigger PII scan when entering the review step. The step is the trigger:
  // re-scanning on every object-list identity change would fire a scan per
  // keystroke in the object picker.
  const scanForPii = useLatestRef(() => {
    if (currentStep === 3 && sourceOrgId && objectEntries.length > 0) {
      piiScan.mutate({
        orgId: sourceOrgId,
        objectNames: objectEntries.map((e) => e.objectApiName),
      });
    }
  });
  useEffect(() => {
    scanForPii.current();
  }, [currentStep, scanForPii]);

  // Fetch fields when entering field mapping step, or when the orgs or objects
  // change on it. `mutate` is read through a ref so the dependency array names
  // those triggers only.
  // The selection has to stay inside the object set: an object removed from
  // step 0 must not leave step 1 describing something that is no longer there.
  useEffect(() => {
    if (objectEntries.length === 0) return;
    if (objectEntries.some((e) => e.objectApiName === mappedObject)) return;
    setMappedObject(objectEntries[0].objectApiName);
  }, [objectEntries, mappedObject]);

  const describeFields = useLatestRef(fieldsMutation.mutate);
  useEffect(() => {
    if (currentStep === 1 && sourceOrgId && targetOrgId && mappedObject) {
      describeFields.current({ sourceOrgId, targetOrgId, objectApiName: mappedObject });
    }
  }, [currentStep, sourceOrgId, targetOrgId, mappedObject, describeFields]);

  const handleSourceOrgChange = useCallback((orgId: string) => {
    setSourceOrgId(orgId);
  }, []);

  const handleTargetOrgChange = (orgId: string) => {
    setTargetOrgId(orgId);
  };
  const handleAddObject = (apiName: string) => {
    setObjectEntries((prev) => [
      ...prev,
      {
        objectApiName: apiName,
        // Insert, and no key: an upsert on `Id` cannot match across orgs — the
        // id belongs to the source — and the bridge now refuses it. The box
        // starts empty, and naming a real External ID field enables upsert.
        operation: 'insert' as SyncOperation,
        externalIdField: '',
        batchSize: 200,
        where: '',
      },
    ]);
  };
  const handleRemoveObject = (index: number) => {
    setObjectEntries((prev) => prev.filter((_, i) => i !== index));
  };
  const handleObjectChange = (
    index: number,
    field: keyof ObjectSetEntry,
    value: string | number,
  ) => {
    setObjectEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  };
  const handleAddMapping = (srcField: string, tgtField: string) => {
    setMappings((prev) => [
      ...prev,
      { sourceField: srcField, targetField: tgtField, type: 'direct' as MappingType },
    ]);
  };
  const handleRemoveMapping = (index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  };
  const handleMappingTypeChange = (index: number, type: MappingType) => {
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, type } : m)));
  };
  const handleAddTransform = (type: TransformRuleType) => {
    setTransforms((prev) => [...prev, { type, config: {} }]);
  };
  const handleRemoveTransform = (index: number) => {
    setTransforms((prev) => prev.filter((_, i) => i !== index));
  };
  const handleChangeTransformConfig = (index: number, key: string, value: string) => {
    setTransforms((prev) =>
      prev.map((rule, i) => {
        if (i !== index) return rule;
        // The boundary types `length` as a positive integer. Only digits are
        // taken: '5.7' or '5px' would otherwise truncate at 5 without saying
        // so, and an empty box leaves the setting out rather than refusing the
        // run. The box reads back what is held here, so text that makes no
        // length is not kept on screen either.
        if (key === 'length') {
          const digits = value.trim();
          const config: TransformRuleConfig = { ...rule.config };
          const length = /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : 0;
          if (length > 0) config.length = length;
          else delete config.length;
          return { ...rule, config };
        }
        if (!isTextTransformConfigKey(key)) return rule;
        return { ...rule, config: { ...rule.config, [key]: value } };
      }),
    );
  };

  const handleApplyTemplate = useCallback(
    (template: SyncTemplateConfig) => {
      setMode(template.mode);
      // What its runs would do with a record the target holds: the strategy
      // is read on a bidirectional run alone.
      setConflictStrategy(
        template.direction === 'bidirectional' ? template.conflictStrategy : 'source_wins',
      );
      setObjectEntries(
        template.objects.map((o) => ({
          objectApiName: o.objectApiName,
          operation: o.operation,
          // The editor row always has the box; a template without a key leaves
          // it empty, and the bridge reads an empty box as "no key".
          externalIdField: o.externalIdField ?? '',
          batchSize: o.batchSize,
          where: '',
        })),
      );
      // Clear any existing mappings/transforms since template objects changed
      setMappingsByObject({});
      setTransforms([]);
    },
    [setConflictStrategy, setMode],
  );

  /** The wizard's state as the one config shape both the run and the store take. */
  const buildConfig = (id: string, name: string, description: string): SyncConfig => ({
    id,
    name,
    description,
    sourceOrgId,
    targetOrgId,
    direction,
    mode,
    // Sent only when on: a full configuration never carries it.
    ...(mode === 'delta' && propagateDeletes ? { propagateDeletes: true } : {}),
    // Sent only when on, as the extension reads its absence as off.
    ...(files ? { files } : {}),
    // Sent only when on: absent, the run neutralizes emails and phone numbers.
    ...(keepContactPoints ? { keepContactPoints: true } : {}),
    objects: objectEntries.map((entry, index): SyncObjectConfig => ({
      objectApiName: entry.objectApiName,
      operation: entry.operation,
      externalIdField: entry.externalIdField,
      batchSize: entry.batchSize,
      where: entry.where || undefined,
      // Each object carries the mappings drawn for it, and nothing else.
      fieldMappings: mappingsByObject[entry.objectApiName] ?? [],
      transformRules: transforms,
      excludedFields: [],
      addOnFields: [],
      insertOrder: index,
    })),
    conflictStrategy: sentStrategy,
    enableRollback: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  /*
   * The order a run writes the objects in, as the extension computes it from
   * the target's describes, asked on Review: the parents a lookup names
   * first. The configuration goes without its dates, which change with every
   * render, so the question is asked again only when the objects change.
   */
  const writeOrderConfig = {
    ...buildConfig('write-order', 'write-order', ''),
    createdAt: undefined,
    updatedAt: undefined,
  };
  const writeOrderQuery = useBridgeQuery<{
    order: SyncWriteOrder;
    encrypted?: SyncEncryptedFieldsMasked[];
  }>(
    'sync:write-order',
    { config: writeOrderConfig },
    {
      errorType: 'sync:error',
      skip: currentStep !== 3 || !sourceOrgId || !targetOrgId || objectEntries.length === 0,
    },
  );

  /**
   * The id the configuration on screen is saved under, while it is the one
   * the host last confirmed saving; null otherwise. A run of it is then a run
   * of that saved configuration: a delta run keeps its watermarks under that
   * id, and a run under a fresh id would read everything every time.
   */
  const savedIdOnScreen =
    saveConfigMutation.data?.success === true &&
    lastSaved !== null &&
    saveConfigMutation.data.id === lastSaved.id &&
    lastSaved.fingerprint === configFingerprint
      ? lastSaved.id
      : null;

  /**
   * Files are copied by a saved configuration only, which keeps which file it
   * copied where: the extension refuses a run, and a simulation, of one that
   * is not saved. The page warned and sent the run all the same, to be
   * refused once the execute step had started.
   */
  const filesNeedSave = copyFiles && savedIdOnScreen === null;

  /** The objects a delta run would be refused for: see {@link DELTA_OPERATIONS}. */
  const deltaBlockers =
    mode === 'delta'
      ? objectEntries.filter((e) => !DELTA_OPERATIONS.has(e.operation)).map((e) => e.objectApiName)
      : [];

  const handleExecute = () => {
    if (!sourceOrgId || !targetOrgId || busy || filesNeedSave) return;
    setError(null);

    const config = buildConfig(
      savedIdOnScreen ?? crypto.randomUUID(),
      'sync-from-ui',
      'Sync from SandForge UI',
    );

    // One outcome on the results step at a time: a simulation's findings are
    // not left standing under a run that has started writing.
    simulateMutation.reset();
    setSavedRunLabel(null);
    setSyncStartedAt(Date.now());
    setCurrentStep(4);
    executeMutation.mutate({ config: config as unknown as Record<string, unknown> });
  };

  /**
   * Run a saved configuration now. It is read back as the store holds it and
   * sent on `sync:execute`, the request the wizard's Run sends: the same
   * checks at the boundary, the same Production Guard, the same progress,
   * Pause and Cancel on the execute step, the same results. A run there needs
   * no simulation first, and neither does this one. Nothing in the wizard is
   * replaced: a configuration saved from Migration can hold what the wizard
   * cannot show — a transform of one object alone — and goes to the run as
   * it was saved.
   */
  const handleRunSavedConfig = (configId: string, label: string) => {
    if (busy) return;
    setError(null);
    executeMutation.reset();
    simulateMutation.reset();
    setSavedRunLabel(label);
    setSavedRunAsked(configId);
    setCurrentStep(4);
    loadConfigMutation.mutate({ id: configId });
  };

  // The saved configuration read back goes to the run, once per answer.
  const loaded = loadConfigMutation.data;
  const startSavedRun = useLatestRef(() => {
    if (!loaded || savedRunAsked === null) return;
    setSavedRunAsked(null);
    if (!loaded.config) {
      setSavedRunLabel(null);
      setError(t('syncParts.savedConfigs.gone'));
      return;
    }
    setSyncStartedAt(Date.now());
    executeMutation.mutate({ config: loaded.config });
  });
  useEffect(() => {
    startSavedRun.current();
  }, [loaded, startSavedRun]);

  /**
   * Simulate the configuration on screen: the extension reads both orgs as a
   * run would and says per object what it would insert, update, skip or find
   * in conflict. Nothing is written, and nothing is recorded as a run.
   */
  const handleSimulate = () => {
    if (!sourceOrgId || !targetOrgId || busy || filesNeedSave) return;
    setError(null);

    // Under the saved id too: a simulation of a delta configuration reads
    // from the watermarks its run would read from.
    const config = buildConfig(
      savedIdOnScreen ?? crypto.randomUUID(),
      'sync-from-ui',
      'Sync from SandForge UI',
    );

    executeMutation.reset();
    setSavedRunLabel(null);
    setSimulatedFor(simulatedConfig);
    setSyncStartedAt(Date.now());
    setCurrentStep(4);
    simulateMutation.mutate({ config: config as unknown as Record<string, unknown> });
  };

  /**
   * Save the wizard's configuration so a schedule can run it later. The host
   * applies the same refusals as a run started by hand, so a configuration
   * that cannot run cannot be stored either.
   */
  const handleSaveConfig = (name: string) => {
    if (!sourceOrgId || !targetOrgId) return;
    setError(null);

    const id = lastSaved?.fingerprint === configFingerprint ? lastSaved.id : crypto.randomUUID();
    setLastSaved({ id, fingerprint: configFingerprint });
    const config = buildConfig(id, name, 'Saved from the SandForge sync wizard');
    saveConfigMutation.mutate({ config: config as unknown as Record<string, unknown> });
  };

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 0:
        return (
          !!sourceOrgId &&
          !!targetOrgId &&
          sourceOrgId !== targetOrgId &&
          objectEntries.length > 0 &&
          deltaBlockers.length === 0
        );
      case 4:
        // The results step shows what a run or a simulation came to; there is
        // nothing to show before one has answered.
        return !busy && (!!result || !!simulation);
      case 5:
        return false;
      default:
        return true;
    }
  };

  const isFinished = currentStep === 5 && (!!result || !!simulation);

  return {
    availableObjects,
    unwritableObjects,
    sourceFields,
    targetFields,
    result: result ?? undefined,
    simulation: simulation ?? undefined,
    isRunning,
    isSimulating,
    runOperationId,
    objectsLoading: objectsQuery.loading,
    fieldsLoading: fieldsMutation.loading,
    error,
    clearError: () => setError(null),
    piiWarnings,
    currentStep,
    setCurrentStep,
    sourceOrgId,
    targetOrgId,
    findsHeldRecords,
    mode,
    setMode,
    propagateDeletes,
    setPropagateDeletes,
    copyFiles,
    setCopyFiles,
    keepContactPoints,
    setKeepContactPoints,
    fileCaps,
    setFileCap,
    deltaBlockers,
    conflictStrategy,
    setConflictStrategy,
    strategyNotice,
    dismissStrategyNotice: () => setStrategyNotice(false),
    objectEntries,
    mappings,
    mappedObject,
    setMappedObject,
    setMappings,
    transforms,
    handleSourceOrgChange,
    handleTargetOrgChange,
    handleAddObject,
    handleRemoveObject,
    handleObjectChange,
    handleAddMapping,
    handleRemoveMapping,
    handleMappingTypeChange,
    handleAddTransform,
    handleRemoveTransform,
    handleChangeTransformConfig,
    handleExecute,
    handleSimulate,
    handleSaveConfig,
    handleRunSavedConfig,
    savedRunLabel,
    savedRunStarting: loadConfigMutation.loading,
    // Only while the configuration on screen is the one the host confirmed.
    configSaved: savedIdOnScreen !== null,
    writeOrder: writeOrderQuery.data?.order ?? null,
    writeOrderLoading: writeOrderQuery.loading,
    writeOrderUnread: writeOrderQuery.error !== null,
    writeOrderEncrypted: writeOrderQuery.data?.encrypted ?? [],
    filesNeedSave,
    handleApplyTemplate,
    canGoNext,
    isFinished,
    overallPercent,
    elapsedMs,
  };
}
