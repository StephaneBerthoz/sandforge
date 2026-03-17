import { useState, useEffect, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { SalesforceOrg, SeedExecutionResult, FieldRuleType } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useNL2SOQL } from '../../hooks/useAIFeatures';
import type { SeedObjectInfo } from './Step2_SelectObjects';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { SeedRelation } from './Step4_ConfigureRelations';
import type { ObjectProgress } from './Step7_Execute';
import { useSeedOrgSelection } from './useSeedOrgSelection';
import { useSeedObjectSelection } from './useSeedObjectSelection';
import { useSeedFieldConfig } from './useSeedFieldConfig';
import { useSeedRelations } from './useSeedRelations';
import { useSeedExecution } from './useSeedExecution';
import { useSeedNL2SOQL } from './useSeedNL2SOQL';

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
  handleChangeFieldRule: (objectApiName: string, fieldApiName: string, ruleType: FieldRuleType) => void;
  handleChangeFieldConfig: (objectApiName: string, fieldApiName: string, key: string, value: string) => void;

  /* Relations */
  relations: SeedRelation[];
  handleAddRelation: () => void;
  handleRemoveRelation: (index: number) => void;
  handleChangeRelation: (index: number, field: keyof SeedRelation, value: string) => void;

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
  handleExecute: () => void;
  objectProgress: ObjectProgress[];

  /* Error */
  error: string | null;
  setError: (e: string | null) => void;
}

/**
 * Composite hook orchestrating all Seed wizard state by composing
 * focused sub-hooks for org selection, object selection, field config,
 * relations, and execution.
 */
export function useSeedWizardState(t: TFunction): SeedWizardState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
  const relations = useSeedRelations();
  const nl2soqlState = useSeedNL2SOQL(orgSelection.selectedOrgId);
  const execution = useSeedExecution(
    orgSelection.selectedOrgId,
    objectSelection.selectedObjects,
    fieldConfig.volumes,
    fieldConfig.fieldConfigs,
    t,
  );

  /* ------------------------------------------------------------------ */
  /* Error aggregation                                                   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const bridgeError = objectSelection.describeError ?? execution.executionError;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({ level: 'error', title: t('seed.title'), message: bridgeError, autoDismissMs: 5000 });
    }
  }, [objectSelection.describeError, execution.executionError, addNotification, t]);

  /* Navigate to results step when execution completes */
  useEffect(() => {
    if (execution.executionCompletedStep !== null) {
      setCurrentStep(execution.executionCompletedStep);
    }
  }, [execution.executionCompletedStep]);

  /* ------------------------------------------------------------------ */
  /* Navigation guards                                                   */
  /* ------------------------------------------------------------------ */
  const canGoNext = useMemo((): boolean => {
    switch (currentStep) {
      case 0: return !!orgSelection.selectedOrgId && objectSelection.selectedObjects.length > 0;
      case 2: return !execution.isRunning;
      default: return true;
    }
  }, [currentStep, orgSelection.selectedOrgId, objectSelection.selectedObjects.length, execution.isRunning]);

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
    error,
    setError,
  };
}
