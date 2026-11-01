import React, { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupDeleteResult, BackupSummary } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { DeleteQuestion } from './DeleteQuestion';

/** Props for {@link BackupsBeforeErasure}. */
export interface BackupsBeforeErasureProps {
  /** The org a person's records were just erased from. */
  orgId: string;
}

/**
 * The backups of an org kept on this machine once a person's records were
 * erased from it, and the offer to delete them: each was taken before the
 * erasure and holds the person's records, and restoring one brings them back.
 * Nothing said so on the page, and nothing in the panel deleted a backup.
 *
 * Says nothing when the org has no backup on this machine.
 */
export const BackupsBeforeErasure: React.FC<BackupsBeforeErasureProps> = ({ orgId }) => {
  const { t } = useTranslation();
  const boxId = useId();
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);

  const backups = useBridgeQuery<{ backups: BackupSummary[] }>(
    'backup:list',
    { orgId },
    { responseType: 'backup:list:result', errorType: 'dataops:error' },
  );
  const deletion = useBridgeMutation<BackupDeleteResult['payload']>('backup:delete', {
    responseType: 'backup:delete:result',
    errorType: 'dataops:error',
  });

  const deleted = deletion.data?.deleted;
  if (deleted) {
    return (
      <p className="text-xs text-text-secondary" role="status" data-testid="dsr-backups-deleted">
        {t('dataops.backupsDeleted', { count: deleted.length })}
      </p>
    );
  }
  const held = backups.data?.backups ?? [];
  if (held.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-2 rounded-sm border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
      data-testid="dsr-backups-before"
    >
      <p id={boxId}>{t('dataops.dsr.backupsBefore', { count: held.length })}</p>
      {deletion.error && (
        <ErrorBanner
          message={deletion.error}
          code={deletion.errorCode}
          data-testid="dsr-backups-delete-error"
        />
      )}
      <div>
        <Button
          ref={deleteButton}
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(true)}
          loading={deletion.loading}
          // It keeps the keyboard while the deletion it asked for runs.
          focusableWhenDisabled
          aria-describedby={boxId}
          data-testid="dsr-backups-delete"
        >
          {t('dataops.dsr.deleteBackupsBefore', { count: held.length })}
        </Button>
      </div>
      {/* The question the Restore tab's Delete asks, its button saying what
          it deletes: it was a bare Confirm under a sentence about restoring. */}
      {confirming && (
        <DeleteQuestion
          id={questionId}
          testId="dsr-backups-delete"
          question={t('dataops.backupDeleteAllConfirm', { count: held.length })}
          confirmLabel={t('dataops.dsr.deleteBackupsBefore', { count: held.length })}
          onConfirm={() => {
            setConfirming(false);
            deleteButton.current?.focus();
            deletion.mutate({ orgId, operationIds: held.map((b) => b.operationId) });
          }}
          onCancel={() => {
            setConfirming(false);
            deleteButton.current?.focus();
          }}
        />
      )}
    </div>
  );
};
