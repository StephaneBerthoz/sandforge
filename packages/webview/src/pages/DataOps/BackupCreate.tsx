import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { RunStopControl } from './RunStopControl';

/** BackupCreate component props. */
export interface BackupCreateProps {
  /** The objects Create Backup reads. */
  objects: readonly string[];
  /** The template whose objects those are, when one is picked; every template's otherwise. */
  template?: string;
  onCreate: () => void;
  isCreating?: boolean;
  /** Stop the backup in progress: shown while it reads (`RunStopControl`). */
  onStop?: () => void;
  /** Whether that stop was sent and not refused. */
  stopRequested?: boolean;
  /**
   * The objects Create Backup reads that hold more rows than one backup
   * does: a backup in slices holds them whole, and its box is offered.
   */
  slicesOffered?: readonly string[];
  /** Whether Create Backup takes them in slices. */
  inSlices?: boolean;
  onInSlicesChange?: (inSlices: boolean) => void;
}

/**
 * Create backup, beside the masking template: a backup reads the objects the
 * template picked masks, or every template's with none picked, and was taken
 * on a tab of its own, away from the template that chose what it read.
 */
export const BackupCreate: React.FC<BackupCreateProps> = ({
  objects,
  template,
  onCreate,
  isCreating = false,
  onStop,
  stopRequested = false,
  slicesOffered = [],
  inSlices = false,
  onInSlicesChange,
}) => {
  const { t } = useTranslation();
  const objectsId = useId();
  const slicesHintId = useId();

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2"
      data-testid="backup-create"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Said before the click: the objects it reads follow the templates. */}
        <p
          id={objectsId}
          className="min-w-0 flex-1 text-xs text-text-secondary"
          data-testid="backup-objects"
        >
          {template
            ? t('dataops.backupObjectsTemplate', { objects: objects.join(', '), name: template })
            : t('dataops.backupObjectsAll', { objects: objects.join(', ') })}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCreate}
          loading={isCreating}
          aria-describedby={objectsId}
          data-testid="create-backup-btn"
        >
          {t('dataops.createBackup')}
        </Button>
      </div>

      {isCreating && onStop && (
        <RunStopControl onStop={onStop} requested={stopRequested} testId="backup-stop" />
      )}

      {/* An object past what one backup holds was backed up up to the cap,
          the rest said lost to a restore: in slices, each slice a backup of
          its own, it is held whole. Asked, never assumed. */}
      {slicesOffered.length > 0 && onInSlicesChange && (
        <div className="flex flex-col gap-1" data-testid="backup-slices">
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={inSlices}
              disabled={isCreating}
              onChange={(e) => onInSlicesChange(e.target.checked)}
              aria-describedby={slicesHintId}
              data-testid="backup-slices-toggle"
            />
            <span>{t('dataops.slices.backup.toggle')}</span>
          </label>
          <p id={slicesHintId} className="text-xs text-text-secondary">
            {t('dataops.slices.backup.hint', {
              count: slicesOffered.length,
              objects: slicesOffered.join(', '),
            })}
          </p>
        </div>
      )}
    </div>
  );
};
