import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Response shape from monitor:sessions. */
interface SessionsData {
  success: boolean;
  sessions: Array<{
    userId: string;
    username: string;
    sessionType: string;
    loginTime: string;
    sourceIp: string;
  }>;
  activeUserCount: number;
}

/** Shared date formatter for session login timestamps. */
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Returns badge variant based on session type. */
function sessionTypeVariant(type: string): BadgeVariant {
  switch (type) {
    case 'UI':
      return 'info';
    case 'API':
      return 'warning';
    default:
      return 'default';
  }
}

/**
 * Panel displaying active user sessions fetched via the monitor:sessions bridge query.
 *
 * Renders three states: loading skeleton, empty message, or a table of sessions
 * with session type badges and connection metadata.
 */
export const SessionsPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<SessionsData>(
    'monitor:sessions',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:sessions:response', skip: !selectedOrgId },
  );

  const sessions = useMemo(() => data?.sessions ?? [], [data?.sessions]);
  const activeUserCount = data?.activeUserCount ?? 0;

  if (loading) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="sessions-panel-loading"
      >
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="sessions-panel-empty"
      >
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.sessions.title', 'Active Sessions')}
          </h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.sessions.empty', 'No active sessions')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="sessions-panel">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('monitor.sessions.title', 'Active Sessions')}
        </h3>
        <Badge variant="info">
          {t('monitor.sessions.activeUsers', '{{count}} active user(s)').replace(
            '{{count}}',
            String(activeUserCount),
          )}
        </Badge>
      </div>

      {/* Table header */}
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-text-muted font-medium uppercase tracking-wider border-b border-subtle mb-1">
        <span className="flex-1">{t('monitor.sessions.username', 'Username')}</span>
        <span className="w-20 shrink-0">{t('monitor.sessions.sessionType', 'Session Type')}</span>
        <span className="w-28 shrink-0">{t('monitor.sessions.loginTime', 'Login Time')}</span>
        <span className="w-28 text-right">{t('monitor.sessions.sourceIp', 'Source IP')}</span>
      </div>

      {/* Table rows */}
      <div className="flex flex-col gap-0.5">
        {sessions.map((session) => (
          <div
            key={session.userId}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors"
            data-testid={`session-row-${session.userId}`}
          >
            <span className="text-xs font-medium text-text-primary flex-1 truncate">
              {session.username}
            </span>
            <span className="w-20 shrink-0">
              <Badge variant={sessionTypeVariant(session.sessionType)}>{session.sessionType}</Badge>
            </span>
            <span className="text-[11px] tabular-nums text-text-muted w-28 shrink-0">
              {dateFormatter.format(new Date(session.loginTime))}
            </span>
            <span className="text-[11px] font-mono text-text-muted w-28 text-right">
              {session.sourceIp}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
