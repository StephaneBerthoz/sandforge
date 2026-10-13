import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupSummary } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatStoredDate, uiLocale } from '../../utils/formatters';
import { BackupPartialNote } from './BackupPanel';

/** RestorePanel component props. */
export interface RestorePanelProps {
  backups?: BackupSummary[];
  selectedBackupId?: string;
  onSelectBackup?: (operationId: string) => void;
  onRestore?: (operationId: string) => void;
  isRestoring?: boolean;
  restoreProgress?: { completed: number; total: number };
}

/** Panel for restoring data from backups. */
export const RestorePanel: React.FC<RestorePanelProps> = ({
  backups = [],
  selectedBackupId,
  onSelectBackup,
  onRestore,
  isRestoring = false,
  restoreProgress,
}) => {
  const { t } = useTranslation();

  // A backup whose read failed part-way keeps the rows it read, and was
  // listed on the Backup tab alone: only the command line could restore it.
  // Offered here too, marked partial, its note saying how far the read got
  // into each object it holds only part of. One kept with no row has nothing
  // to restore.
  const restorableBackups = backups.filter(
    (b) => b.status === 'completed' || (b.status === 'failed' && b.totalRecords > 0),
  );

  return (
    <div className="flex flex-col gap-3" data-testid="restore-panel">
      <h2 className="text-sm font-semibold text-text-primary">{t('dataops.restore')}</h2>

      {isRestoring && restoreProgress && (
        <div data-testid="restore-progress">
          <ProgressBar
            value={restoreProgress.completed}
            max={restoreProgress.total}
            label={t('dataops.restoreInProgress')}
            showPercent
          />
        </div>
      )}

      {restorableBackups.length === 0 && !isRestoring && (
        <EmptyState
          icon="📦"
          title={t('dataops.selectBackup')}
          description={t('dataops.restoreDesc')}
        />
      )}

      {restorableBackups.map((backup) => {
        const isSelected = backup.operationId === selectedBackupId;
        return (
          <div key={backup.operationId} data-testid={`restore-backup-${backup.operationId}`}>
            <Card hoverable onClick={() => onSelectBackup?.(backup.operationId)}>
              <CardHeader
                title={
                  formatStoredDate(backup.timestamp, (date) => date.toLocaleString(uiLocale())) ??
                  t('common.dateUnknown')
                }
                subtitle={t('common.recordCount', { count: backup.totalRecords })}
                action={
                  <div className="flex items-center gap-2">
                    {(backup.partial || backup.status === 'failed') && (
                      <Badge
                        variant="warning"
                        data-testid={`restore-partial-badge-${backup.operationId}`}
                      >
                        {t('dataops.restorePartialBadge')}
                      </Badge>
                    )}
                    {isSelected && <Badge variant="info">{t('common.selected')}</Badge>}
                    {isSelected && onRestore && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRestore(backup.operationId);
                        }}
                        disabled={isRestoring}
                        data-testid={`restore-btn-${backup.operationId}`}
                      >
                        {t('dataops.restore')}
                      </Button>
                    )}
                  </div>
                }
              />
              <CardBody>
                <div className="flex gap-4 text-xs text-text-secondary">
                  <span>{t('common.objectCount', { count: backup.objectResults.length })}</span>
                </div>
                {/* Said before the click: a restore of it leaves the rest of
                    each object as it is now. */}
                {backup.partial && (
                  <BackupPartialNote
                    backup={backup}
                    data-testid={`restore-partial-${backup.operationId}`}
                  />
                )}
              </CardBody>
            </Card>
          </div>
        );
      })}
    </div>
  );
};
