import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';

/** OrgSelector component props. */
export interface OrgSelectorProps {
  orgs: SalesforceOrg[];
  sourceOrgId: string;
  targetOrgId: string;
  onSourceChange: (orgId: string) => void;
  onTargetChange: (orgId: string) => void;
  className?: string;
}

/** Format org label with type badge. */
function formatOrgLabel(org: SalesforceOrg): string {
  const name = org.alias || org.username;
  const type = String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]';
  return `${name} ${type}`;
}

/** Side-by-side org selectors for source and target. */
export const OrgSelector: React.FC<OrgSelectorProps> = ({
  orgs,
  sourceOrgId,
  targetOrgId,
  onSourceChange,
  onTargetChange,
  className,
}) => {
  const { t } = useTranslation();
  const options = orgs.map((org) => ({
    value: org.id,
    label: formatOrgLabel(org),
  }));

  const sameOrg = sourceOrgId && targetOrgId && sourceOrgId === targetOrgId;

  return (
    <div className={className} data-testid="org-selector">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label={t('compare.source')}
          options={options}
          value={sourceOrgId}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder={t('compare.selectSource')}
        />
        <Select
          label={t('compare.target')}
          options={options}
          value={targetOrgId}
          onChange={(e) => onTargetChange(e.target.value)}
          placeholder={t('compare.selectTarget')}
        />
      </div>
      {sameOrg && (
        <p className="text-xs text-[var(--vscode-notificationsWarningIcon-foreground,#cca700)] mt-2" data-testid="org-same-warning">
          {t('compare.sameOrgWarning')}
        </p>
      )}
    </div>
  );
};
