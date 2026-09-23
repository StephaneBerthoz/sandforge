import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { TFunction } from 'i18next';
import type {
  SalesforceOrg,
  SeedExecutionResult,
  SeedTemplate,
  FieldRuleType,
  PersonaMsg,
} from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { useLatestRef } from '../../hooks/useLatestRef';
import type { SeedRelationDraft, SeedRelationDraftPatch } from '../../stores/useSeedWizardStore';
import { useNL2SOQL } from '../../hooks/useAIFeatures';
import { useWebviewPersistedState } from '../../hooks/useWebviewPersistedState';
import type { SeedObjectInfo } from './Step2_SelectObjects';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { ObjectProgress } from './Step7_Execute';
import { useSeedOrgSelection } from './useSeedOrgSelection';
import { useSeedObjectSelection } from './useSeedObjectSelection';
import { useSeedFieldConfig } from './useSeedFieldConfig';
import { useSeedRelations } from './useSeedRelations';
import type { CheckedRelation, RelationLookup } from './seedRelationDrafts';
import { useSeedExecution } from './useSeedExecution';
import { useSeedNL2SOQL } from './useSeedNL2SOQL';

/** Draft state safe to persist (no credentials, no execution results, no PII). */
interface SeedDraftState {
  currentStep: number;
  selectedOrgId: string;
  selectedObjects: string[];
  volumes: Record<string, { count: number; batchSize: number }>;
  nl2soqlQuery: string;
}

/** PII field detection result for a single object. */
export interface PIIObjectResult {
  objectName: string;
  piiFields: Array<{ fieldName: string; piiType: string; confidence: number }>;
}

/** Return type for the useSeedWizardState hook. */
export interface SeedWizardState {
  /* Navigation */
  currentStep: number;
  setCurrentStep: (step: number) => void;
  canGoNext: boolean;
  isFinished: boolean;

  /* Org */
  selectedOrgId: string;
  handleOrgSelect: (orgId: string) => void;
  selectedOrg: SalesforceOrg | undefined;

  /* Objects */
  availableObjects: SeedObjectInfo[];
  loadingObjects: boolean;
  selectedObjects: string[];
  handleToggleObject: (apiName: string) => void;

  /* Volumes */
  volumes: Record<string, { count: number; batchSize: number }>;
  handleChangeVolume: (objectApiName: string, count: number) => void;
  handleChangeBatchSize: (objectApiName: string, size: number) => void;

  /* Fields */
  fieldConfigs: ObjectFieldConfig[];
  /** Whether every selected object has been described; the run waits for it. */
  fieldsReady: boolean;
  /** Why the last describe failed, while an object still waits for one; null otherwise. */
  fieldsError: string | null;
  /** Ask again for the objects not described yet. */
  retryFieldDescribes: () => void;
  handleChangeFieldRule: (
    objectApiName: string,
    fieldApiName: string,
    ruleType: FieldRuleType,
  ) => void;
  handleChangeFieldConfig: (
    objectApiName: string,
    fieldApiName: string,
    key: string,
    value: string,
  ) => void;

  /* Relations */
  relations: SeedRelationDraft[];
  lookups: RelationLookup[];
  checked: CheckedRelation[];
  /** Whether every relation row can be sent; the wizard does not move on otherwise. */
  relationsReady: boolean;
  handleAddRelation: () => void;
  handleRemoveRelation: (index: number) => void;
  handleChangeRelation: (index: number, patch: SeedRelationDraftPatch) => void;

  /* NL2SOQL */
  nl2soqlQuery: string;
  setNl2soqlQuery: (q: string) => void;
  handleNl2soql: () => void;
  nl2soql: ReturnType<typeof useNL2SOQL>;

  /* PII */
  piiResults: PIIObjectResult[];
  hasPiiWarnings: boolean;
  piiLoading: boolean;

  /* Execution */
  isRunning: boolean;
  executionResult: SeedExecutionResult | undefined;
  /** The template the last run was built from, saved by "Save as template". */
  lastTemplate: SeedTemplate | null;
  handleExecute: () => void;
  objectProgress: ObjectProgress[];
  /** Overall completion 0-100, from the live operation:progress stream. */
  overallPercent: number;
  /** Wall-clock since the run started, or 0 when idle. */
  elapsedMs: number;
  /** Step label reported by the extension, e.g. "Bulk insert Contact". */
  progressLabel: string | null;
  /** Id of this wizard's running seed once it has reported progress, else null. */
  operationId: string | null;

  /* Persona */
  /** Currently selected AI persona, or null. */
  selectedPersona: PersonaMsg | null;
  /** Set the selected persona (from PersonaGallery callback). */
  setSelectedPersona: (persona: PersonaMsg | null) => void;
  /** Apply the selected persona's data patterns to field configs. Returns matched count. */
  applySelectedPersona: () => number;

  /* Error */
  error: string | null;
  setError: (e: string | null) => void;
}

/**
 * Composite hook orchestrating all Seed wizard state by composing
 * focused sub-hooks for org selection, object selection, field config,
 * relations, and execution.
 *
 * Pure-UI wizard state (org/objects/relations/persona/error) lives in
 * `useSeedWizardStore` so step sections can subscribe to their own
 * slices; this hook stays the single facade used by SeedPage. The store
 * is reset on mount/unmount — same lifecycle as component-local state —
 * and the persisted draft is re-applied right after the reset.
 */
export function useSeedWizardState(t: TFunction): SeedWizardState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const defaultSeedDraft: SeedDraftState = {
    currentStep: 0,
    selectedOrgId: '',
    selectedObjects: [],
    volumes: {},
    nl2soqlQuery: '',
  };

  const [draft, setDraft] = useWebviewPersistedState<SeedDraftState>('seedDraft', defaultSeedDraft);
  const initialDraft = useRef(draft);

  const [currentStep, setCurrentStep] = useState(initialDraft.current.currentStep);
  const error = useSeedWizardStore((s) => s.error);
  const setError = useSeedWizardStore((s) => s.setError);
  const selectedPersona = useSeedWizardStore((s) => s.selectedPersona);
  const setSelectedPersona = useSeedWizardStore((s) => s.setSelectedPersona);

  /* ------------------------------------------------------------------ */
  /* Sub-hooks                                                           */
  /* ------------------------------------------------------------------ */
  const orgSelection = useSeedOrgSelection();
  const objectSelection = useSeedObjectSelection(orgSelection.selectedOrgId);
  const fieldConfig = useSeedFieldConfig(
    orgSelection.selectedOrgId,
    objectSelection.selectedObjects,
    currentStep,
    t,
  );
  const relations = useSeedRelations(fieldConfig.fieldConfigs, fieldConfig.volumes);
  const nl2soqlState = useSeedNL2SOQL(orgSelection.selectedOrgId);
  const execution = useSeedExecution(
    orgSelection.selectedOrgId,
    objectSelection.selectedObjects,
    fieldConfig.volumes,
    fieldConfig.fieldConfigs,
    t,
    relations.checked,
  );

  /* ------------------------------------------------------------------ */
  /* Store lifecycle + draft persistence — reset & restore on mount      */
  /* ------------------------------------------------------------------ */
  const restoreDraft = useLatestRef(() => {
    const store = useSeedWizardStore.getState();
    // Fresh wizard on every page mount (the store mirrors component-local
    // state), then re-apply the persisted draft.
    store.resetSeedWizard();
    const saved = initialDraft.current;
    if (saved.selectedOrgId) {
      store.handleOrgSelect(saved.selectedOrgId);
    }
    for (const objName of saved.selectedObjects) {
      store.handleToggleObject(objName);
    }
    if (saved.nl2soqlQuery) {
      nl2soqlState.setNl2soqlQuery(saved.nl2soqlQuery);
    }
  });
  useEffect(() => {
    restoreDraft.current();
    return () => {
      useSeedWizardStore.getState().resetSeedWizard();
    };
  }, [restoreDraft]);

  /* Draft persistence — save on form state changes */
  useEffect(() => {
    setDraft({
      currentStep,
      selectedOrgId: orgSelection.selectedOrgId,
      selectedObjects: objectSelection.selectedObjects,
      volumes: fieldConfig.volumes,
      nl2soqlQuery: nl2soqlState.nl2soqlQuery,
    });
  }, [
    currentStep,
    orgSelection.selectedOrgId,
    objectSelection.selectedObjects,
    fieldConfig.volumes,
    nl2soqlState.nl2soqlQuery,
    setDraft,
  ]);

  /* ------------------------------------------------------------------ */
  /* Error aggregation                                                   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const bridgeError = objectSelection.describeError ?? execution.executionError;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('seed.title'),
        message: bridgeError,
      });
    }
  }, [objectSelection.describeError, execution.executionError, setError, addNotification, t]);

  /* Navigate to results step when execution completes */
  useEffect(() => {
    if (execution.executionCompletedStep !== null) {
      setCurrentStep(execution.executionCompletedStep);
    }
  }, [execution.executionCompletedStep]);

  /* ------------------------------------------------------------------ */
  /* Persona application                                                 */
  /* ------------------------------------------------------------------ */
  // The deps below name specific fields of `fieldConfig` instead of the full
  // object. `useSeedFieldConfig` rebuilds its return object on every render
  // even when the underlying state is unchanged, so depending on `fieldConfig`
  // itself would trigger a re-run on every parent render. Taking the method
  // and the length out of it first lets the dependency arrays say so.
  const { applyPersona } = fieldConfig;
  const fieldConfigCount = fieldConfig.fieldConfigs.length;
  const applySelectedPersona = useCallback((): number => {
    if (!selectedPersona) return 0;
    return applyPersona(selectedPersona);
  }, [selectedPersona, applyPersona]);

  /* Auto-apply a newly picked persona to the objects already described.
     Objects described later receive it in useSeedFieldRules as they arrive. */
  const personaAppliedRef = useRef<string | null>(null);
  // Same rationale as applySelectedPersona above: depend on the specific
  // method + length scalar, not the full fieldConfig object.
  useEffect(() => {
    if (
      selectedPersona &&
      fieldConfigCount > 0 &&
      personaAppliedRef.current !== selectedPersona.id
    ) {
      personaAppliedRef.current = selectedPersona.id;
      applyPersona(selectedPersona);
    }
  }, [selectedPersona, fieldConfigCount, applyPersona]);

  /* ------------------------------------------------------------------ */
  /* Navigation guards                                                   */
  /* ------------------------------------------------------------------ */
  // A relation row with a problem would be left out of the run, and its child
  // seeded with parents picked at random or none: the wizard waits for it.
  const { relationsReady } = relations;
  // The rules of an object come from its describe. Sent before it arrived,
  // the object carried none and the run refused it: below five objects the
  // configure step is skipped, and every such run was sent that way.
  const { fieldsReady } = fieldConfig;
  const canGoNext = useMemo((): boolean => {
    switch (currentStep) {
      case 0:
        return !!orgSelection.selectedOrgId && objectSelection.selectedObjects.length > 0;
      case 1:
        return relationsReady;
      // The last step sends the run, and its button stayed live while the run
      // was in flight: a second press sent the whole template again.
      case 2:
      case 3:
        return !execution.isRunning && relationsReady && fieldsReady;
      default:
        return true;
    }
  }, [
    currentStep,
    orgSelection.selectedOrgId,
    objectSelection.selectedObjects.length,
    execution.isRunning,
    relationsReady,
    fieldsReady,
  ]);

  const isFinished = currentStep === 3 && !!execution.executionResult;

  return {
    currentStep,
    setCurrentStep,
    canGoNext,
    isFinished,
    ...orgSelection,
    ...objectSelection,
    ...fieldConfig,
    ...relations,
    ...nl2soqlState,
    ...execution,
    selectedPersona,
    setSelectedPersona,
    applySelectedPersona,
    error,
    setError,
  };
}
