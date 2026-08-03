import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import type { SalesforceOrg } from '@sandforge/shared';

/** Props for the org selection card. */
export interface ForgeOrgCardProps {
  /** i18n key for the card label (e.g. "forge.sourceOrg"). */
  labelKey: string;
  /** Currently selected org, or undefined if none selected. */
  org: SalesforceOrg | undefined;
  /** ID of the currently selected org. */
  orgId: string;
  /** Callback when the user selects a different org. */
  onOrgChange: (id: string) => void;
  /** All available orgs for the dropdown. */
  orgs: SalesforceOrg[];
  /** data-testid for the select element. */
  testId: string;
}

/** Org selection card with custom dropdown, alias, and username. */
export const ForgeOrgCard: React.FC<ForgeOrgCardProps> = ({
  labelKey,
  org,
  orgId,
  onOrgChange,
  orgs,
  testId,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-all',
        org ? 'border-subtle bg-surface-1' : 'border-dashed border-subtle bg-surface-1/50',
      )}
    >
      <div className="text-[10px] text-text-muted uppercase tracking-widest mb-1.5">
        {t(labelKey)}
      </div>
      <OrgDropdown
        value={orgId}
        onChange={onOrgChange}
        orgs={orgs}
        ariaLabel={t(labelKey)}
        testId={testId}
      />
      {org && <div className="text-[10px] text-text-muted mt-1 truncate">{org.username}</div>}
    </div>
  );
};
