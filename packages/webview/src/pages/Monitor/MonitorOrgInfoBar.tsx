import React from 'react';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import type { OrgInfo } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { formatNumber } from '../../utils/formatters';

/** Props for the MonitorOrgInfoBar section. */
export interface MonitorOrgInfoBarProps {
  /** Org metadata (edition, instance, users, etc.). */
  orgInfo: OrgInfo;
}

/**
 * Compact org info panel shown right after the KPI row.
 * Memoized — re-renders only when orgInfo changes.
 */
export const MonitorOrgInfoBar: React.FC<MonitorOrgInfoBarProps> = React.memo(({ orgInfo }) => {
  const { t } = useTranslation();

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 px-4 py-3"
      data-testid="org-info-panel"
    >
      <div className="flex items-center gap-2 mb-2.5">
        <Server className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{orgInfo.name}</h3>
        <span className="font-mono text-[10px] text-text-muted">{orgInfo.orgId}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-x-5 gap-y-2">
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.release', 'Release')}</div>
          <div className="text-xs font-medium text-text-primary">
            {orgInfo.releaseName ?? `API v${orgInfo.apiVersion}`}
          </div>
        </div>
        {orgInfo.nextReleaseName && (
          <div>
            <div className="text-[10px] text-text-muted">
              {t('monitor.nextRelease', 'Next Release')}
            </div>
            <div className="text-xs font-medium text-text-primary">{orgInfo.nextReleaseName}</div>
          </div>
        )}
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.instance', 'Instance')}</div>
          <div className="text-xs font-medium text-text-primary">
            {orgInfo.instanceName}
            {orgInfo.isHyperforce && (
              <Badge variant="info" className="ml-1 text-[8px] px-1 py-0">
                HF
              </Badge>
            )}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.edition', 'Edition')}</div>
          <div className="text-xs font-medium text-text-primary">{orgInfo.edition}</div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.users', 'Users')}</div>
          <div className="text-xs font-medium text-text-primary">
            {formatNumber(orgInfo.userCount)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.customObjects', 'Objects')}</div>
          <div className="text-xs font-medium text-text-primary">
            {formatNumber(orgInfo.customObjectCount)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted">{t('monitor.code', 'Code')}</div>
          <div className="text-xs font-medium text-text-primary">
            {formatNumber(orgInfo.apexClassCount)} Apex &middot; {formatNumber(orgInfo.flowCount)}{' '}
            Flows
          </div>
        </div>
        {orgInfo.datacenter && (
          <div>
            <div className="text-[10px] text-text-muted">
              {t('monitor.datacenter', 'Datacenter')}
            </div>
            <div className="text-xs font-medium text-text-primary">{orgInfo.datacenter}</div>
          </div>
        )}
      </div>

      {(orgInfo.namespacePrefix || orgInfo.createdDate || orgInfo.podName) && (
        <div className="flex items-center gap-4 mt-2 pt-2 border-t border-subtle text-[10px] text-text-muted">
          {orgInfo.namespacePrefix && (
            <span>
              Namespace:{' '}
              <span className="font-mono text-text-secondary">{orgInfo.namespacePrefix}</span>
            </span>
          )}
          {orgInfo.createdDate && (
            <span>
              {t('monitor.orgCreated', 'Created')}:{' '}
              {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                new Date(orgInfo.createdDate),
              )}
            </span>
          )}
          {orgInfo.podName && (
            <span>
              Pod: <span className="font-mono text-text-secondary">{orgInfo.podName}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
});

MonitorOrgInfoBar.displayName = 'MonitorOrgInfoBar';
