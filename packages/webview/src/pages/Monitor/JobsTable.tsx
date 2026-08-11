import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import type { JobDisplayInfo } from './MonitorPage';
import { formatNumber } from '../../utils/formatters';

/** Filter for job status */
export type JobFilter = 'all' | 'running' | 'failed' | 'completed';

/** Props for JobsTable component */
export interface JobsTableProps {
  jobs: JobDisplayInfo[];
  className?: string;
}

/** Group of jobs by Apex class */
interface JobGroup {
  className: string;
  jobs: JobDisplayInfo[];
  totalRuns: number;
  successRate: number;
  avgDuration: string;
  failedCount: number;
}

/** Badge variant for job status */
function statusVariant(status: string): BadgeVariant {
  const map: Record<string, BadgeVariant> = {
    Queued: 'info',
    Processing: 'warning',
    Completed: 'success',
    Failed: 'error',
    Aborted: 'error',
  };
  return map[status] ?? 'default';
}

/** Group jobs by their jobType/class */
function groupJobs(jobs: JobDisplayInfo[]): JobGroup[] {
  const groups = new Map<string, JobDisplayInfo[]>();
  for (const job of jobs) {
    const key = job.jobType || 'Other';
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }

  return Array.from(groups.entries()).map(([className, classJobs]) => {
    const completed = classJobs.filter((j) => j.status === 'Completed');
    const failed = classJobs.filter((j) => j.status === 'Failed');
    const successRate =
      classJobs.length > 0 ? Math.round((completed.length / classJobs.length) * 100) : 0;

    return {
      className,
      jobs: classJobs.sort(
        (a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime(),
      ),
      totalRuns: classJobs.length,
      successRate,
      avgDuration: '-',
      failedCount: failed.length,
    };
  });
}

/** Filter jobs by status */
function filterJobs(jobs: JobDisplayInfo[], filter: JobFilter): JobDisplayInfo[] {
  switch (filter) {
    case 'running':
      return jobs.filter((j) => j.status === 'Processing' || j.status === 'Queued');
    case 'failed':
      return jobs.filter((j) => j.status === 'Failed');
    case 'completed':
      return jobs.filter((j) => j.status === 'Completed');
    default:
      return jobs;
  }
}

/**
 * Enhanced jobs table with grouping by Apex class, filtering, and status indicators.
 * Groups jobs into accordion-like expandable sections.
 *
 * Virtualization note (audit cycle 2): intentionally NOT virtualized. The
 * accordion keeps groups collapsed by default, so only expanded groups' rows
 * enter the DOM, and the monitor payload is bounded (recent jobs per poll).
 * VirtualList would require fixed-height scroll containers per group (visual
 * change) and make `job-row-*` assertions depend on jsdom overscan behavior.
 * Memoized instead: props are flat and `jobs` identity is stable between
 * polls, so the 10s `lastUpdatedStr` tick in useMonitorPageData no longer
 * re-renders the accordion.
 */
/** Export jobs to CSV and trigger download via data URI. */
function exportJobsCsv(jobs: JobDisplayInfo[], filename: string): void {
  const headers = [
    'ID',
    'Status',
    'Type',
    'Object',
    'Total Records',
    'Processed',
    'Failed',
    'Created By',
    'Created Date',
  ];
  const rows = jobs.map((j) => [
    j.id,
    j.status,
    j.jobType ?? '',
    j.objectType ?? '',
    String(j.totalRecords ?? ''),
    String(j.processedRecords ?? ''),
    String(j.failedRecords ?? ''),
    j.createdBy ?? '',
    j.createdDate,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const JobsTable: React.FC<JobsTableProps> = React.memo(({ jobs, className }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<JobFilter>('all');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const filteredJobs = useMemo(() => filterJobs(jobs, filter), [jobs, filter]);
  const groups = useMemo(() => groupJobs(filteredJobs), [filteredJobs]);

  const activeCount = jobs.filter((j) => j.status === 'Processing' || j.status === 'Queued').length;

  const handleExportCsv = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);
    exportJobsCsv(filteredJobs, `sandforge-jobs-${date}.csv`);
  }, [filteredJobs]);

  const toggleGroup = (className: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(className)) {
        next.delete(className);
      } else {
        next.add(className);
      }
      return next;
    });
  };

  const FILTERS: Array<{ key: JobFilter; label: string }> = [
    { key: 'all', label: t('monitor.filterAll', 'All') },
    { key: 'running', label: t('monitor.filterRunning', 'Running') },
    { key: 'failed', label: t('monitor.filterFailed', 'Failed') },
    { key: 'completed', label: t('monitor.filterCompleted', 'Completed') },
  ];

  return (
    <Card className={cn('border-0 bg-transparent shadow-none', className)}>
      <CardHeader
        title={t('monitor.recentJobs', 'Recent Apex Jobs')}
        subtitle={`${activeCount} ${t('monitor.activeJobs', 'active')}`}
        action={
          jobs.length > 0 ? (
            <button
              type="button"
              onClick={handleExportCsv}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-xs',
                'text-text-secondary hover:text-text-primary hover:bg-surface-1',
                'transition-colors',
              )}
              data-testid="export-csv-btn"
              title={t('monitor.exportCsv', 'Export CSV')}
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
          ) : undefined
        }
      />
      <CardBody>
        {/* Filter buttons */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sf-space-1)',
            marginBottom: 'var(--sf-space-3)',
          }}
          data-testid="job-filters"
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              data-testid={`filter-${f.key}`}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '2px 8px',
                fontSize: 'var(--sf-font-size-xs)',
                borderRadius: 'var(--sf-radius-sm)',
                border: '1px solid var(--sf-border)',
                backgroundColor: filter === f.key ? 'var(--sf-accent)' : 'transparent',
                color: filter === f.key ? 'var(--sf-bg-card)' : 'var(--sf-text-secondary)',
                cursor: 'pointer',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Grouped jobs */}
        {groups.length === 0 ? (
          <p
            style={{
              fontSize: 'var(--sf-font-size-xs)',
              color: 'var(--sf-text-muted)',
              textAlign: 'center',
              padding: 'var(--sf-space-4) 0',
            }}
          >
            {t('monitor.noJobs', 'No recent jobs')}
          </p>
        ) : (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-2)' }}
            data-testid="job-groups"
          >
            {groups.map((group) => {
              const isExpanded = expandedGroups.has(group.className);
              return (
                <div
                  key={group.className}
                  style={{
                    borderRadius: 'var(--sf-radius-md)',
                    border: '1px solid var(--sf-border)',
                    overflow: 'hidden',
                  }}
                  data-testid={`job-group-${group.className}`}
                >
                  {/* Group header */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.className)}
                    data-testid={`group-toggle-${group.className}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--sf-space-2)',
                      width: '100%',
                      padding: 'var(--sf-space-2) var(--sf-space-3)',
                      backgroundColor: 'var(--sf-bg-input)',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--sf-text-primary)',
                      fontSize: 'var(--sf-font-size-sm)',
                    }}
                  >
                    <span
                      className={`codicon codicon-${isExpanded ? 'chevron-down' : 'chevron-right'}`}
                      aria-hidden="true"
                    />
                    <span
                      className="codicon codicon-symbol-method"
                      aria-hidden="true"
                      style={{ color: 'var(--sf-accent)' }}
                    />
                    <span style={{ fontWeight: 600, flex: 1, textAlign: 'left' }}>
                      {group.className}
                    </span>
                    <span
                      style={{
                        fontSize: 'var(--sf-font-size-xs)',
                        color: 'var(--sf-text-secondary)',
                      }}
                    >
                      {group.totalRuns} {t('monitor.runs', 'runs')}
                    </span>
                    <span
                      style={{
                        fontSize: 'var(--sf-font-size-xs)',
                        color: 'var(--sf-text-secondary)',
                      }}
                    >
                      {group.successRate}% {t('monitor.success', 'success')}
                    </span>
                    {group.failedCount > 0 && (
                      <Badge variant="error">
                        {group.failedCount} {t('monitor.failed', 'failed')}
                      </Badge>
                    )}
                  </button>

                  {/* Expanded job rows */}
                  {isExpanded && (
                    <div data-testid={`group-jobs-${group.className}`}>
                      {group.jobs.map((job) => (
                        <div
                          key={job.id}
                          data-testid={`job-row-${job.id}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--sf-space-3)',
                            padding: 'var(--sf-space-2) var(--sf-space-4)',
                            borderTop: '1px solid var(--sf-border)',
                            backgroundColor:
                              job.status === 'Failed'
                                ? 'color-mix(in srgb, var(--sf-error) 5%, transparent)'
                                : 'transparent',
                            fontSize: 'var(--sf-font-size-xs)',
                          }}
                        >
                          <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                          <span style={{ color: 'var(--sf-text-secondary)', minWidth: '80px' }}>
                            {job.objectType ?? '-'}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              color: 'var(--sf-text-primary)',
                              fontFamily: 'monospace',
                            }}
                          >
                            {job.totalRecords !== undefined
                              ? `${formatNumber(job.processedRecords ?? 0)} / ${formatNumber(job.totalRecords)}`
                              : '-'}
                            {(job.failedRecords ?? 0) > 0 && (
                              <span
                                style={{
                                  color: 'var(--sf-error)',
                                  marginLeft: 'var(--sf-space-1)',
                                }}
                              >
                                ({job.failedRecords} err)
                              </span>
                            )}
                          </span>
                          <span style={{ color: 'var(--sf-text-muted)' }}>{job.createdBy}</span>
                          <span
                            style={{
                              color: 'var(--sf-text-muted)',
                              minWidth: '120px',
                              textAlign: 'right',
                            }}
                          >
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            }).format(new Date(job.createdDate))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
});

JobsTable.displayName = 'JobsTable';
