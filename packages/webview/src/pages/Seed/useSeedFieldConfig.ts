import { useMemo } from 'react';

import type { FieldRuleType, PersonaMsg } from '@sandforge/shared';

import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import { useSeedFieldRules } from './useSeedFieldRules';
import { useSeedVolumes } from './useSeedVolumes';

/** Return type for the useSeedFieldConfig hook. */
export interface SeedFieldConfigState {
  /** Per-object field configurations. */
  fieldConfigs: ObjectFieldConfig[];
  /** Change the generation rule type for a specific field. */
  handleChangeFieldRule: (
    objectApiName: string,
    fieldApiName: string,
    ruleType: FieldRuleType,
  ) => void;
  /** Change a configuration parameter for a specific field rule. */
  handleChangeFieldConfig: (
    objectApiName: string,
    fieldApiName: string,
    key: string,
    value: string,
  ) => void;
  /** Apply a persona's data patterns to field configs. Returns matched field count. */
  applyPersona: (persona: PersonaMsg) => number;
  /** Whether every selected object has been described; the run waits for it. */
  fieldsReady: boolean;
  /** Why the last describe failed, while an object still waits for one; null otherwise. */
  fieldsError: string | null;
  /** Ask again for the objects not described yet. */
  retryFieldDescribes: () => void;
  /** Volume configuration per object. */
  volumes: Record<string, { count: number; batchSize: number }>;
  /** Update the record count for an object. */
  handleChangeVolume: (objectApiName: string, count: number) => void;
  /** Update the batch size for an object. */
  handleChangeBatchSize: (objectApiName: string, size: number) => void;
}

/**
 * Composition facade that orchestrates field rules and volume settings for
 * the Seed wizard.
 *
 * Delegates to two focused sub-hooks:
 * - `useSeedFieldRules` — field selection and rule management
 * - `useSeedVolumes` — record counts and batch sizes per object
 *
 * It also scanned the objects for personal data on the configure step, and
 * listed what it found as fields to anonymize: on a seed, whose every value
 * is generated, there was nothing to anonymize.
 */
export function useSeedFieldConfig(
  selectedOrgId: string,
  selectedObjects: string[],
  currentStep: number,
): SeedFieldConfigState {
  const fieldRules = useSeedFieldRules(selectedOrgId, selectedObjects, currentStep);
  const volumeConfig = useSeedVolumes();

  return useMemo(
    (): SeedFieldConfigState => ({
      fieldConfigs: fieldRules.fieldConfigs,
      handleChangeFieldRule: fieldRules.handleChangeFieldRule,
      handleChangeFieldConfig: fieldRules.handleChangeFieldConfig,
      applyPersona: fieldRules.applyPersona,
      fieldsReady: fieldRules.fieldsReady,
      fieldsError: fieldRules.fieldsError,
      retryFieldDescribes: fieldRules.retryFieldDescribes,
      volumes: volumeConfig.volumes,
      handleChangeVolume: volumeConfig.handleChangeVolume,
      handleChangeBatchSize: volumeConfig.handleChangeBatchSize,
    }),
    [
      fieldRules.fieldConfigs,
      fieldRules.handleChangeFieldRule,
      fieldRules.handleChangeFieldConfig,
      fieldRules.applyPersona,
      fieldRules.fieldsReady,
      fieldRules.fieldsError,
      fieldRules.retryFieldDescribes,
      volumeConfig.volumes,
      volumeConfig.handleChangeVolume,
      volumeConfig.handleChangeBatchSize,
    ],
  );
}
