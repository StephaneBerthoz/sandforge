import { useState, useCallback, useMemo } from 'react';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import type { PersonaMsg, PersonaFieldPatternMsg } from '@sandforge/shared';

/** State and actions for persona management. */
export interface UsePersonasReturn {
  /** List of all personas (built-in + custom). */
  personas: PersonaMsg[];
  /** Whether the persona list is loading. */
  loading: boolean;
  /** Error from fetching personas. */
  error: string | null;
  /** Currently selected persona for customization. */
  selectedPersona: PersonaMsg | null;
  /** Currently previewed persona (popover target). */
  previewedPersona: PersonaMsg | null;
  /** Whether a custom persona creation is in progress. */
  isCreating: boolean;
  /** Description text for custom persona creation. */
  customDescription: string;
  /** Select a persona by ID for customization. */
  selectPersona: (id: string) => void;
  /** Open preview for a persona by ID. */
  openPreview: (id: string) => void;
  /** Close the preview popover. */
  closePreview: () => void;
  /** Clear the current selection. */
  clearSelection: () => void;
  /** Update the custom persona description. */
  setCustomDescription: (desc: string) => void;
  /** Create a custom persona from the current description. */
  createCustom: () => void;
  /** Generate 5 sample records from a persona's data patterns. */
  generateSampleRecords: (persona: PersonaMsg) => Record<string, string>[];
  /** Refetch the persona list. */
  refetch: () => void;
}

/**
 * Generate a single field value from a PersonaFieldPattern.
 * Uses the examples array cyclically. No network call.
 */
function generateFieldValue(pattern: PersonaFieldPatternMsg, rowIndex: number): string {
  if (pattern.examples.length === 0) {
    return '';
  }
  return pattern.examples[rowIndex % pattern.examples.length];
}

/**
 * Generate 5 sample records client-side from persona data patterns.
 * Each record maps field names to sample values picked cyclically from examples.
 *
 * @param persona - The persona whose data patterns to use
 * @returns Array of 5 records with field name keys and string values
 */
export function generateSampleRecords(persona: PersonaMsg): Record<string, string>[] {
  const fields = Object.entries(persona.dataPatterns);
  const records: Record<string, string>[] = [];

  for (let i = 0; i < 5; i++) {
    const record: Record<string, string> = {};
    for (const [fieldName, pattern] of fields) {
      record[fieldName] = generateFieldValue(pattern, i);
    }
    records.push(record);
  }

  return records;
}

/**
 * Hook for managing persona list, selection, preview, and custom creation.
 *
 * Fetches the persona list via `seed:list-personas` bridge message on mount.
 * Provides methods to select, preview, and create custom personas.
 */
export function usePersonas(): UsePersonasReturn {
  const query = useBridgeQuery<{ personas: PersonaMsg[] }>('seed:list-personas');
  const createMutation = useBridgeMutation<{ persona: PersonaMsg; success: boolean; error?: string }>('seed:create-persona');

  const [selectedPersona, setSelectedPersona] = useState<PersonaMsg | null>(null);
  const [previewedPersona, setPreviewedPersona] = useState<PersonaMsg | null>(null);
  const [customDescription, setCustomDescription] = useState('');

  const personas = useMemo(
    () => query.data?.personas ?? [],
    [query.data],
  );

  const selectPersona = useCallback(
    (id: string) => {
      const found = personas.find((p) => p.id === id) ?? null;
      setSelectedPersona(found);
    },
    [personas],
  );

  const openPreview = useCallback(
    (id: string) => {
      const found = personas.find((p) => p.id === id) ?? null;
      setPreviewedPersona(found);
    },
    [personas],
  );

  const closePreview = useCallback(() => {
    setPreviewedPersona(null);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPersona(null);
  }, []);

  const createCustom = useCallback(() => {
    if (customDescription.trim().length === 0) return;
    createMutation.mutate({ description: customDescription.trim() });
  }, [customDescription, createMutation]);

  const generateSampleRecordsFn = useCallback(
    (persona: PersonaMsg) => generateSampleRecords(persona),
    [],
  );

  return {
    personas,
    loading: query.loading,
    error: query.error,
    selectedPersona,
    previewedPersona,
    isCreating: createMutation.loading,
    customDescription,
    selectPersona,
    openPreview,
    closePreview,
    clearSelection,
    setCustomDescription,
    createCustom,
    generateSampleRecords: generateSampleRecordsFn,
    refetch: query.refetch,
  };
}
