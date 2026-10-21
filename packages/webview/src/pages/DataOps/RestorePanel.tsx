import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupSummary } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatStoredDate, uiLocale } from '../../utils/formatters';
import { BackupPartialNote } from './BackupPanel';

/** What the last restore did, as its answer counts it. */
export interface RestoreCounts {
  /** Rows written back. */
  written: number;
  /** Rows the org already held as the backup does, which it left alone. */
  unchanged: number;
  /** Rows the org refused. */
  failed: number;
}

/** RestorePanel component props. */
export interface RestorePanelProps {
  backups?: BackupSummary[];
  selectedBackupId?: string;
  onSelectBackup?: (operationId: string) => void;
  onRestore?: (operationId: string) => void;
  isRestoring?: boolean;
  restoreProgress?: { completed: number; total: number };
  /**
   * Write every row of the backup back, rather than read the org first and
   * write only the rows that changed since.
   */
  rewriteAll?: boolean;
  onRewriteAllChange?: (rewriteAll: boolean) => void;
  /** What the last restore wrote, left alone and had refused. */
  lastRestore?: RestoreCounts;
  /** Delete one backup from this machine, once asked to confirm. */
  onDelete?: (operationId: string) => void;
  /** Delete every backup of the org from this machine, once asked to confirm. */
  onDeleteAll?: () => void;
  /** A deletion is in flight. */
  isDeleting?: boolean;
}

/** Panel for restoring data from backups. */
export const RestorePanel: React.FC<RestorePanelProps> = ({
  backups = [],
  selectedBackupId,
  onSelectBackup,
  onRestore,
  isRestoring = false,
  restoreProgress,
  rewriteAll = false,
  onRewriteAllChange,
  lastRestore,
  onDelete,
  onDeleteAll,
  isDeleting = false,
}) => {
  const { t } = useTranslation();
  /**
   * What a Delete asks to confirm: one backup, by its id, or every one of the
   * org. A backup deleted cannot be restored, so the first click only asks.
   */
  const [confirming, setConfirming] = useState<{ one: string } | 'all' | null>(null);
  const questionId = useId();

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

      {/* A restore writes only what changed since the backup: a backup of
          12 000 contacts, three of them changed, was written back whole. */}
      {restorableBackups.length > 0 && onRewriteAllChange && (
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={rewriteAll}
            disabled={isRestoring}
            onChange={(e) => onRewriteAllChange(e.target.checked)}
            data-testid="restore-rewrite-all"
          />
          <span>{t('dataops.restoreRewriteAll')}</span>
        </label>
      )}

      {lastRestore && !isRestoring && (
        <p className="text-xs text-text-secondary" role="status" data-testid="restore-result">
          {t('dataops.restoreResult', {
            written: lastRestore.written,
            unchanged: lastRestore.unchanged,
            failed: lastRestore.failed,
          })}
        </p>
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
            {/* Beside the card, not in it: the card is a button that selects
                the backup, and a button inside it is one screen readers may
                never announce (axe, nested-interactive). */}
            {isSelected && (onRestore || onDelete) && (
              <div className="mt-2 flex flex-col items-end gap-2">
                <div className="flex justify-end gap-2">
                  {onDelete && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirming({ one: backup.operationId })}
                      disabled={isRestoring || isDeleting}
                      data-testid={`delete-backup-btn-${backup.operationId}`}
                    >
                      {t('dataops.backupDelete')}
                    </Button>
                  )}
                  {onRestore && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => onRestore(backup.operationId)}
                      disabled={isRestoring || isDeleting}
                      data-testid={`restore-btn-${backup.operationId}`}
                    >
                      {t('dataops.restore')}
                    </Button>
                  )}
                </div>
                {onDelete &&
                  confirming !== null &&
                  confirming !== 'all' &&
                  confirming.one === backup.operationId && (
                    <DeleteQuestion
                      id={questionId}
                      question={t('dataops.backupDeleteConfirm')}
                      onConfirm={() => {
                        setConfirming(null);
                        onDelete(backup.operationId);
                      }}
                      onCancel={() => setConfirming(null)}
                    />
                  )}
              </div>
            )}
          </div>
        );
      })}

      {/* The org's backups, on this machine, all at once: what a person's
          erasure or the org's masking leaves in clear in each of them. */}
      {onDeleteAll && backups.length > 0 && !isRestoring && (
        <div className="flex flex-col items-start gap-2 border-t border-subtle pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirming('all')}
            disabled={isDeleting}
            data-testid="delete-all-backups-btn"
          >
            {t('dataops.backupDeleteAll')}
          </Button>
          {confirming === 'all' && (
            <DeleteQuestion
              id={questionId}
              question={t('dataops.backupDeleteAllConfirm', { count: backups.length })}
              onConfirm={() => {
                setConfirming(null);
                onDeleteAll();
              }}
              onCancel={() => setConfirming(null)}
            />
          )}
        </div>
      )}
    </div>
  );
};

/** Props for {@link DeleteQuestion}. */
interface DeleteQuestionProps {
  id: string;
  question: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The question a Delete asks before anything is deleted, with its two answers. */
const DeleteQuestion: React.FC<DeleteQuestionProps> = ({ id, question, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-testid="delete-backup-question">
      <p id={id} className="text-xs text-text-primary">
        {question}
      </p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          size="sm"
          aria-describedby={id}
          onClick={onConfirm}
          data-testid="delete-backup-confirm"
        >
          {t('common.confirm')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid="delete-backup-cancel">
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
