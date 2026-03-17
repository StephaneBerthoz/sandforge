import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupResult } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';

/** RestorePanel component props. */
export interface RestorePanelProps {
  backups?: BackupResult[];
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

  const completedBackups = backups.filter((b) => b.status === 'completed');

  return (
    <div className="flex flex-col gap-3" data-testid="restore-panel">
      <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('dataops.restore')}
      </h2>

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

      {completedBackups.length === 0 && !isRestoring && (
        <EmptyState
          icon="📦"
          title={t('dataops.selectBackup')}
          description={t('dataops.restoreDesc')}
        />
      )}

      {completedBackups.map((backup) => {
        const isSelected = backup.operationId === selectedBackupId;
        return (
          <div key={backup.operationId} data-testid={`restore-backup-${backup.operationId}`}>
            <Card
              hoverable
              onClick={() => onSelectBackup?.(backup.operationId)}
            >
              <CardHeader
                title={backup.configId}
                subtitle={t('common.recordCount', { count: backup.totalRecords })}
                action={
                  <div className="flex items-center gap-2">
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
                <div className="flex gap-4 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                  <span>{t('common.objectCount', { count: backup.objectResults.length })}</span>
                  <span>{backup.startTime}</span>
                </div>
              </CardBody>
            </Card>
          </div>
        );
      })}
    </div>
  );
};
