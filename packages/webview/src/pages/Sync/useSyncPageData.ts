import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncExecutionResult, FieldMapping, TransformRule, SyncConfig, SyncObjectConfig, SyncDirection, SyncMode, SyncOperation, ConflictStrategy, MappingType, TransformRuleType } from '@sandforge/shared';
import type { PIIScanResponse } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
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
  /** Execute the sync with current configuration. */
  handleExecute: () => void;
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
  const initialDraft = useRef(draft);

  const [currentStep, setCurrentStep] = useState(initialDraft.current.currentStep);
  const [sourceOrgId, setSourceOrgId] = useState(initialDraft.current.sourceOrgId);
  const [targetOrgId, setTargetOrgId] = useState(initialDraft.current.targetOrgId);
  const [direction, setDirection] = useState<SyncDirection>(initialDraft.current.direction);
  const [mode, setMode] = useState<SyncMode>(initialDraft.current.mode);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>(initialDraft.current.conflictStrategy);
  const [objectEntries, setObjectEntries] = useState<ObjectSetEntry[]>(initialDraft.current.objectEntries);
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
  }, [currentStep, direction, mode, conflictStrategy, sourceOrgId, targetOrgId, objectEntries, mappings, transforms, setDraft]);

  // Progress tracking (updated via future progress messages)
  const overallPercent = 0;
  const elapsedMs = 0;

  // Bridge query: fetch available objects from source org
  const objectsQuery = useBridgeQuery<{ objects: string[] }>(
    'sync:describe-global',
    { orgId: sourceOrgId },
    { responseType: 'sync:describe-global:response', skip: !sourceOrgId },
  );

  // Bridge mutation: fetch field details for an object
  const fieldsMutation = useBridgeMutation<{ objectApiName: string; sourceFields: FieldInfo[]; targetFields: FieldInfo[] }>(
    'sync:describe-fields',
    { responseType: 'sync:describe-fields:response' },
  );

  // Bridge mutation: execute sync
  const executeMutation = useBridgeMutation<SyncExecutionResult>(
    'sync:execute',
    { responseType: 'sync:execute:response' },
  );

  // Bridge mutation: dry-run preview (unused in UI for now)
  void useBridgeMutation<Record<string, unknown>>(
    'sync:preview',
    { responseType: 'sync:preview:response' },
  );

  // PII scan for selected objects before sync execution
  const piiScan = useBridgeMutation<PIIScanResponse['payload']>('precheck:pii-scan');

  // State for PII warnings
  const [piiWarnings, setPiiWarnings] = useState<PIIWarning[]>([]);

  // Update PII warnings when scan completes
  useEffect(() => {
    if (piiScan.data?.success && piiScan.data.results) {
      setPiiWarnings(piiScan.data.results.filter(r => r.piiFields.length > 0));
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

  // Show error notifications from bridge hooks
  useEffect(() => {
    const bridgeError = objectsQuery.error ?? fieldsMutation.error ?? executeMutation.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({ level: 'error', title: t('sync.title'), message: bridgeError, autoDismissMs: 5000 });
    }
  }, [objectsQuery.error, fieldsMutation.error, executeMutation.error, addNotification, t]);

  // Navigate to results step when execution completes
  useEffect(() => {
    if (result && !isRunning) {
      setCurrentStep(6);
    }
  }, [result, isRunning]);

  // Trigger PII scan when entering the review step
  useEffect(() => {
    if (currentStep === 4 && sourceOrgId && objectEntries.length > 0) {
      piiScan.mutate({ orgId: sourceOrgId, objectNames: objectEntries.map(e => e.objectApiName) });
    }
  }, [currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch fields when entering field mapping step
  useEffect(() => {
    if (currentStep === 2 && sourceOrgId && targetOrgId && objectEntries.length > 0) {
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
    setObjectEntries((prev) => [...prev, { objectApiName: apiName, operation: 'upsert' as SyncOperation, externalIdField: 'Id', batchSize: 200, where: '' }]);
  };
  const handleRemoveObject = (index: number) => {
    setObjectEntries((prev) => prev.filter((_, i) => i !== index));
  };
  const handleObjectChange = (index: number, field: keyof ObjectSetEntry, value: string | number) => {
    setObjectEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  };
  const handleAddMapping = (srcField: string, tgtField: string) => {
    setMappings((prev) => [...prev, { sourceField: srcField, targetField: tgtField, type: 'direct' as MappingType }]);
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

  const handleExecute = () => {
    if (!sourceOrgId || !targetOrgId) return;
    setError(null);

    const config: SyncConfig = {
      id: crypto.randomUUID(),
      name: 'sync-from-ui',
      description: 'Sync from SandForge UI',
      sourceOrgId,
      targetOrgId,
      direction,
      mode,
      objects: objectEntries.map((entry, index): SyncObjectConfig => ({
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
      })),
      conflictStrategy,
      enableRollback: false,
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    executeMutation.mutate({ config: config as unknown as Record<string, unknown> });
  };

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 0: return !!sourceOrgId && !!targetOrgId && sourceOrgId !== targetOrgId;
      case 1: return objectEntries.length > 0;
      case 5: return !isRunning;
      default: return true;
    }
  };

  const isFinished = currentStep === 6 && !!result;

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
    handleExecute,
    canGoNext,
    isFinished,
    overallPercent,
    elapsedMs,
  };
}
