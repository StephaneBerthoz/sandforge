import { useState, useCallback } from 'react';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';

/** Return type for the useSeedOrgSelection hook. */
export interface SeedOrgSelectionState {
  /** Currently selected org identifier. */
  selectedOrgId: string;
  /** Handler to update the selected org. */
  handleOrgSelect: (orgId: string) => void;
  /** Resolved org object matching selectedOrgId, if any. */
  selectedOrg: SalesforceOrg | undefined;
}

/** Hook managing org selection state for the Seed wizard. */
export function useSeedOrgSelection(): SeedOrgSelectionState {
  const orgs = useOrgStore((s) => s.orgs);
  const [selectedOrgId, setSelectedOrgId] = useState('');

  const handleOrgSelect = useCallback((orgId: string) => {
    setSelectedOrgId(orgId);
  }, []);

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId);

  return {
    selectedOrgId,
    handleOrgSelect,
    selectedOrg,
  };
}
