import { useState, useEffect, useCallback, useRef } from 'react';

import type { FieldRuleType, PersonaMsg, PersonaFieldPatternMsg } from '@sandforge/shared';
import {
  acceptsGeneratedSentence,
  defaultFakerMethod,
  describedFieldRule,
  personaPatternToFieldRule,
} from '@sandforge/shared';

import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import type { ObjectFieldConfig, FieldConfig } from './Step3_ConfigureFields';

/**
 * The field length the described rule carries, kept when a persona or a rule
 * change replaces the rest of the config: without it a generated value is not
 * cut to the field and the insert fails with STRING_TOO_LONG.
 */
function lengthOf(field: FieldConfig): { maxLength?: number } {
  const maxLength = field.config['maxLength'];
  return typeof maxLength === 'number' ? { maxLength } : {};
}

/**
 * The config a field starts with under a newly chosen rule type. A faker rule
 * names its default method: SeedValidator refuses one that names none.
 */
function configForRuleType(field: FieldConfig, ruleType: FieldRuleType): Record<string, unknown> {
  // A random pick names the values it picks from, as the described rule did:
  // SeedValidator refuses one that names none.
  if (ruleType === 'picklist_random' && (field.picklistValues?.length ?? 0) > 0) {
    return { picklistValues: [...(field.picklistValues ?? [])], ...lengthOf(field) };
  }
  const fakerMethod =
    ruleType === 'faker' ? defaultFakerMethod(field.type, field.fieldApiName) : undefined;
  return fakerMethod ? { fakerMethod, ...lengthOf(field) } : { ...lengthOf(field) };
}

/**
 * Give every field a persona has a pattern for the rule that pattern
 * translates to, and count them. Fields without a pattern, or whose generator
 * has no rule type, are returned unchanged.
 */
function applyPersonaToFields(
  fields: FieldConfig[],
  persona: PersonaMsg,
): { fields: FieldConfig[]; matched: number } {
  let matched = 0;
  const next = fields.map((field) => {
    const pattern: PersonaFieldPatternMsg | undefined = persona.dataPatterns[field.fieldApiName];
    if (!pattern) return field;

    // Persona vocabulary (`generator` + free-form `params`) → seed
    // contract (`FieldRuleType` + `FieldRuleConfig`). Both shapes are
    // declared in @sandforge/shared, and so is the translation.
    const rule = personaPatternToFieldRule(pattern);
    if (!rule) return field;
    // The described type decides, not the one the persona assumed: AI
    // generation writes text, which the run refuses on any other field.
    if (rule.ruleType === 'ai_generate' && !acceptsGeneratedSentence(field.type)) return field;

    matched++;
    return { ...field, ruleType: rule.ruleType, config: { ...rule.config, ...lengthOf(field) } };
  });
  return { fields: next, matched };
}

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
  const fieldConfigsRef = useRef(fieldConfigs);
  fieldConfigsRef.current = fieldConfigs;

  // Read through a ref so that picking a persona does not re-run the describe
  // mapping below, which would reset the last described object's rules.
  const selectedPersona = useSeedWizardStore((s) => s.selectedPersona);
  const selectedPersonaRef = useRef(selectedPersona);
  selectedPersonaRef.current = selectedPersona;

  const describeFieldsMutation = useBridgeMutation<{
    objectApiName: string;
    objectLabel: string;
    fields: DescribedField[];
  }>('seed:describe-object', { responseType: 'seed:describe-object:response' });

  /* Map describe-fields response into fieldConfigs state */
  useEffect(() => {
    if (!describeFieldsMutation.data) return;
    const { objectApiName, objectLabel, fields } = describeFieldsMutation.data;
    const describedFields = fields.map((f: DescribedField): FieldConfig => {
      const rule = describedFieldRule(f);
      return {
        fieldApiName: f.fieldApiName,
        label: f.label,
        type: f.type,
        required: f.required,
        ruleType: rule.ruleType,
        config: { ...rule.config },
        ...(f.picklistValues.length > 0 ? { picklistValues: [...f.picklistValues] } : {}),
        ...(f.referenceTo.length > 0 ? { referenceTo: [...f.referenceTo] } : {}),
      };
    });
    // Objects are described one at a time, and the wizard applies a persona
    // once per persona: an object whose describe arrived after that got none
    // of its rules. The selected persona now shapes each object as it arrives.
    const persona = selectedPersonaRef.current;
    const fieldConfig: ObjectFieldConfig = {
      objectApiName,
      objectLabel,
      fields: persona ? applyPersonaToFields(describedFields, persona).fields : describedFields,
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
                  f.fieldApiName === fieldApiName
                    ? { ...f, ruleType, config: configForRuleType(f, ruleType) }
                    : f,
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
    // Counted from the configs of the last render, not inside the updater: the
    // wizard applies a persona from an effect that runs right after a
    // fieldConfigs update, when React defers the updater, so a counter
    // incremented there was still 0 when this function returned.
    const matched = fieldConfigsRef.current.reduce(
      (sum, obj) => sum + applyPersonaToFields(obj.fields, persona).matched,
      0,
    );
    setFieldConfigs((prev) =>
      prev.map((obj) => ({ ...obj, fields: applyPersonaToFields(obj.fields, persona).fields })),
    );
    return matched;
  }, []);

  return {
    fieldConfigs,
    handleChangeFieldRule,
    handleChangeFieldConfig,
    applyPersona,
  };
}
