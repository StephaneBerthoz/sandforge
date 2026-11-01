import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BackupObjectHeld, BackupSummary, BackupStatus } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { RunStopControl } from './RunStopControl';
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
  /** Stop the run in progress: shown while it runs (`RunStopControl`). */
  onStop?: () => void;
  /** Whether that stop was sent and not refused. */
  stopRequested?: boolean;
  /**
   * Open Checkpoints on a take of the org: offered where a checkpoint can be
   * taken, a connected sandbox, scratch org or Developer Edition.
   */
  onTakeCheckpoint?: () => void;
}

const STATUS_VARIANT: Record<BackupStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  expired: 'warning',
};

/**
 * The word for each status, in the interface language. The badge printed the
 * stored code, "completed" in lower-case English whatever the language.
 */
const STATUS_KEY: Record<BackupStatus, string> = {
  pending: 'dataops.backupStatus.pending',
  running: 'dataops.backupStatus.running',
  completed: 'dataops.backupStatus.completed',
  failed: 'dataops.backupStatus.failed',
  expired: 'dataops.backupStatus.expired',
};

/**
 * Whether a backup holds only part of what it read, as the Restore tab marks
 * it: one stopped at the cap, or whose read failed after it kept some rows.
 * It wore a green "completed" on the Backup tab above its own note saying a
 * cap stopped it, while the Restore tab called the same backup Partial.
 */
export function isPartialBackup(backup: BackupSummary): boolean {
  return backup.partial === true || (backup.status === 'failed' && backup.totalRecords > 0);
}

/**
 * How many objects a backup holds, and which. The card said "2 objects" and
 * never named them, so nothing told which backup held the object to restore.
 */
export const BackupObjects: React.FC<{ backup: BackupSummary }> = ({ backup }) => {
  const { t } = useTranslation();
  return (
    <div className="flex gap-4 text-xs text-text-secondary">
      <span data-testid={`backup-objects-${backup.operationId}`}>
        {backup.objectResults.length === 0
          ? t('common.objectCount', { count: 0 })
          : t('dataops.backupObjectNames', {
              count: backup.objectResults.length,
              objects: backup.objectResults.map((o) => o.objectApiName).join(', '),
            })}
      </span>
    </div>
  );
};

/**
 * One object a backup holds only part of: the rows read, the rows the org
 * held, and why it stopped — or that the backup failed before it read the
 * object at all.
 */
function shortObjectLine(o: BackupObjectHeld, t: TFunction): string {
  if (o.stoppedAt === 'not_reached') {
    return t('dataops.backupNotReached', { object: o.objectApiName });
  }
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
 * or the read failed, and names each object a failure kept it from reading;
 * an older one, which stopped at the tier's bound, says what it recorded.
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
  onStop,
  stopRequested = false,
  onTakeCheckpoint,
}) => {
  const { t } = useTranslation();
  const checkpointWhyId = useId();

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

      {isCreating && onStop && (
        <RunStopControl onStop={onStop} requested={stopRequested} testId="backup-stop" />
      )}

      {/* Said before the click: the objects it reads follow the templates. */}
      {objects.length > 0 && (
        <p className="text-xs text-text-secondary" data-testid="backup-objects">
          {template
            ? t('dataops.backupObjectsTemplate', { objects: objects.join(', '), name: template })
            : t('dataops.backupObjectsAll', { objects: objects.join(', ') })}
        </p>
      )}

      {/* A backup reads only the objects the templates mask: it is no way
          back from a Seed, a Sync or a Forge run on the others, and the tab
          told a newcomer to take one before any risky operation. A
          checkpoint is that way back. */}
      {onTakeCheckpoint && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs"
          data-testid="backup-checkpoint"
        >
          <Icon name="history" className="text-sm text-hue-indigo" />
          <p id={checkpointWhyId} className="min-w-0 flex-1 text-text-primary">
            {t('dataops.checkpointBeforeRisk')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onTakeCheckpoint}
            aria-describedby={checkpointWhyId}
            data-testid="backup-checkpoint-take"
          >
            {t('dataops.takeCheckpoint')}
          </Button>
        </div>
      )}

      {backups.length === 0 && (
        <EmptyState
          icon={<Icon name="save" />}
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
                  {isPartialBackup(backup) ? (
                    <Badge variant="warning" data-testid={`backup-status-${backup.operationId}`}>
                      {t('dataops.restorePartialBadge')}
                    </Badge>
                  ) : (
                    <Badge
                      variant={STATUS_VARIANT[backup.status]}
                      data-testid={`backup-status-${backup.operationId}`}
                    >
                      {t(STATUS_KEY[backup.status])}
                    </Badge>
                  )}
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
              <BackupObjects backup={backup} />
              {backup.partial && (
                <BackupPartialNote
                  backup={backup}
                  data-testid={`backup-partial-${backup.operationId}`}
                />
              )}
              {/* Kept, a mask was written back over the real value by a restore. */}
              {backup.objectResults
                .filter((o) => (o.notKept ?? []).length > 0)
                .map((o) => (
                  <p
                    key={o.objectApiName}
                    className="mt-2 text-xs text-status-warning"
                    data-testid={`backup-not-kept-${backup.operationId}-${o.objectApiName}`}
                  >
                    {t('dataops.backupNotKeptEncrypted', {
                      object: o.objectApiName,
                      fields: (o.notKept ?? []).join(', '),
                    })}
                  </p>
                ))}
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
