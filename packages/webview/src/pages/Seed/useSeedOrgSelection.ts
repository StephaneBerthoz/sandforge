import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';

/** Return type for the useSeedOrgSelection hook. */
export interface SeedOrgSelectionState {
  /** Currently selected org identifier. */
  selectedOrgId: string;
  /** Handler to update the selected org. */
  handleOrgSelect: (orgId: string) => void;
  /** Resolved org object matching selectedOrgId, if any. */
  selectedOrg: SalesforceOrg | undefined;
}

/**
 * Hook managing org selection state for the Seed wizard.
 * State lives in `useSeedWizardStore`; this hook derives the resolved org.
 */
export function useSeedOrgSelection(): SeedOrgSelectionState {
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useSeedWizardStore((s) => s.selectedOrgId);
  const handleOrgSelect = useSeedWizardStore((s) => s.handleOrgSelect);

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId);

  return {
    selectedOrgId,
    handleOrgSelect,
    selectedOrg,
  };
}
