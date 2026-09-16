import { useState, useCallback, useEffect, useRef } from 'react';
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
  MappingType,
  TransformRuleType,
  TransformRuleConfig,
  SyncTemplateConfig,
  SyncConfigSaveResponse,
} from '@sandforge/shared';
import type { PIIScanResponse } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useAppStore } from '../../stores/useAppStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import { useWebviewPersistedState } from '../../hooks/useWebviewPersistedState';
import type { FieldInfo } from './FieldMappingCanvas';
import type { ObjectSetEntry } from './ObjectSetEditor';

/** Draft state safe to persist (no credentials, no execution results). */
interface SyncDraftState {
  currentStep: number;
  direction: SyncDirection;
  mode: SyncMode;
  conflictStrategy: ConflictStrategy;
  sourceOrgId: string;
  targetOrgId: string;
  objectEntries: ObjectSetEntry[];
  mappings: FieldMapping[];
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
  /** Source field metadata for the currently described object. */
  sourceFields: FieldInfo[];
  /** Target field metadata for the currently described object. */
  targetFields: FieldInfo[];
  /** Execution result after sync completes. */
  result: SyncExecutionResult | undefined;
  /** Whether the sync execution is currently running. */
  isRunning: boolean;
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
  /** Sync direction setting. */
  direction: SyncDirection;
  /** Set sync direction. */
  setDirection: (d: SyncDirection) => void;
  /** Sync mode setting. */
  mode: SyncMode;
  /** Set sync mode. */
  setMode: (m: SyncMode) => void;
  /** Conflict resolution strategy. */
  conflictStrategy: ConflictStrategy;
  /** Set conflict strategy. */
  setConflictStrategy: (cs: ConflictStrategy) => void;
  /** Configured object entries for sync. */
  objectEntries: ObjectSetEntry[];
  /** Field mappings between source and target. */
  mappings: FieldMapping[];
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
  /** Save the current configuration under `name` so a schedule can run it. */
  handleSaveConfig: (name: string) => void;
  /** Whether the configuration on screen is the one the host last confirmed saving. */
  configSaved: boolean;
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
 * source wins, and there is no screen on which a conflict could be reviewed.
 * A draft saved while it was offered reopens on the default rather than on a
 * strategy with no option and no label.
 */
export const OFFERED_CONFLICT_STRATEGIES: readonly ConflictStrategy[] = [
  'source_wins',
  'target_wins',
  'newest_wins',
  'merge',
];

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
 * - All form state (orgs, direction, mode, conflict strategy, objects, mappings, transforms)
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
    mappings: [],
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

  const [currentStep, setCurrentStep] = useState(initialDraft.current.currentStep);
  const [sourceOrgId, setSourceOrgId] = useState(initialDraft.current.sourceOrgId);
  const [targetOrgId, setTargetOrgId] = useState(initialDraft.current.targetOrgId);
  const [direction, setDirection] = useState<SyncDirection>(initialDraft.current.direction);
  const [mode, setMode] = useState<SyncMode>(initialDraft.current.mode);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>(
    OFFERED_CONFLICT_STRATEGIES.includes(initialDraft.current.conflictStrategy)
      ? initialDraft.current.conflictStrategy
      : 'source_wins',
  );
  const [objectEntries, setObjectEntries] = useState<ObjectSetEntry[]>(
    initialDraft.current.objectEntries,
  );
  const [mappings, setMappings] = useState<FieldMapping[]>(initialDraft.current.mappings);
  const [transforms, setTransforms] = useState<TransformRule[]>(initialDraft.current.transforms);
  const [error, setError] = useState<string | null>(null);

  // Auto-save draft on any form state change
  useEffect(() => {
    setDraft({
      currentStep,
      direction,
      mode,
      conflictStrategy,
      sourceOrgId,
      targetOrgId,
      objectEntries,
      mappings,
      transforms,
    });
  }, [
    currentStep,
    direction,
    mode,
    conflictStrategy,
    sourceOrgId,
    targetOrgId,
    objectEntries,
    mappings,
    transforms,
    setDraft,
  ]);

  /** Set when the run is fired, so elapsed time is real rather than a literal 0. */
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);

  // Bridge query: fetch available objects from source org
  const objectsQuery = useBridgeQuery<{ objects: string[] }>(
    'sync:describe-global',
    { orgId: sourceOrgId },
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
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  // Bridge mutation: persist the configuration a schedule runs by id
  const saveConfigMutation = useBridgeMutation<SyncConfigSaveResponse['payload']>(
    'sync:config:save',
    { responseType: 'sync:config:save:response' },
  );

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
    conflictStrategy,
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

  // Derive fields from bridge mutation
  const sourceFields = fieldsMutation.data?.sourceFields ?? [];
  const targetFields = fieldsMutation.data?.targetFields ?? [];

  // Derive execution result and running state from bridge mutation
  const result = executeMutation.data;
  const isRunning = executeMutation.loading;

  // SyncOpsHandler emits operation:progress throughout the run; nothing
  // consumed it, so the bar sat at 0 % and the timer at 0.0s for the whole
  // sync — a healthy long run looked identical to a hung one.
  // Read for this run only: SyncOpsHandler uses the request id as the
  // operationId, and every panel receives every run's events.
  const { getProgress } = useOperationProgress();
  const syncRunId = executeMutation.requestId;
  const syncProgress = isRunning && syncRunId !== null ? getProgress(syncRunId) : undefined;
  const overallPercent = syncProgress?.percentage ?? 0;
  const elapsedMs = useElapsedSince(isRunning ? syncStartedAt : null);

  // Show error notifications from bridge hooks
  useEffect(() => {
    const bridgeError =
      objectsQuery.error ??
      fieldsMutation.error ??
      executeMutation.error ??
      saveConfigMutation.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('sync.title'),
        message: bridgeError,
        autoDismissMs: 5000,
      });
    }
  }, [
    objectsQuery.error,
    fieldsMutation.error,
    executeMutation.error,
    saveConfigMutation.error,
    addNotification,
    t,
  ]);

  // Navigate to results step when execution completes
  useEffect(() => {
    if (result && !isRunning) {
      setCurrentStep(5);
    }
  }, [result, isRunning]);

  // Trigger PII scan when entering the review step
  useEffect(() => {
    if (currentStep === 3 && sourceOrgId && objectEntries.length > 0) {
      piiScan.mutate({
        orgId: sourceOrgId,
        objectNames: objectEntries.map((e) => e.objectApiName),
      });
    }
  }, [currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch fields when entering field mapping step
  useEffect(() => {
    if (currentStep === 1 && sourceOrgId && targetOrgId && objectEntries.length > 0) {
      fieldsMutation.mutate({
        sourceOrgId,
        targetOrgId,
        objectApiName: objectEntries[0].objectApiName,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, sourceOrgId, targetOrgId, objectEntries]);

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
        operation: 'upsert' as SyncOperation,
        externalIdField: 'Id',
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

  const handleApplyTemplate = useCallback((template: SyncTemplateConfig) => {
    setDirection(template.direction);
    setMode(template.mode);
    setConflictStrategy(template.conflictStrategy);
    setObjectEntries(
      template.objects.map((o) => ({
        objectApiName: o.objectApiName,
        operation: o.operation,
        externalIdField: o.externalIdField,
        batchSize: o.batchSize,
        where: '',
      })),
    );
    // Clear any existing mappings/transforms since template objects changed
    setMappings([]);
    setTransforms([]);
  }, []);

  /** The wizard's state as the one config shape both the run and the store take. */
  const buildConfig = (id: string, name: string, description: string): SyncConfig => ({
    id,
    name,
    description,
    sourceOrgId,
    targetOrgId,
    direction,
    mode,
    objects: objectEntries.map(
      (entry, index): SyncObjectConfig => ({
        objectApiName: entry.objectApiName,
        operation: entry.operation,
        externalIdField: entry.externalIdField,
        batchSize: entry.batchSize,
        where: entry.where || undefined,
        fieldMappings: mappings,
        transformRules: transforms,
        excludedFields: [],
        addOnFields: [],
        insertOrder: index,
      }),
    ),
    conflictStrategy,
    enableRollback: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const handleExecute = () => {
    if (!sourceOrgId || !targetOrgId) return;
    setError(null);

    const config = buildConfig(crypto.randomUUID(), 'sync-from-ui', 'Sync from SandForge UI');

    setSyncStartedAt(Date.now());
    executeMutation.mutate({ config: config as unknown as Record<string, unknown> });
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
          !!sourceOrgId && !!targetOrgId && sourceOrgId !== targetOrgId && objectEntries.length > 0
        );
      case 4:
        return !isRunning;
      default:
        return true;
    }
  };

  const isFinished = currentStep === 5 && !!result;

  return {
    availableObjects,
    sourceFields,
    targetFields,
    result: result ?? undefined,
    isRunning,
    objectsLoading: objectsQuery.loading,
    fieldsLoading: fieldsMutation.loading,
    error,
    clearError: () => setError(null),
    piiWarnings,
    currentStep,
    setCurrentStep,
    sourceOrgId,
    targetOrgId,
    direction,
    setDirection,
    mode,
    setMode,
    conflictStrategy,
    setConflictStrategy,
    objectEntries,
    mappings,
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
    handleSaveConfig,
    // Only while the configuration on screen is the one the host confirmed.
    configSaved:
      saveConfigMutation.data?.success === true &&
      lastSaved !== null &&
      saveConfigMutation.data.id === lastSaved.id &&
      lastSaved.fingerprint === configFingerprint,
    handleApplyTemplate,
    canGoNext,
    isFinished,
    overallPercent,
    elapsedMs,
  };
}
