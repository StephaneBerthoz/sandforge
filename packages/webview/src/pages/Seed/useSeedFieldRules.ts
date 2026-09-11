import { useState, useEffect, useCallback } from 'react';

import type { FieldRuleType, PersonaMsg, PersonaFieldPatternMsg } from '@sandforge/shared';
import { personaPatternToFieldRule } from '@sandforge/shared';

import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { ObjectFieldConfig, FieldConfig } from './Step3_ConfigureFields';

/** Field description from describe-object response. */
interface DescribedField {
  fieldApiName: string;
  label: string;
  type: string;
  required: boolean;
  picklistValues: string[];
  referenceTo: string[];
  length: number;
}

/** Return type for the useSeedFieldRules hook. */
export interface SeedFieldRulesState {
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
  /**
   * Apply a persona's data patterns to field configs.
   * For each field matching a key in persona.dataPatterns, sets the rule type
   * and config from the pattern.
   *
   * @param persona - The persona whose data patterns to apply
   * @returns The number of fields that were matched and configured
   */
  applyPersona: (persona: PersonaMsg) => number;
}

/**
 * Hook managing field selection and rule configuration for the Seed wizard.
 *
 * Fetches field metadata via the describe-fields bridge mutation and exposes
 * handlers to update rule types and configuration parameters per field.
 */
export function useSeedFieldRules(
  selectedOrgId: string,
  selectedObjects: string[],
  currentStep: number,
): SeedFieldRulesState {
  const [fieldConfigs, setFieldConfigs] = useState<ObjectFieldConfig[]>([]);

  const describeFieldsMutation = useBridgeMutation<{
    objectApiName: string;
    objectLabel: string;
    fields: DescribedField[];
  }>('seed:describe-object', { responseType: 'seed:describe-object:response' });

  /* Map describe-fields response into fieldConfigs state */
  useEffect(() => {
    if (!describeFieldsMutation.data) return;
    const { objectApiName, objectLabel, fields } = describeFieldsMutation.data;
    const fieldConfig: ObjectFieldConfig = {
      objectApiName,
      objectLabel,
      fields: fields.map(
        (f: DescribedField): FieldConfig => ({
          fieldApiName: f.fieldApiName,
          label: f.label,
          type: f.type,
          required: f.required,
          ruleType:
            f.referenceTo.length > 0
              ? 'reference'
              : f.type === 'picklist'
                ? 'picklist_random'
                : 'faker',
          config:
            f.referenceTo.length > 0
              ? { referenceObject: f.referenceTo[0], referenceField: 'Id' }
              : {},
        }),
      ),
    };

    setFieldConfigs((prev) => {
      const existing = prev.findIndex((c) => c.objectApiName === objectApiName);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = fieldConfig;
        return next;
      }
      return [...prev, fieldConfig];
    });
  }, [describeFieldsMutation.data]);

  const describeFieldsMutate = describeFieldsMutation.mutate;

  /* Fetch field details when entering configure step */
  useEffect(() => {
    if (currentStep === 1 && selectedOrgId && selectedObjects.length > 0) {
      const missing = selectedObjects.filter(
        (o) => !fieldConfigs.some((c) => c.objectApiName === o),
      );
      if (missing.length > 0) {
        for (const objectApiName of missing) {
          describeFieldsMutate({ orgId: selectedOrgId, objectApiName });
        }
      }
    }
  }, [currentStep, selectedOrgId, selectedObjects, fieldConfigs, describeFieldsMutate]);

  const handleChangeFieldRule = useCallback(
    (objectApiName: string, fieldApiName: string, ruleType: FieldRuleType) => {
      setFieldConfigs((prev) =>
        prev.map((obj) =>
          obj.objectApiName === objectApiName
            ? {
                ...obj,
                fields: obj.fields.map((f) =>
                  f.fieldApiName === fieldApiName ? { ...f, ruleType, config: {} } : f,
                ),
              }
            : obj,
        ),
      );
    },
    [],
  );

  const handleChangeFieldConfig = useCallback(
    (objectApiName: string, fieldApiName: string, key: string, value: string) => {
      setFieldConfigs((prev) =>
        prev.map((obj) =>
          obj.objectApiName === objectApiName
            ? {
                ...obj,
                fields: obj.fields.map((f) =>
                  f.fieldApiName === fieldApiName
                    ? { ...f, config: { ...f.config, [key]: value } }
                    : f,
                ),
              }
            : obj,
        ),
      );
    },
    [],
  );

  const applyPersona = useCallback((persona: PersonaMsg): number => {
    let matchedCount = 0;

    setFieldConfigs((prev) =>
      prev.map((obj) => ({
        ...obj,
        fields: obj.fields.map((field) => {
          const pattern: PersonaFieldPatternMsg | undefined =
            persona.dataPatterns[field.fieldApiName];
          if (!pattern) return field;

          // Persona vocabulary (`generator` + free-form `params`) → seed
          // contract (`FieldRuleType` + `FieldRuleConfig`). Both shapes are
          // declared in @sandforge/shared, and so is the translation.
          const rule = personaPatternToFieldRule(pattern);
          if (!rule) return field;

          matchedCount++;

          return { ...field, ruleType: rule.ruleType, config: { ...rule.config } };
        }),
      })),
    );

    return matchedCount;
  }, []);

  return {
    fieldConfigs,
    handleChangeFieldRule,
    handleChangeFieldConfig,
    applyPersona,
  };
}
