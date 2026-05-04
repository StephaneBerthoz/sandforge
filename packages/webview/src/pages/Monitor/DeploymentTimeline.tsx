import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import { Timeline } from '../../components/ui/Timeline';
import type { TimelineItem, TimelineStatus } from '../../components/ui/Timeline';
import type { DeploymentEntry } from '@sandforge/shared';

/** Response shape from monitor:deployments. */
interface DeploymentData {
  success: boolean;
  deployments: DeploymentEntry[];
  error?: string;
}

/** Maps deployment status to timeline status. */
function statusToTimelineStatus(status: DeploymentEntry['status']): TimelineStatus {
  switch (status) {
    case 'Succeeded':
      return 'success';
    case 'Failed':
      return 'error';
    case 'Canceled':
      return 'warning';
    case 'InProgress':
      return 'info';
    case 'Pending':
      return 'info';
    default:
      return 'info';
  }
}

/** Formats an ISO date to a readable local string. */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Panel displaying recent deployments in a timeline format.
 *
 * Fetches data via useBridgeQuery('monitor:deployments') and renders
 * deployment entries using the Timeline component with status badges.
 */
export const DeploymentTimeline: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<DeploymentData>(
    'monitor:deployments',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:deployments:response', skip: !selectedOrgId },
  );

  const deployments = useMemo(() => data?.deployments ?? [], [data?.deployments]);

  const timelineItems: TimelineItem[] = useMemo(
    () =>
      deployments.map((d) => ({
        title: `${d.createdBy} - ${d.componentCount} ${t('monitor.deployments.components', 'components')}`,
        description:
          d.errorCount > 0
            ? `${d.status} (${d.errorCount} ${t('monitor.deployments.errors', 'errors')})`
            : d.status,
        timestamp: formatDate(d.startDate),
        status: statusToTimelineStatus(d.status),
      })),
    [deployments, t],
  );

  if (loading) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="deployment-timeline-loading"
      >
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 p-4"
      data-testid="deployment-timeline"
    >
      <div className="flex items-center gap-2 mb-3">
        <Rocket className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">
          {t('monitor.deployments.title', 'Recent Deployments')}
        </h3>
        {deployments.length > 0 && <Badge variant="default">{deployments.length}</Badge>}
      </div>

      {deployments.length === 0 ? (
        <p
          className="text-xs text-text-muted text-center py-6"
          data-testid="deployment-timeline-empty"
        >
          {t('monitor.deployments.empty', 'No recent deployments')}
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto" data-testid="deployment-timeline-list">
          <Timeline items={timelineItems} />
        </div>
      )}
    </div>
  );
};
