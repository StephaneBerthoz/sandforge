import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupSummary } from '@sandforge/shared';
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
