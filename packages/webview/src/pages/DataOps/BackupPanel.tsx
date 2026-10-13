import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BackupObjectHeld, BackupSummary, BackupStatus } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';

/** BackupPanel component props. */
export interface BackupPanelProps {
  backups?: BackupSummary[];
  isCreating?: boolean;
  /** The objects Create Backup reads. */
  objects?: string[];
  /** The template whose objects those are, when one is picked; every template's otherwise. */
  template?: string;
  onCreate?: () => void;
  onDelete?: (operationId: string) => void;
  /** Download this backup, records included, so it can leave the machine. */
  onExport?: (operationId: string) => void;
}

const STATUS_VARIANT: Record<BackupStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  expired: 'warning',
};

/** One object a backup holds only part of: the rows read, the rows the org held, and why it stopped. */
function shortObjectLine(o: BackupObjectHeld, t: TFunction): string {
  const values = {
    object: o.objectApiName,
    read: formatNumber(o.recordCount),
    held: o.orgCount === undefined ? '' : formatNumber(o.orgCount),
  };
  if (o.stoppedAt === 'cap') {
    return o.orgCount === undefined
      ? t('dataops.backupStoppedAtCapUncounted', values)
      : t('dataops.backupStoppedAtCap', values);
  }
  return o.orgCount === undefined
    ? t('dataops.backupReadFailedUncounted', values)
    : t('dataops.backupReadFailed', values);
}

/**
 * What a partial backup holds of each object it holds only part of. A restore
 * brings back those rows only, and the rest of each object stays as it is —
 * masked, after a masking run. A backup taken since the cap says, per object,
 * the rows read against the rows the org held and whether the cap stopped it
 * or the read failed; an older one, which stopped at the tier's bound, says
 * what it recorded.
 */
export const BackupPartialNote: React.FC<{ backup: BackupSummary; 'data-testid': string }> = ({
  backup,
  'data-testid': testId,
}) => {
  const { t } = useTranslation();
  const short = backup.objectResults.filter((o) => o.truncated);
  const explained = short.filter((o) => o.stoppedAt !== undefined);
  const older = short.filter((o) => o.stoppedAt === undefined);
  return (
    <div
      className="mt-2 flex flex-col gap-1 text-xs text-status-warning"
      role="note"
      data-testid={testId}
    >
      {older.length > 0 && (
        <p>
          {t('dataops.backupPartial', {
            objects: older.map((o) => `${o.objectApiName} (${o.recordCount})`).join(', '),
          })}
        </p>
      )}
      {explained.length > 0 && (
        <>
          <p>{t('dataops.backupPartialLead')}</p>
          <ul className="list-disc pl-4">
            {explained.map((o) => (
              <li key={o.objectApiName}>{shortObjectLine(o, t)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

/** Panel for managing data backups. */
export const BackupPanel: React.FC<BackupPanelProps> = ({
  backups = [],
  isCreating = false,
  objects = [],
  template,
  onCreate,
  onDelete,
  onExport,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3" data-testid="backup-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('dataops.backup')}</h2>
        <Button
          variant="primary"
          size="sm"
          onClick={onCreate}
          loading={isCreating}
          data-testid="create-backup-btn"
        >
          {t('dataops.createBackup')}
        </Button>
      </div>

      {/* Said before the click: the objects it reads follow the templates. */}
      {objects.length > 0 && (
        <p className="text-xs text-text-secondary" data-testid="backup-objects">
          {template
            ? t('dataops.backupObjectsTemplate', { objects: objects.join(', '), name: template })
            : t('dataops.backupObjectsAll', { objects: objects.join(', ') })}
        </p>
      )}

      {backups.length === 0 && (
        <EmptyState
          icon="save"
          title={t('dataops.noBackups')}
          description={t('dataops.backupDesc')}
        />
      )}

      {backups.map((backup) => (
        <div key={backup.operationId} data-testid={`backup-${backup.operationId}`}>
          <Card>
            <CardHeader
              // A backup records its timestamp, not a config id or a byte size,
              // so the header names the moment it was taken. Rendering fields
              // the backup never captured would only ever print blanks. A stored
              // timestamp that is not a date read "Invalid Date".
              title={
                formatStoredDate(backup.timestamp, (date) => date.toLocaleString(uiLocale())) ??
                t('common.dateUnknown')
              }
              subtitle={t('common.recordCount', { count: backup.totalRecords })}
              action={
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[backup.status]}>{backup.status}</Badge>
                  {onExport && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onExport(backup.operationId)}
                      data-testid={`export-backup-${backup.operationId}`}
                    >
                      {t('dataops.exportBackup')}
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(backup.operationId)}
                      data-testid={`delete-backup-${backup.operationId}`}
                    >
                      {t('common.delete')}
                    </Button>
                  )}
                </div>
              }
            />
            <CardBody>
              <div className="flex gap-4 text-xs text-text-secondary">
                <span>{t('common.objectCount', { count: backup.objectResults.length })}</span>
              </div>
              {backup.partial && (
                <BackupPartialNote
                  backup={backup}
                  data-testid={`backup-partial-${backup.operationId}`}
                />
              )}
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
