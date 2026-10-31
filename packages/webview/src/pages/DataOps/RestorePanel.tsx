import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RunStopControl } from './RunStopControl';
import type { BackupSummary } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';
import { BackupPartialNote } from './BackupPanel';

/** What the last restore did, as its answer counts it. */
export interface RestoreCounts {
  /** Rows written back. */
  written: number;
  /** Rows the org already held as the backup does, which it left alone. */
  unchanged: number;
  /** Rows the org refused. */
  failed: number;
  /**
   * Of a Sync run's backup, the records changed or deleted since the run,
   * which the restore left as they are, per object; `runNotKept` when the run
   * is no longer kept and every record read as changed since.
   */
  keptChanged?: {
    objects: ReadonlyArray<{ objectApiName: string; count: number }>;
    runNotKept?: boolean;
  };
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
  /**
   * Of a Sync run's backup, restore the records changed or deleted since the
   * run too, rather than leave them as they are, as removing the run does.
   */
  includeChanged?: boolean;
  onIncludeChangedChange?: (includeChanged: boolean) => void;
  /** What the last restore wrote, left alone and had refused. */
  lastRestore?: RestoreCounts;
  /** Delete one backup from this machine, once asked to confirm. */
  onDelete?: (operationId: string) => void;
  /** Delete every backup of the org from this machine, once asked to confirm. */
  onDeleteAll?: () => void;
  /** A deletion is in flight. */
  isDeleting?: boolean;
  /** Stop the run in progress: shown while it runs (`RunStopControl`). */
  onStop?: () => void;
  /** Whether that stop was sent and not refused. */
  stopRequested?: boolean;
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
  includeChanged = false,
  onIncludeChangedChange,
  lastRestore,
  onDelete,
  onDeleteAll,
  isDeleting = false,
  onStop,
  stopRequested = false,
}) => {
  const { t } = useTranslation();
  /**
   * What a Delete asks to confirm: one backup, by its id, or every one of the
   * org. A backup deleted cannot be restored, so the first click only asks.
   */
  const [confirming, setConfirming] = useState<{ one: string } | 'all' | null>(null);
  const questionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Each backup's entry, where its card is found to take the focus. */
  const entries = useRef(new Map<string, HTMLDivElement>());
  /** Each backup's Delete, which its question hands the focus back to. */
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const deleteAllButton = useRef<HTMLButtonElement>(null);
  /**
   * A deletion confirmed: the backups it takes, where the first of them stood
   * among those listed, and the Delete that asked, which holds the focus until
   * they are gone.
   */
  const afterDelete = useRef<{
    gone: readonly string[];
    place: number;
    opener: HTMLElement | null;
  } | null>(null);

  // A backup whose read failed part-way keeps the rows it read, and was
  // listed on the Backup tab alone: only the command line could restore it.
  // Offered here too, marked partial, its note saying how far the read got
  // into each object it holds only part of. One kept with no row has nothing
  // to restore.
  const restorableBackups = backups.filter(
    (b) => b.status === 'completed' || (b.status === 'failed' && b.totalRecords > 0),
  );

  // Its question gone with the answer, the focus fell to <body>: Confirm and
  // Cancel hand it back to the Delete that asked, and once the backups a
  // deletion took leave the list, to the card now in that place, the one
  // before it when it was the last, or the heading when none is left. A
  // keyboard that went on meanwhile stays where it went.
  useEffect(() => {
    const pending = afterDelete.current;
    if (!pending) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== pending.opener) {
      afterDelete.current = null;
      return;
    }
    if (restorableBackups.some((b) => pending.gone.includes(b.operationId))) return;
    afterDelete.current = null;
    const next = restorableBackups[Math.min(pending.place, restorableBackups.length - 1)];
    const card = next
      ? entries.current.get(next.operationId)?.querySelector<HTMLElement>('[role="button"]')
      : undefined;
    (card ?? headingRef.current)?.focus();
  });

  /** Answer a Delete's question: the focus goes back to the Delete that asked it. */
  const answered = (opener: HTMLElement | null | undefined): void => {
    setConfirming(null);
    opener?.focus();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="restore-panel">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-text-primary focus:outline-hidden"
      >
        {t('dataops.restore')}
      </h2>

      {isRestoring && onStop && (
        <RunStopControl onStop={onStop} requested={stopRequested} testId="restore-stop" />
      )}

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

      {/* What a restore of a Sync run's backup left as it is, changed since
          the run: listed, as the run's removal lists it, with how to put it
          back too. */}
      {lastRestore?.keptChanged && !isRestoring && (
        <p className="text-xs text-text-secondary" role="status" data-testid="restore-kept-changed">
          {lastRestore.keptChanged.runNotKept && `${t('dataops.restoreRunNotKept')} `}
          {t('dataops.restoreKeptChanged', {
            objects: lastRestore.keptChanged.objects
              .map((o) => `${o.objectApiName} ${formatNumber(o.count)}`)
              .join(', '),
          })}
        </p>
      )}

      {restorableBackups.length === 0 && !isRestoring && (
        <EmptyState
          icon={<Icon name="package" />}
          title={t('dataops.selectBackup')}
          description={t('dataops.restoreDesc')}
        />
      )}

      {restorableBackups.map((backup, place) => {
        const isSelected = backup.operationId === selectedBackupId;
        return (
          <div
            key={backup.operationId}
            ref={(entry) => {
              if (entry) entries.current.set(backup.operationId, entry);
              else entries.current.delete(backup.operationId);
            }}
            data-testid={`restore-backup-${backup.operationId}`}
          >
            <Card hoverable onClick={() => onSelectBackup?.(backup.operationId)}>
              <CardHeader
                title={
                  formatStoredDate(backup.timestamp, (date) => date.toLocaleString(uiLocale())) ??
                  t('common.dateUnknown')
                }
                subtitle={t('common.recordCount', { count: backup.totalRecords })}
                action={
                  <div className="flex items-center gap-2">
                    {backup.origin === 'sync' && (
                      <Badge data-testid={`restore-sync-badge-${backup.operationId}`}>
                        {t('dataops.restoreSyncBadge')}
                      </Badge>
                    )}
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
                {/* What a Sync run wrote over, kept for its removal, which
                    gives it back: listed here among the org's backups, it
                    said nothing of whose it was. */}
                {backup.origin === 'sync' && (
                  <p
                    className="mt-2 text-xs text-text-secondary"
                    data-testid={`restore-sync-${backup.operationId}`}
                  >
                    {t('dataops.restoreSyncNote')}
                  </p>
                )}
                {/* Said before the click: a restore of it leaves the rest of
                    each object as it is now. */}
                {backup.partial && backup.origin !== 'sync' && (
                  <BackupPartialNote
                    backup={backup}
                    data-testid={`restore-partial-${backup.operationId}`}
                  />
                )}
                {/* A Sync run's is partial while the run writes, and stays so
                    when it was cut short: what it holds is what it kept by then. */}
                {backup.partial && backup.origin === 'sync' && (
                  <p
                    className="mt-2 text-xs text-status-warning"
                    role="note"
                    data-testid={`restore-sync-partial-${backup.operationId}`}
                  >
                    {t('dataops.restoreSyncPartial')}
                  </p>
                )}
              </CardBody>
            </Card>
            {/* Beside the card, not in it: the card is a button that selects
                the backup, and a button inside it is one screen readers may
                never announce (axe, nested-interactive). */}
            {isSelected && (onRestore || onDelete) && (
              <div className="mt-2 flex flex-col items-end gap-2">
                {/* A Sync run's backup is restored as removing the run gives
                    its values back: a record changed or deleted since the run
                    is left as it is unless this says otherwise. */}
                {backup.origin === 'sync' && onRestore && onIncludeChangedChange && (
                  <label className="flex items-start gap-2 self-start text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={includeChanged}
                      disabled={isRestoring}
                      onChange={(e) => onIncludeChangedChange(e.target.checked)}
                      data-testid={`restore-include-changed-${backup.operationId}`}
                    />
                    <span>{t('dataops.restoreIncludeChanged')}</span>
                  </label>
                )}
                <div className="flex justify-end gap-2">
                  {onDelete && (
                    <Button
                      ref={(button) => {
                        if (button) deleteButtons.current.set(backup.operationId, button);
                        else deleteButtons.current.delete(backup.operationId);
                      }}
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirming({ one: backup.operationId })}
                      disabled={isRestoring || isDeleting}
                      // It keeps the keyboard while the deletion it asked for runs.
                      focusableWhenDisabled
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
                      // A Sync run's: its removal gives these values back, and
                      // once the backup is deleted it no longer can.
                      question={
                        backup.origin === 'sync'
                          ? t('dataops.backupDeleteConfirmSync', {
                              date:
                                formatStoredDate(backup.timestamp, (date) =>
                                  date.toLocaleString(uiLocale()),
                                ) ?? t('common.dateUnknown'),
                            })
                          : t('dataops.backupDeleteConfirm')
                      }
                      onConfirm={() => {
                        const opener = deleteButtons.current.get(backup.operationId) ?? null;
                        afterDelete.current = { gone: [backup.operationId], place, opener };
                        answered(opener);
                        onDelete(backup.operationId);
                      }}
                      onCancel={() => answered(deleteButtons.current.get(backup.operationId))}
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
            ref={deleteAllButton}
            variant="secondary"
            size="sm"
            onClick={() => setConfirming('all')}
            disabled={isDeleting}
            // It keeps the keyboard while the deletion it asked for runs.
            focusableWhenDisabled
            data-testid="delete-all-backups-btn"
          >
            {t('dataops.backupDeleteAll')}
          </Button>
          {confirming === 'all' && (
            <DeleteQuestion
              id={questionId}
              question={t('dataops.backupDeleteAllConfirm', { count: backups.length })}
              onConfirm={() => {
                afterDelete.current = {
                  gone: backups.map((b) => b.operationId),
                  place: 0,
                  opener: deleteAllButton.current,
                };
                answered(deleteAllButton.current);
                onDeleteAll();
              }}
              onCancel={() => answered(deleteAllButton.current)}
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
