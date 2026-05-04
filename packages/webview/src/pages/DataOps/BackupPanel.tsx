import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupResult, BackupStatus } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatFileSize } from '../../utils/formatters';

/** BackupPanel component props. */
export interface BackupPanelProps {
  backups?: BackupResult[];
  isCreating?: boolean;
  onCreate?: () => void;
  onDelete?: (operationId: string) => void;
}

const STATUS_VARIANT: Record<BackupStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  expired: 'warning',
};

/** Panel for managing data backups. */
export const BackupPanel: React.FC<BackupPanelProps> = ({
  backups = [],
  isCreating = false,
  onCreate,
  onDelete,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3" data-testid="backup-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('dataops.backup')}
        </h2>
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
              title={backup.configId}
              subtitle={`${t('common.recordCount', { count: backup.totalRecords })} · ${formatFileSize(backup.totalSize)}`}
              action={
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[backup.status]}>{backup.status}</Badge>
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
              <div className="flex gap-4 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                <span>
                  {t('dataops.backupSize')}: {formatFileSize(backup.totalSize)}
                </span>
                <span>{backup.duration}ms</span>
                <span>{t('common.objectCount', { count: backup.objectResults.length })}</span>
              </div>
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
