import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Job info for display (matches extension JobInfo interface). */
export interface JobDisplayInfo {
  id: string;
  jobType: string;
  status: string;
  objectType?: string;
  createdBy: string;
  createdDate: string;
  totalRecords?: number;
  processedRecords?: number;
  failedRecords?: number;
}

/** JobsPanel component props. */
export interface JobsPanelProps {
  jobs: JobDisplayInfo[];
  className?: string;
}

const statusVariant: Record<string, BadgeVariant> = {
  Queued: 'info',
  Processing: 'warning',
  Completed: 'success',
  Failed: 'error',
  Aborted: 'error',
};

/** Panel displaying Salesforce async jobs in a table. */
export const JobsPanel: React.FC<JobsPanelProps> = ({ jobs, className }) => {
  const { t } = useTranslation();

  return (
    <Card className={className}>
      <CardHeader
        title={t('monitor.jobs')}
        subtitle={`${jobs.filter((j) => j.status === 'Processing' || j.status === 'Queued').length} active`}
      />
      <CardBody className="overflow-x-auto">
        {jobs.length === 0 ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('common.noData')}
          </p>
        ) : (
          <table className="w-full text-xs" data-testid="jobs-table">
            <thead>
              <tr className="text-left text-[var(--vscode-descriptionForeground,#868686)] border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                <th className="pb-2 pr-3 font-medium">{t('common.type')}</th>
                <th className="pb-2 pr-3 font-medium">{t('common.object')}</th>
                <th className="pb-2 pr-3 font-medium">{t('common.status')}</th>
                <th className="pb-2 pr-3 font-medium">{t('common.progress')}</th>
                <th className="pb-2 font-medium">{t('common.createdBy')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-[var(--vscode-panel-border,#3c3c3c)] last:border-0"
                  data-testid={`job-row-${job.id}`}
                >
                  <td className="py-1.5 pr-3 text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {job.jobType}
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--vscode-descriptionForeground,#868686)]">
                    {job.objectType ?? '-'}
                  </td>
                  <td className="py-1.5 pr-3">
                    <Badge variant={statusVariant[job.status] ?? 'default'}>{job.status}</Badge>
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--vscode-descriptionForeground,#868686)] font-mono">
                    {job.totalRecords !== undefined
                      ? `${(job.processedRecords ?? 0).toLocaleString()} / ${job.totalRecords.toLocaleString()}`
                      : '-'}
                    {(job.failedRecords ?? 0) > 0 && (
                      <span className={cn('ml-1 text-[var(--vscode-errorForeground,#f48771)]')}>
                        ({job.failedRecords} err)
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-[var(--vscode-descriptionForeground,#868686)] truncate max-w-[100px]">
                    {job.createdBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
};
