import { useState, useCallback } from 'react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import type { SeedObjectInfo } from './Step2_SelectObjects';

/** Return type for the useSeedObjectSelection hook. */
export interface SeedObjectSelectionState {
  /** List of objects available for seeding from the org describe. */
  availableObjects: SeedObjectInfo[];
  /** Whether the describe-global query is in flight. */
  loadingObjects: boolean;
  /** API names of currently selected objects. */
  selectedObjects: string[];
  /** Toggle an object in/out of the selection. */
  handleToggleObject: (apiName: string) => void;
  /** Error from the describe-global query, if any. */
  describeError: string | undefined;
}

/**
 * Hook managing object selection state for the Seed wizard.
 * Fetches the list of available objects when an org is selected.
 */
export function useSeedObjectSelection(selectedOrgId: string): SeedObjectSelectionState {
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);

  const describeGlobalQuery = useBridgeQuery<{ objects: SeedObjectInfo[] }>(
    'seed:describe-global',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'seed:describe-global:response', skip: !selectedOrgId },
  );

  const availableObjects = describeGlobalQuery.data?.objects ?? [];
  const loadingObjects = describeGlobalQuery.loading;

  const handleToggleObject = useCallback((apiName: string) => {
    setSelectedObjects((prev) =>
      prev.includes(apiName) ? prev.filter((o) => o !== apiName) : [...prev, apiName],
    );
  }, []);

  return {
    availableObjects,
    loadingObjects,
    selectedObjects,
    handleToggleObject,
    describeError: describeGlobalQuery.error ?? undefined,
  };
}
