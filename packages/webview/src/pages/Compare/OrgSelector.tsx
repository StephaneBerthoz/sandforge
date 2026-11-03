import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import { OrgRibbon } from '../../components/ui/OrgRibbon';
import { ribbonOrg } from '../../components/ui/ribbonOrg';
import { orgOptionLabel } from '../../utils/orgFormatters';

/** OrgSelector component props. */
export interface OrgSelectorProps {
  orgs: SalesforceOrg[];
  sourceOrgId: string;
  targetOrgId: string;
  onSourceChange: (orgId: string) => void;
  onTargetChange: (orgId: string) => void;
  className?: string;
}

/**
 * The source and the target, each picked where the ribbon of the two orgs
 * names it: the target framed, a production org said in words and with its
 * shield, the instance under each. The pickers sat over a ribbon that named
 * both orgs again once they were picked.
 */
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
    label: orgOptionLabel(org, t),
  }));

  const sameOrg = sourceOrgId && targetOrgId && sourceOrgId === targetOrgId;
  /**
   * The id a picker shows: none for an org this machine no longer holds,
   * which the ribbon says under it. Given the old id, which no option holds,
   * the picker showed the first org left, and picking that one changed
   * nothing.
   */
  const shown = (id: string): string => (orgs.some((org) => org.id === id) ? id : '');

  return (
    <div className={className} data-testid="org-selector">
      <OrgRibbon
        kind="compare"
        source={ribbonOrg(orgs, sourceOrgId)}
        target={ribbonOrg(orgs, targetOrgId)}
        pickers={{
          source: (
            <Select
              label={t('compareParts.source')}
              options={options}
              value={shown(sourceOrgId)}
              onChange={(e) => onSourceChange(e.target.value)}
              placeholder={t('compareParts.selectSource')}
            />
          ),
          target: (
            <Select
              label={t('compareParts.target')}
              options={options}
              value={shown(targetOrgId)}
              onChange={(e) => onTargetChange(e.target.value)}
              placeholder={t('compareParts.selectTarget')}
            />
          ),
        }}
      />
      {sameOrg && (
        <p className="text-xs text-status-warning mt-2" data-testid="org-same-warning">
          {t('compareParts.sameOrgWarning')}
        </p>
      )}
    </div>
  );
};
