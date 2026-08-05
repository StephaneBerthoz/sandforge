import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';

/** Step1 props. */
export interface Step1SelectOrgProps {
  orgs: SalesforceOrg[];
  selectedOrgId: string;
  onSelect: (orgId: string) => void;
}

/** Step 1 — Select the target org for seeding. */
export const Step1SelectOrg: React.FC<Step1SelectOrgProps> = ({
  orgs,
  selectedOrgId,
  onSelect,
}) => {
  const { t } = useTranslation();
  const options = orgs.map((org) => ({
    value: org.id,
    label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
  }));

  return (
    <div className="flex flex-col gap-4" data-testid="step-select-org">
      <p className="text-xs text-[var(--sf-text-secondary)]">{t('seed.selectOrgDesc')}</p>
      <Select
        label={t('seed.selectOrg')}
        options={options}
        value={selectedOrgId}
        onChange={(e) => onSelect(e.target.value)}
        placeholder={t('seed.selectOrg')}
      />
    </div>
  );
};
