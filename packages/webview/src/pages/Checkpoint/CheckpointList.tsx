import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckpointInvalidReason, CheckpointListEntry } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import {
  formatDate,
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  formatStoredDate,
} from '../../utils/formatters';
import { CHECKPOINT_NAME_MAX, isCheckpointName, recordsHeld } from './checkpointFacts';

/**
 * Why a checkpoint listed can only be deleted, as each row says it. A
 * refreshed sandbox names its date when the store knows it.
 */
const WHY_KEYS: Readonly<Record<CheckpointInvalidReason, string>> = {
  damaged: 'checkpoint.list.why.damaged',
  taking: 'checkpoint.list.why.taking',
  failed: 'checkpoint.list.why.failed',
  refreshed: 'checkpoint.list.why.refreshedUndated',
  scratchExpired: 'checkpoint.list.why.scratchExpired',
};

/** Props for {@link CheckpointList}. */
export interface CheckpointListProps {
  /** The org's checkpoints, newest first, as the store lists them. */
  entries: readonly CheckpointListEntry[];
  /** The org they are of, as the page names it. */
  orgName: string;
  /** Call a checkpoint something else. */
  onRename: (checkpointId: string, name: string) => void;
  /** Keep a checkpoint until it is deleted, or give it back an expiry date. */
  onKeep: (checkpointId: string, keep: boolean) => void;
  /** Delete a checkpoint from this machine, once confirmed. */
  onDelete: (checkpointId: string) => void;
  /** Open what a rewind to a checkpoint would do. */
  onRewind: (checkpointId: string) => void;
  /**
   * The checkpoint whose Rewind… takes the keyboard as the list is drawn:
   * the one whose preview was just left.
   */
  focusRewind?: string;
}

/** The name a checkpoint is listed by: its own, or its folder's when its file cannot be read. */
function nameOf(entry: CheckpointListEntry): string {
  return entry.checkpoint?.name ?? entry.checkpointId;
}

/**
 * The checkpoints of an org kept on this machine, read without contacting
 * the org: each with when it was taken, the records it holds, the room it
 * takes and how long it is kept, and Rewind…, which opens what a rewind to it
 * would do. One that cannot be rewound to says why, and can only be deleted.
 */
export const CheckpointList: React.FC<CheckpointListProps> = ({
  entries,
  orgName,
  onRename,
  onKeep,
  onDelete,
  onRewind,
  focusRewind,
}) => {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<CheckpointListEntry | null>(null);
  const [deleting, setDeleting] = useState<CheckpointListEntry | null>(null);

  const deleteDescription = (entry: CheckpointListEntry): string => {
    const rewoundAt = entry.undo ? entry.checkpoint?.lastRewind?.endedAt : undefined;
    const rewoundOn = rewoundAt ? formatStoredDate(rewoundAt, (d) => formatDate(d)) : null;
    return rewoundOn
      ? t('checkpoint.delete.descriptionUndo', {
          name: nameOf(entry),
          org: orgName,
          date: rewoundOn,
        })
      : t('checkpoint.delete.description', { name: nameOf(entry), org: orgName });
  };

  return (
    <>
      <ul className="flex flex-col gap-2" data-testid="checkpoint-list">
        {entries.map((entry) => (
          <CheckpointRow
            key={entry.checkpointId}
            entry={entry}
            orgName={orgName}
            onRename={() => setRenaming(entry)}
            onKeep={(keep) => onKeep(entry.checkpointId, keep)}
            onDelete={() => setDeleting(entry)}
            onRewind={() => onRewind(entry.checkpointId)}
            focusRewind={focusRewind === entry.checkpointId}
          />
        ))}
      </ul>

      {renaming && (
        <RenameDialog
          entry={renaming}
          onClose={() => setRenaming(null)}
          onSave={(name) => {
            onRename(renaming.checkpointId, name);
            setRenaming(null);
          }}
        />
      )}

      <DangerConfirm
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) onDelete(deleting.checkpointId);
          setDeleting(null);
        }}
        title={deleting ? t('checkpoint.delete.title', { name: nameOf(deleting) }) : ''}
        description={deleting ? deleteDescription(deleting) : ''}
        confirmLabel={t('common.delete')}
      />
    </>
  );
};

/** Props for one row of the list. */
interface CheckpointRowProps {
  entry: CheckpointListEntry;
  orgName: string;
  onRename: () => void;
  onKeep: (keep: boolean) => void;
  onDelete: () => void;
  onRewind: () => void;
  /** Its Rewind… takes the keyboard as it is drawn. */
  focusRewind: boolean;
}

/** One checkpoint of the list, with what can be done to it. */
const CheckpointRow: React.FC<CheckpointRowProps> = ({
  entry,
  orgName,
  onRename,
  onKeep,
  onDelete,
  onRewind,
  focusRewind,
}) => {
  const { t } = useTranslation();
  const nameId = useId();
  const rewindRef = useRef<HTMLButtonElement>(null);
  // Back from a preview, the keyboard is where it was before it opened.
  useEffect(() => {
    if (focusRewind) rewindRef.current?.focus();
  }, [focusRewind]);
  const { checkpoint } = entry;
  const usable = entry.valid && checkpoint !== undefined;
  const records = checkpoint ? recordsHeld(checkpoint) : 0;
  const takenAt = checkpoint
    ? formatStoredDate(checkpoint.takenAt, (d) => formatRelativeTime(d))
    : null;
  const keptUntil =
    checkpoint && checkpoint.expiresAt !== null
      ? formatStoredDate(checkpoint.expiresAt, (d) => formatDate(d))
      : null;
  const refreshedOn =
    entry.why === 'refreshed' && entry.refreshedAt
      ? formatStoredDate(entry.refreshedAt, (d) => formatDate(d))
      : null;
  const why = !entry.valid
    ? refreshedOn
      ? t('checkpoint.list.why.refreshed', { org: orgName, date: refreshedOn })
      : t(WHY_KEYS[entry.why ?? 'damaged'], { org: orgName })
    : null;

  return (
    <li
      className="flex flex-col gap-2 rounded-sm border border-subtle bg-surface-1 p-3"
      data-testid={`checkpoint-row-${entry.checkpointId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={nameId} className="text-sm font-semibold text-text-primary break-words">
            {nameOf(entry)}
          </h3>
          {checkpoint && (
            <p
              className="text-xs text-text-secondary"
              data-testid={`checkpoint-row-facts-${entry.checkpointId}`}
            >
              {[
                takenAt ? t('checkpoint.list.taken', { age: takenAt }) : null,
                t('checkpoint.list.records', { count: records, formatted: formatNumber(records) }),
                formatFileSize(checkpoint.bytes),
                checkpoint.expiresAt === null
                  ? t('checkpoint.list.keptForever')
                  : t('checkpoint.list.keptUntil', {
                      date: keptUntil ?? t('common.dateUnknown'),
                    }),
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {usable && (
            <Button
              ref={rewindRef}
              variant="secondary"
              size="sm"
              onClick={onRewind}
              aria-describedby={nameId}
              data-testid={`checkpoint-rewind-${entry.checkpointId}`}
            >
              {t('checkpoint.list.rewind')}
            </Button>
          )}
          {usable && (
            <label className="flex items-center gap-1.5 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={checkpoint.expiresAt === null}
                onChange={(event) => onKeep(event.target.checked)}
                aria-describedby={nameId}
                data-testid={`checkpoint-keep-${entry.checkpointId}`}
              />
              <span>{t('checkpoint.keep')}</span>
            </label>
          )}
          {usable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRename}
              aria-describedby={nameId}
              data-testid={`checkpoint-rename-${entry.checkpointId}`}
            >
              {t('checkpoint.list.rename')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-describedby={nameId}
            data-testid={`checkpoint-delete-${entry.checkpointId}`}
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>
      {why && (
        <p
          className="text-xs text-text-primary"
          data-testid={`checkpoint-why-${entry.checkpointId}`}
        >
          {why}
        </p>
      )}
    </li>
  );
};

/** Props for the rename dialog. */
interface RenameDialogProps {
  entry: CheckpointListEntry;
  onClose: () => void;
  onSave: (name: string) => void;
}

/** What a checkpoint is called, changed: one line of text, as at its take. */
const RenameDialog: React.FC<RenameDialogProps> = ({ entry, onClose, onSave }) => {
  const { t } = useTranslation();
  const inputId = useId();
  const [name, setName] = useState(nameOf(entry));
  const valid = isCheckpointName(name);
  const save = (): void => {
    if (valid) onSave(name.trim());
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('checkpoint.rename.title', { name: nameOf(entry) })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="checkpoint-rename-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={!valid}
            data-testid="checkpoint-rename-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Input
        id={inputId}
        label={t('checkpoint.name')}
        value={name}
        maxLength={CHECKPOINT_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        error={valid ? undefined : t('checkpoint.nameRule')}
        data-testid="checkpoint-rename-input"
      />
    </Dialog>
  );
};
