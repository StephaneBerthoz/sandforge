import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { DataTable } from '../../components/ui/DataTable';
import type { DataTableColumn } from '../../components/ui/DataTable';

/** Job info for display (matches extension JobInfo interface). */
export type JobDisplayInfo = {
  id: string;
  jobType: string;
  status: string;
  objectType?: string;
  createdBy: string;
  createdDate: string;
  totalRecords?: number;
  processedRecords?: number;
  failedRecords?: number;
};

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

  const columns: DataTableColumn<JobDisplayInfo>[] = [
    { key: 'jobType', header: t('common.type') },
    {
      key: 'objectType',
      header: t('common.object'),
      render: (job) => <span className="text-text-secondary">{job.objectType ?? '-'}</span>,
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (job) => <Badge variant={statusVariant[job.status] ?? 'default'}>{job.status}</Badge>,
    },
    {
      key: 'progress',
      header: t('common.progress'),
      render: (job) => (
        <span className="text-text-secondary font-mono">
          {job.totalRecords !== undefined
            ? `${(job.processedRecords ?? 0).toLocaleString()} / ${job.totalRecords.toLocaleString()}`
            : '-'}
          {(job.failedRecords ?? 0) > 0 && (
            <span className="ml-1 text-[var(--sf-error)]">({job.failedRecords} err)</span>
          )}
        </span>
      ),
    },
    {
      key: 'createdBy',
      header: t('common.createdBy'),
      render: (job) => (
        <span className="block max-w-[100px] truncate text-text-secondary">{job.createdBy}</span>
      ),
    },
  ];

  return (
    <Card className={className}>
      <CardHeader
        title={t('monitor.jobs')}
        subtitle={`${jobs.filter((j) => j.status === 'Processing' || j.status === 'Queued').length} active`}
      />
      <CardBody className="overflow-x-auto">
        {jobs.length === 0 ? (
          <p className="text-xs text-text-secondary text-center py-4">{t('common.noData')}</p>
        ) : (
          <DataTable columns={columns} data={jobs} keyExtractor={(job) => job.id} />
        )}
      </CardBody>
    </Card>
  );
};
