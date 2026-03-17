import { useMemo } from 'react';

import type { TFunction } from 'i18next';
import type { FieldRuleType } from '@sandforge/shared';

import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { PIIObjectResult } from './useSeedWizardState';
import { useSeedFieldRules } from './useSeedFieldRules';
import { useSeedVolumes } from './useSeedVolumes';
import { useSeedPIIScan } from './useSeedPIIScan';

/** Return type for the useSeedFieldConfig hook. */
export interface SeedFieldConfigState {
  /** Per-object field configurations. */
  fieldConfigs: ObjectFieldConfig[];
  /** Change the generation rule type for a specific field. */
  handleChangeFieldRule: (objectApiName: string, fieldApiName: string, ruleType: FieldRuleType) => void;
  /** Change a configuration parameter for a specific field rule. */
  handleChangeFieldConfig: (objectApiName: string, fieldApiName: string, key: string, value: string) => void;
  /** PII scan results per object. */
  piiResults: PIIObjectResult[];
  /** Whether any object has PII warnings. */
  hasPiiWarnings: boolean;
  /** Whether the PII scan is in progress. */
  piiLoading: boolean;
  /** Volume configuration per object. */
  volumes: Record<string, { count: number; batchSize: number }>;
  /** Update the record count for an object. */
  handleChangeVolume: (objectApiName: string, count: number) => void;
  /** Update the batch size for an object. */
  handleChangeBatchSize: (objectApiName: string, size: number) => void;
  /** Error from field describe or PII scan mutations, if any. */
  fieldError: string | undefined;
}

/**
 * Composition facade that orchestrates field rules, volume settings,
 * and PII scanning for the Seed wizard.
 *
 * Delegates to three focused sub-hooks:
 * - `useSeedFieldRules` — field selection and rule management
 * - `useSeedVolumes` — record counts and batch sizes per object
 * - `useSeedPIIScan` — PII scan mutation, results, error notification
 */
export function useSeedFieldConfig(
  selectedOrgId: string,
  selectedObjects: string[],
  currentStep: number,
  t: TFunction,
): SeedFieldConfigState {
  const fieldRules = useSeedFieldRules(selectedOrgId, selectedObjects, currentStep);
  const volumeConfig = useSeedVolumes();
  const piiScan = useSeedPIIScan(selectedOrgId, selectedObjects, currentStep, t);

  return useMemo((): SeedFieldConfigState => ({
    fieldConfigs: fieldRules.fieldConfigs,
    handleChangeFieldRule: fieldRules.handleChangeFieldRule,
    handleChangeFieldConfig: fieldRules.handleChangeFieldConfig,
    piiResults: piiScan.piiResults,
    hasPiiWarnings: piiScan.hasPiiWarnings,
    piiLoading: piiScan.piiLoading,
    volumes: volumeConfig.volumes,
    handleChangeVolume: volumeConfig.handleChangeVolume,
    handleChangeBatchSize: volumeConfig.handleChangeBatchSize,
    fieldError: piiScan.piiError,
  }), [
    fieldRules.fieldConfigs,
    fieldRules.handleChangeFieldRule,
    fieldRules.handleChangeFieldConfig,
    piiScan.piiResults,
    piiScan.hasPiiWarnings,
    piiScan.piiLoading,
    piiScan.piiError,
    volumeConfig.volumes,
    volumeConfig.handleChangeVolume,
    volumeConfig.handleChangeBatchSize,
  ]);
}
