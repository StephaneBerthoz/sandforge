import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobInsight } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** JobInsightsPanel component props. */
export interface JobInsightsPanelProps {
  insights: JobInsight[];
  onAbortJob?: (jobId: string) => void;
  className?: string;
}

/** Map insight severity to badge variant */
const severityBadge: Record<string, BadgeVariant> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

/** Map insight severity to codicon name */
const severityIcon: Record<string, string> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

/** Map insight severity to border color */
const severityBorderColor: Record<string, string> = {
  info: 'var(--sf-info, #3B82F6)',
  warning: 'var(--sf-warning, #F59E0B)',
  critical: 'var(--sf-error, #EF4444)',
};

/**
 * Collapsible alerts banner displaying job insights.
 * Shows at the top of Monitor Dashboard when there are active insights.
 * Auto-hides when insights array is empty.
 */
export const JobInsightsPanel: React.FC<JobInsightsPanelProps> = ({
  insights,
  onAbortJob,
  className,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  if (insights.length === 0) {
    return null;
  }

  const criticalCount = insights.filter((i) => i.severity === 'critical').length;
  const warningCount = insights.filter((i) => i.severity === 'warning').length;

  return (
    <div
      className={className}
      data-testid="job-insights-panel"
      style={{
        borderRadius: 'var(--sf-radius-lg)',
        border: '1px solid var(--sf-border)',
        backgroundColor: 'var(--sf-bg-card)',
        marginBottom: 'var(--sf-space-4)',
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        data-testid="insights-toggle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sf-space-2)',
          width: '100%',
          padding: 'var(--sf-space-3) var(--sf-space-4)',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sf-text-primary)',
          fontSize: 'var(--sf-font-size-sm)',
          fontWeight: 600,
        }}
      >
        <span
          className={`codicon codicon-${expanded ? 'chevron-down' : 'chevron-right'}`}
          aria-hidden="true"
          style={{ color: 'var(--sf-text-secondary)' }}
        />
        <span className="codicon codicon-warning" aria-hidden="true" style={{ color: 'var(--sf-warning)' }} />
        <span>
          {insights.length} {t('monitor.alertsCount', 'alert(s)')}
        </span>
        {criticalCount > 0 && (
          <Badge variant="error">{criticalCount} {t('monitor.critical', 'critical')}</Badge>
        )}
        {warningCount > 0 && (
          <Badge variant="warning">{warningCount} {t('monitor.warnings', 'warning(s)')}</Badge>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          data-testid="insights-list"
          style={{
            padding: '0 var(--sf-space-4) var(--sf-space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sf-space-2)',
          }}
        >
          {insights.map((insight, idx) => (
            <div
              key={`${insight.type}-${idx}`}
              data-testid={`insight-${insight.type}`}
              style={{
                padding: 'var(--sf-space-3)',
                borderRadius: 'var(--sf-radius-md)',
                backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                borderLeft: `3px solid ${severityBorderColor[insight.severity]}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sf-space-2)', marginBottom: 'var(--sf-space-1)' }}>
                <span
                  className={`codicon codicon-${severityIcon[insight.severity]}`}
                  aria-hidden="true"
                  style={{ color: severityBorderColor[insight.severity] }}
                />
                <Badge variant={severityBadge[insight.severity]}>{insight.severity}</Badge>
                <span style={{ fontSize: 'var(--sf-font-size-sm)', fontWeight: 600, color: 'var(--sf-text-primary)' }}>
                  {insight.title}
                </span>
              </div>
              <p style={{ fontSize: 'var(--sf-font-size-xs)', color: 'var(--sf-text-secondary)', margin: '0 0 var(--sf-space-1)' }}>
                {insight.detail}
              </p>
              <p style={{ fontSize: 'var(--sf-font-size-xs)', color: 'var(--sf-info, #3B82F6)', margin: 0 }}>
                {insight.recommendation}
              </p>
              {insight.type === 'stuck' && onAbortJob && insight.affectedJobs.length > 0 && (
                <div style={{ marginTop: 'var(--sf-space-2)' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAbortJob(insight.affectedJobs[0])}
                    data-testid={`abort-job-${insight.affectedJobs[0]}`}
                  >
                    <span className="codicon codicon-debug-stop" aria-hidden="true" style={{ marginRight: 'var(--sf-space-1)' }} />
                    {t('monitor.abortJob', 'Abort Job')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
