import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { useOrgStore, selectSelectedOrg, selectConnectedCount } from '../../stores/useOrgStore';

/** Props for the OrgSwitcher component. */
export interface OrgSwitcherProps {
  /** Additional CSS classes. */
  className?: string;
}

/** Compact dropdown trigger showing the currently selected org. */
export const OrgSwitcher: React.FC<OrgSwitcherProps> = ({ className }) => {
  const { t } = useTranslation();
  const selectedOrg = useOrgStore(selectSelectedOrg);
  const connectedCount = useOrgStore(selectConnectedCount);

  const label = selectedOrg?.alias ?? t('org.noOrgs', 'No org');
  const isConnected = selectedOrg?.status === 'connected';

  return (
    <button
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 text-xs rounded',
        'bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3',
        'border border-subtle transition-colors',
        className,
      )}
      data-testid="org-switcher"
      title={
        connectedCount > 0
          ? `${connectedCount} ${t('status.connectedOrgs', 'Connected orgs')}`
          : t('org.noOrgs', 'No org')
      }
    >
      <span
        className={cn(
          'w-2 h-2 rounded-full shrink-0',
          isConnected ? 'bg-green-500' : 'bg-text-muted',
        )}
      />
      <span className="truncate max-w-[120px]">{label}</span>
      <ChevronDown className="w-3 h-3 shrink-0" />
    </button>
  );
};
