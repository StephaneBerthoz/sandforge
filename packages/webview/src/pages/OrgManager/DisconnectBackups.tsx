import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupSummary, CheckpointListResponse } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';

/** Props for {@link DisconnectBackups}. */
export interface DisconnectBackupsProps {
  /** The org about to be disconnected. */
  orgId: string;
  /** Whether its backups go with it. */
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The question a disconnection asks about the org's DataOps backups kept on
 * this machine: whether they go with it. Each holds the records' values in
 * clear, and they outlived the org, which no page lists any more once it is
 * forgotten. Asked only when the org has some; off unless ticked, as a backup
 * is the user's way back.
 */
export const DisconnectBackups: React.FC<DisconnectBackupsProps> = ({
  orgId,
  checked,
  onChange,
}) => {
  const { t } = useTranslation();
  const listed = useBridgeQuery<{ backups: BackupSummary[] }>(
    'backup:list',
    { orgId },
    { responseType: 'backup:list:result', errorType: 'dataops:error' },
  );
  const count = listed.data?.backups.length ?? 0;
  if (count === 0) return null;
  return (
    <label className="flex items-start gap-2 text-xs text-text-primary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="disconnect-delete-backups"
      />
      <span>{t('org.disconnectDeleteBackups', { count })}</span>
    </label>
  );
};

/** Props for {@link DisconnectCheckpoints}. */
export interface DisconnectCheckpointsProps {
  /** The org about to be disconnected. */
  orgId: string;
  /** The checkpoints that go with it: none until ticked. */
  checked: readonly string[];
  /** Ticked: every checkpoint of the org listed; unticked: none. */
  onChange: (checkpointIds: string[]) => void;
}

/**
 * The same question of the org's checkpoints kept on this machine, which the
 * Checkpoints page lists only for an org that is connected: whether they go
 * with it, and the Undo of their rewinds with them. Each holds the records'
 * values in clear. Asked only when the org has some; off unless ticked, as a
 * checkpoint is the way back to a state of the org. The ids are those the
 * store lists for the org, all of them — those of the org before a refresh
 * among them.
 */
export const DisconnectCheckpoints: React.FC<DisconnectCheckpointsProps> = ({
  orgId,
  checked,
  onChange,
}) => {
  const { t } = useTranslation();
  const listed = useBridgeQuery<CheckpointListResponse['payload']>('checkpoint:list', { orgId });
  const ids = (listed.data?.checkpoints ?? []).map((entry) => entry.checkpointId);
  const count = ids.length;
  if (count === 0) return null;
  return (
    <label className="flex items-start gap-2 text-xs text-text-primary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked.length > 0}
        onChange={(e) => onChange(e.target.checked ? ids : [])}
        data-testid="disconnect-delete-checkpoints"
      />
      <span>{t('org.disconnectDeleteCheckpoints', { count })}</span>
    </label>
  );
};
