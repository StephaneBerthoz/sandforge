import { useMemo } from 'react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
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
 * Selection state lives in `useSeedWizardStore`.
 */
export function useSeedObjectSelection(selectedOrgId: string): SeedObjectSelectionState {
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const handleToggleObject = useSeedWizardStore((s) => s.handleToggleObject);

  const describeGlobalQuery = useBridgeQuery<{ objects: SeedObjectInfo[] }>(
    'seed:describe-global',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'seed:describe-global:response', skip: !selectedOrgId },
  );

  // Memoised fallback keeps referential stability when no data is loaded.
  const availableObjects = useMemo(
    () => describeGlobalQuery.data?.objects ?? [],
    [describeGlobalQuery.data?.objects],
  );
  const loadingObjects = describeGlobalQuery.loading;

  return {
    availableObjects,
    loadingObjects,
    selectedObjects,
    handleToggleObject,
    describeError: describeGlobalQuery.error ?? undefined,
  };
}
