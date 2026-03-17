import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { useOrgStore, selectSelectedOrg, selectConnectedCount } from '../../stores/useOrgStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';

/** StatusFooter component props. */
export interface StatusFooterProps {
  apiUsagePercent?: number;
  activeJobs?: number;
  className?: string;
}

/** Footer status bar matching VSCode's native status bar. */
export const StatusFooter: React.FC<StatusFooterProps> = ({
  apiUsagePercent,
  activeJobs = 0,
  className,
}) => {
  const { t } = useTranslation();
  const orgCount = useOrgStore(selectConnectedCount);
  const selectedOrg = useOrgStore(selectSelectedOrg);
  const lastOp = useRecentOpsStore((s) => s.ops[0]);

  /** Return a short relative time string. */
  const formatLastOp = (): string | null => {
    if (!lastOp) return null;
    const diff = Date.now() - lastOp.timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return t('home.justNow', 'just now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('home.minutesAgo', '{{count}}m ago', { count: minutes });
    const hours = Math.floor(minutes / 60);
    return t('home.hoursAgo', '{{count}}h ago', { count: hours });
  };

  const lastOpTime = formatLastOp();

  return (
    <footer
      className={cn(
        'flex items-center gap-4 px-3 py-1 text-[11px]',
        'bg-surface-1 text-text-secondary border-t border-subtle',
        className,
      )}
      data-testid="status-footer"
      role="contentinfo"
    >
      <span title={t('status.connectedOrgs', 'Connected orgs')}>
        {orgCount > 0 ? '\uD83D\uDFE2' : '\u26AA'} {orgCount} org{orgCount !== 1 ? 's' : ''}
      </span>
      {selectedOrg && (
        <span title={selectedOrg.alias} data-testid="status-active-org">
          {selectedOrg.alias}
        </span>
      )}
      {apiUsagePercent !== undefined && (
        <span title={t('status.apiUsage', 'API usage')}>
          API: {apiUsagePercent}%
        </span>
      )}
      {activeJobs > 0 && (
        <span title={t('status.activeJobs', 'Active jobs')}>
          {t('monitor.jobs', 'Jobs')}: {activeJobs}
        </span>
      )}
      {lastOpTime && (
        <span data-testid="status-last-op" title={lastOp?.label}>
          {lastOpTime}
        </span>
      )}
      <span className="ml-auto opacity-70">{t('common.versionLabel', { version: '3.0.0' })}</span>
    </footer>
  );
};
