import { useState, useCallback } from 'react';
import { useNL2SOQL } from '../../hooks/useAIFeatures';

/** Return type for the useSeedNL2SOQL hook. */
export interface SeedNL2SOQLState {
  /** NL2SOQL query input value. */
  nl2soqlQuery: string;
  /** Update NL2SOQL query input value. */
  setNl2soqlQuery: (q: string) => void;
  /** Trigger NL2SOQL conversion. */
  handleNl2soql: () => void;
  /** NL2SOQL mutation state. */
  nl2soql: ReturnType<typeof useNL2SOQL>;
}

/**
 * Hook managing NL2SOQL (natural language to SOQL) conversion for the Seed wizard.
 *
 * Provides input state management and mutation trigger for converting
 * natural language queries into SOQL via the AI backend.
 */
export function useSeedNL2SOQL(selectedOrgId: string): SeedNL2SOQLState {
  const [nl2soqlQuery, setNl2soqlQuery] = useState('');
  const nl2soql = useNL2SOQL();

  const handleNl2soql = useCallback(() => {
    if (!nl2soqlQuery.trim() || !selectedOrgId) return;
    nl2soql.mutate({ query: nl2soqlQuery.trim(), orgId: selectedOrgId });
  }, [nl2soqlQuery, selectedOrgId, nl2soql]);

  return {
    nl2soqlQuery,
    setNl2soqlQuery,
    handleNl2soql,
    nl2soql,
  };
}
