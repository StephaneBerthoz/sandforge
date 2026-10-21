import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupDeleteResult, BackupSummary } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';

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
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);

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
      <p id={questionId}>{t('dataops.dsr.backupsBefore', { count: held.length })}</p>
      {deletion.error && (
        <ErrorBanner
          message={deletion.error}
          code={deletion.errorCode}
          data-testid="dsr-backups-delete-error"
        />
      )}
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button
              variant="danger"
              size="sm"
              aria-describedby={questionId}
              loading={deletion.loading}
              onClick={() => {
                setConfirming(false);
                deletion.mutate({ orgId, operationIds: held.map((b) => b.operationId) });
              }}
              data-testid="dsr-backups-delete-confirm"
            >
              {t('common.confirm')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirming(false)}
              data-testid="dsr-backups-delete-cancel"
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirming(true)}
            data-testid="dsr-backups-delete"
          >
            {t('dataops.dsr.deleteBackupsBefore', { count: held.length })}
          </Button>
        )}
      </div>
    </div>
  );
};
