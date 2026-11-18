import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { BACKUP_MAX_RECORDS_PER_OBJECT } from '@sandforge/shared';
import type {
  BackupObjectHeld,
  BackupSetSummary,
  BackupSummary,
  BackupStatus,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';
import { RunStopControl } from './RunStopControl';
import { SliceSetRow } from './SliceSetRow';
import { DeleteQuestion } from './DeleteQuestion';
import { DataOpsAutomation, NO_ACCORD, type DataOpsAutomationAccord } from './DataOpsAutomation';

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
  /**
   * Of a set of slices, the slices written back, and those restored before,
   * which the restore did not read again.
   */
  slices?: { restored: readonly number[]; skipped: readonly number[] };
}

/** How a restore writes, as its confirmation's boxes say. */
export interface RestoreOptions {
  /**
   * Write every row of the backup back, rather than read the org first and
   * write only the rows that changed since.
   */
  rewriteAll: boolean;
  /**
   * Of a Sync run's backup, restore the records changed or deleted since the
   * run too, rather than leave them as they are, as removing the run does.
   */
  includeChanged: boolean;
}

/** Rows a REST call writes back: a restore compares, then writes what differs, 200 a call. */
const RESTORE_BATCH = 200;

const STATUS_VARIANT: Record<BackupStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  expired: 'warning',
};

/**
 * The word for each status, in the interface language. The badge printed the
 * stored code, "completed" in lower-case English whatever the language.
 */
const STATUS_KEY: Record<BackupStatus, string> = {
  pending: 'dataops.backupStatus.pending',
  running: 'dataops.backupStatus.running',
  completed: 'dataops.backupStatus.completed',
  failed: 'dataops.backupStatus.failed',
  expired: 'dataops.backupStatus.expired',
};

/**
 * Whether a backup holds only part of what it read: one stopped at the cap,
 * or whose read failed after it kept some rows. It wore a green "completed"
 * on the Backup tab above its own note saying a cap stopped it, while the
 * Restore tab called the same backup Partial.
 */
export function isPartialBackup(backup: BackupSummary): boolean {
  return backup.partial === true || (backup.status === 'failed' && backup.totalRecords > 0);
}

/**
 * Whether a backup holds rows to put back: one that completed, or whose read
 * failed part-way after it kept some. One kept with no row has nothing to
 * restore; one that failed part-way was once listed on the Backup tab alone,
 * and only the command line could restore it.
 */
export function isRestorable(backup: BackupSummary): boolean {
  return backup.status === 'completed' || (backup.status === 'failed' && backup.totalRecords > 0);
}

/**
 * How many objects a backup holds, and which. The card said "2 objects" and
 * never named them, so nothing told which backup held the object to restore.
 */
export const BackupObjects: React.FC<{ backup: BackupSummary }> = ({ backup }) => {
  const { t } = useTranslation();
  return (
    <div className="flex gap-4 text-xs text-text-secondary">
      <span data-testid={`backup-objects-${backup.operationId}`}>
        {backup.objectResults.length === 0
          ? t('common.objectCount', { count: 0 })
          : t('dataops.backupObjectNames', {
              count: backup.objectResults.length,
              objects: backup.objectResults.map((o) => o.objectApiName).join(', '),
            })}
      </span>
    </div>
  );
};

/**
 * One object a backup holds only part of: the rows read, the rows the org
 * held, and why it stopped — or that the backup failed before it read the
 * object at all.
 */
function shortObjectLine(o: BackupObjectHeld, t: TFunction): string {
  if (o.stoppedAt === 'not_reached') {
    return t('dataops.backupNotReached', { object: o.objectApiName });
  }
  const values = {
    object: o.objectApiName,
    read: formatNumber(o.recordCount),
    held: o.orgCount === undefined ? '' : formatNumber(o.orgCount),
  };
  if (o.stoppedAt === 'cap') {
    // Past what any backup holds of one object, the setting it named raises
    // nothing: what copies the whole object is said instead.
    if (o.orgCount !== undefined && o.orgCount > BACKUP_MAX_RECORDS_PER_OBJECT) {
      return t('dataops.backupStoppedPastMax', values);
    }
    return o.orgCount === undefined
      ? t('dataops.backupStoppedAtCapUncounted', values)
      : t('dataops.backupStoppedAtCap', values);
  }
  return o.orgCount === undefined
    ? t('dataops.backupReadFailedUncounted', values)
    : t('dataops.backupReadFailed', values);
}

/**
 * What a partial backup holds of each object it holds only part of. A restore
 * brings back those rows only, and the rest of each object stays as it is —
 * masked, after a masking run. A backup taken since the cap says, per object,
 * the rows read against the rows the org held and whether the cap stopped it
 * or the read failed, and names each object a failure kept it from reading;
 * an older one, which stopped at the tier's bound, says what it recorded.
 */
export const BackupPartialNote: React.FC<{ backup: BackupSummary; 'data-testid': string }> = ({
  backup,
  'data-testid': testId,
}) => {
  const { t } = useTranslation();
  const short = backup.objectResults.filter((o) => o.truncated);
  const explained = short.filter((o) => o.stoppedAt !== undefined);
  const older = short.filter((o) => o.stoppedAt === undefined);
  return (
    <div
      className="mt-2 flex flex-col gap-1 text-xs text-status-warning"
      role="note"
      data-testid={testId}
    >
      {older.length > 0 && (
        <p>
          {t('dataops.backupPartial', {
            objects: older.map((o) => `${o.objectApiName} (${o.recordCount})`).join(', '),
          })}
        </p>
      )}
      {explained.length > 0 && (
        <>
          <p>{t('dataops.backupPartialLead')}</p>
          <ul className="list-disc pl-4">
            {explained.map((o) => (
              <li key={o.objectApiName}>{shortObjectLine(o, t)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

/** The moment a backup was taken, as its cards name it. */
function takenAt(backup: BackupSummary, t: TFunction): string {
  return (
    formatStoredDate(backup.timestamp, (date) => date.toLocaleString(uiLocale())) ??
    t('common.dateUnknown')
  );
}

/**
 * What a restore of `backup` writes over: the rows changed since it get its
 * values back whoever changed them, or, of a Sync run's, the records changed
 * since the run are left as they are unless asked.
 */
function restoreSentence(backup: BackupSummary, includeChanged: boolean, t: TFunction): string {
  const date = takenAt(backup, t);
  return backup.origin === 'sync' && !includeChanged
    ? t('dataops.restoreConfirm.syncKept', { date })
    : t('dataops.restoreConfirm.changed', { date });
}

/** The slices a restore of a set reaches: those named, or every slice taken not restored yet. */
function slicesRestored(
  set: BackupSetSummary,
  asked: readonly number[] | undefined,
  rewriteAll: boolean,
): BackupSetSummary['slices'] {
  const taken = set.slices.filter((s) => s.state !== 'pending');
  return asked
    ? taken.filter((s) => asked.includes(s.index))
    : taken.filter((s) => rewriteAll || s.restoredAt === undefined);
}

/** BackupPanel component props. */
export interface BackupPanelProps {
  /**
   * The org a restore writes to, by the name the page shows it under: named
   * in the empty list and in the question a Restore asks.
   */
  orgName?: string;
  /**
   * The org a restore writes to, by its id in the registry: its question
   * reads what the org runs as the backup's values go back, and waits for it.
   * Without it, no such read, and the restore carries no acceptance of what
   * fires.
   */
  orgId?: string;
  /** Open Masking, where Create backup takes one: what an empty list offers. */
  onCreateBackup?: () => void;
  backups?: BackupSummary[];
  /**
   * The sets of slices of the org, one row each: a masking or a backup run
   * in slices, each slice a backup of its own.
   */
  sets?: BackupSetSummary[];
  /**
   * The backup or the set a masking run's result opened the tab on: its entry
   * is brought into view, and a set shows its slices.
   */
  openedId?: string;
  /** Put a backup back into the org, once its question is answered yes. */
  onRestore?: (
    operationId: string,
    options: RestoreOptions,
    accord?: DataOpsAutomationAccord,
  ) => void;
  /** Restore a set: every slice not restored yet, or the slices named. */
  onRestoreSet?: (
    setId: string,
    slices: number[] | undefined,
    options: Pick<RestoreOptions, 'rewriteAll'>,
    accord?: DataOpsAutomationAccord,
  ) => void;
  isRestoring?: boolean;
  restoreProgress?: { completed: number; total: number };
  /** What the last restore wrote, left alone and had refused. */
  lastRestore?: RestoreCounts;
  /** Save this backup, records included, to a file, so it can leave the machine. */
  onExport?: (operationId: string) => void;
  /** Delete one backup or set from this machine, once asked to confirm. */
  onDelete?: (operationId: string) => void;
  /** Delete every backup of the org from this machine, once asked to confirm. */
  onDeleteAll?: () => void;
  /** A deletion is in flight. */
  isDeleting?: boolean;
  /** Stop the restore in progress: shown while it runs (`RunStopControl`). */
  onStop?: () => void;
  /** Whether that stop was sent and not refused. */
  stopRequested?: boolean;
  /**
   * Open Checkpoints on a take of the org: offered where a checkpoint can be
   * taken, a connected sandbox, scratch org or Developer Edition.
   */
  onTakeCheckpoint?: () => void;
}

/** What a restore's question asks before anything is sent. */
const ASKED_NONE: RestoreOptions = { rewriteAll: false, includeChanged: false };

/**
 * The Backups tab: every backup of the org on this machine, one list, each
 * with Restore…, Export and Delete. The list was on two tabs: Backup showed
 * Export, Restore showed Delete and, once a card was clicked, Restore. How a
 * restore writes is asked in its question, not ticked above the list.
 */
export const BackupPanel: React.FC<BackupPanelProps> = ({
  orgName,
  orgId,
  onCreateBackup,
  backups = [],
  sets = [],
  openedId,
  onRestore,
  onRestoreSet,
  isRestoring = false,
  restoreProgress,
  lastRestore,
  onExport,
  onDelete,
  onDeleteAll,
  isDeleting = false,
  onStop,
  stopRequested = false,
  onTakeCheckpoint,
}) => {
  const { t } = useTranslation();
  const checkpointWhyId = useId();
  /** The set a Restore asks about, and the slices it names: every one not restored yet when none. */
  const [askingSet, setAskingSet] = useState<{ setId: string; slices?: number[] } | null>(null);
  /** The sets whose slices were shown or hidden by hand; one opened on otherwise shows them. */
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  /**
   * What a Delete asks to confirm: one backup, by its id, or every one of the
   * org. A backup deleted cannot be restored, so the first click only asks.
   */
  const [confirming, setConfirming] = useState<{ one: string } | 'all' | null>(null);
  /**
   * The backup a Restore asks about. A restore writes into the org, over
   * every row changed since the backup whoever changed it: it is sent only
   * once its question, which names the org, is answered yes.
   */
  const [asking, setAsking] = useState<string | null>(null);
  /** How the restore asked writes, as its question's boxes say: neither ticked as it opens. */
  const [options, setOptions] = useState<RestoreOptions>(ASKED_NONE);
  /** What the question's read of the org's automation lets through and mutes. */
  const [accord, setAccord] = useState<DataOpsAutomationAccord>(NO_ACCORD);
  /** Why the question waits on that read, if it does. */
  const [automationHeld, setAutomationHeld] = useState<string | undefined>(undefined);
  const questionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Each backup's entry, where its first button is found to take the focus. */
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

  // A backup deleted or gone from the list while its Restore asks takes the
  // question with it.
  const askedBackup =
    asking === null ? undefined : backups.find((b) => b.operationId === asking && isRestorable(b));
  // So does a set gone, and the slices its question would restore.
  const askedSet = askingSet === null ? undefined : sets.find((s) => s.setId === askingSet.setId);
  const askedSlices = askedSet
    ? slicesRestored(askedSet, askingSet?.slices, options.rewriteAll)
    : [];
  /** Per object, the rows the asked restore of a set puts back. */
  const askedObjects = [...new Set(askedSlices.map((s) => s.objectApiName))].map((name) => ({
    objectApiName: name,
    records: askedSlices
      .filter((s) => s.objectApiName === name)
      .reduce((sum, s) => sum + s.rows, 0),
  }));
  const askedRows = askedObjects.reduce((sum, o) => sum + o.records, 0);

  // Opened from a masking run's result, the tab brings the backup it named
  // into view: the list can be long, and nothing was selected any more.
  useEffect(() => {
    if (openedId) entries.current.get(openedId)?.scrollIntoView?.({ block: 'nearest' });
  }, [openedId]);

  // Its question gone with the answer, the focus fell to <body>: Confirm and
  // Cancel hand it back to the Delete that asked, and once the backups a
  // deletion took leave the list, to the first button of the entry now in
  // that place, the one before it when it was the last, or the heading when
  // none is left. A keyboard that went on meanwhile stays where it went.
  useEffect(() => {
    const pending = afterDelete.current;
    if (!pending) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== pending.opener) {
      afterDelete.current = null;
      return;
    }
    if (backups.some((b) => pending.gone.includes(b.operationId))) return;
    afterDelete.current = null;
    const next = backups[Math.min(pending.place, backups.length - 1)];
    const button = next
      ? entries.current.get(next.operationId)?.querySelector<HTMLElement>('button')
      : undefined;
    (button ?? headingRef.current)?.focus();
  });

  /** Answer a Delete's question: the focus goes back to the Delete that asked it. */
  const answered = (opener: HTMLElement | null | undefined): void => {
    setConfirming(null);
    opener?.focus();
  };

  /** Close a restore's question, its boxes unticked for the next one. */
  const closeQuestion = (): void => {
    setAsking(null);
    setAskingSet(null);
    setOptions(ASKED_NONE);
    setAccord(NO_ACCORD);
  };

  /** The box that writes every row back, asked in a restore's question. */
  const rewriteAllBox = (
    <label className="flex items-start gap-2 text-xs text-text-primary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={options.rewriteAll}
        onChange={(e) => setOptions((was) => ({ ...was, rewriteAll: e.target.checked }))}
        data-testid="restore-rewrite-all"
      />
      <span>{t('dataops.restoreRewriteAll')}</span>
    </label>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="backup-panel">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-text-primary focus:outline-hidden"
      >
        {t('dataops.backup')}
      </h2>

      {/* A backup holds only the objects the templates mask: it is no way
          back from a Seed, a Sync or a Forge run on the others. A checkpoint
          is that way back, said where the backups are looked for. */}
      {onTakeCheckpoint && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs"
          data-testid="backup-checkpoint"
        >
          <Icon name="history" className="text-sm text-hue-indigo" />
          <p id={checkpointWhyId} className="min-w-0 flex-1 text-text-primary">
            {t('dataops.checkpointBeforeRisk')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onTakeCheckpoint}
            aria-describedby={checkpointWhyId}
            data-testid="backup-checkpoint-take"
          >
            {t('dataops.takeCheckpoint')}
          </Button>
        </div>
      )}

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

      {lastRestore && !isRestoring && (
        <p className="text-xs text-text-secondary" role="status" data-testid="restore-result">
          {t('dataops.restoreResult', {
            written: lastRestore.written,
            unchanged: lastRestore.unchanged,
            failed: lastRestore.failed,
          })}
        </p>
      )}
      {lastRestore?.slices && !isRestoring && (
        <p className="text-xs text-text-secondary" role="status" data-testid="restore-set-result">
          {t('dataops.slices.set.result', {
            restored:
              lastRestore.slices.restored.map((index) => formatNumber(index)).join(', ') || '0',
            skipped:
              lastRestore.slices.skipped.map((index) => formatNumber(index)).join(', ') || '0',
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

      {/* With none, the way to take one: Create backup, beside the template
          on the Masking tab. */}
      {backups.length === 0 && sets.length === 0 && !isRestoring && (
        <EmptyState
          icon={<Icon name="save" />}
          title={orgName ? t('dataops.restoreEmpty', { org: orgName }) : t('dataops.noBackups')}
          description={t('dataops.restoreEmptyDesc')}
          {...(onCreateBackup
            ? { actionLabel: t('dataops.restoreCreateBackup'), onAction: onCreateBackup }
            : {})}
        />
      )}

      {backups.map((backup, place) => {
        const restorable = isRestorable(backup);
        return (
          <div
            key={backup.operationId}
            ref={(entry) => {
              if (entry) entries.current.set(backup.operationId, entry);
              else entries.current.delete(backup.operationId);
            }}
            className="flex flex-col gap-2"
            data-testid={`backup-${backup.operationId}`}
          >
            <Card>
              <CardHeader
                // A backup records its timestamp, not a config id or a byte
                // size, so the header names the moment it was taken. A stored
                // timestamp that is not a date read "Invalid Date".
                title={takenAt(backup, t)}
                subtitle={t('common.recordCount', { count: backup.totalRecords })}
                action={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {backup.origin === 'sync' && (
                      <Badge data-testid={`restore-sync-badge-${backup.operationId}`}>
                        {t('dataops.restoreSyncBadge')}
                      </Badge>
                    )}
                    {isPartialBackup(backup) ? (
                      <Badge variant="warning" data-testid={`backup-status-${backup.operationId}`}>
                        {t('dataops.restorePartialBadge')}
                      </Badge>
                    ) : (
                      <Badge
                        variant={STATUS_VARIANT[backup.status]}
                        data-testid={`backup-status-${backup.operationId}`}
                      >
                        {t(STATUS_KEY[backup.status])}
                      </Badge>
                    )}
                    {/* Offered with the org it writes to named, never without. */}
                    {onRestore && orgName && restorable && (
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Icon name="discard" />}
                        onClick={() => {
                          setOptions(ASKED_NONE);
                          setAsking(backup.operationId);
                        }}
                        disabled={isRestoring || isDeleting}
                        // The keyboard stays on the row while a deletion or a
                        // restore runs: a disabled button drops the focus.
                        focusableWhenDisabled
                        data-testid={`restore-btn-${backup.operationId}`}
                      >
                        {t('dataops.restore')}
                      </Button>
                    )}
                    {onExport && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onExport(backup.operationId)}
                        data-testid={`export-backup-${backup.operationId}`}
                      >
                        {t('dataops.exportBackup')}
                      </Button>
                    )}
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
                  </div>
                }
              />
              <CardBody>
                <BackupObjects backup={backup} />
                {/* What a Sync run wrote over, kept for its removal, which
                    gives it back: listed among the org's backups, it said
                    nothing of whose it was. */}
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
                    data-testid={`backup-partial-${backup.operationId}`}
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
                {/* Kept, a mask was written back over the real value by a restore. */}
                {backup.objectResults
                  .filter((o) => (o.notKept ?? []).length > 0)
                  .map((o) => (
                    <p
                      key={o.objectApiName}
                      className="mt-2 text-xs text-status-warning"
                      data-testid={`backup-not-kept-${backup.operationId}-${o.objectApiName}`}
                    >
                      {t('dataops.backupNotKeptEncrypted', {
                        object: o.objectApiName,
                        fields: (o.notKept ?? []).join(', '),
                      })}
                    </p>
                  ))}
              </CardBody>
            </Card>
            {onDelete &&
              confirming !== null &&
              confirming !== 'all' &&
              confirming.one === backup.operationId && (
                <DeleteQuestion
                  id={questionId}
                  confirmLabel={t('dataops.backupDelete')}
                  // A Sync run's: its removal gives these values back, and
                  // once the backup is deleted it no longer can.
                  question={
                    backup.origin === 'sync'
                      ? t('dataops.backupDeleteConfirmSync', { date: takenAt(backup, t) })
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
        );
      })}

      {/* A set of slices, one row whatever its slices: restored whole, or a
          slice at a time, and deleted whole. Opened from a masking run's
          result, it shows its slices. */}
      {sets.map((set) => (
        <div
          key={set.setId}
          ref={(entry) => {
            if (entry) entries.current.set(set.setId, entry);
            else entries.current.delete(set.setId);
          }}
        >
          <SliceSetRow
            set={set}
            expanded={toggled[set.setId] ?? openedId === set.setId}
            onToggle={() =>
              setToggled((was) => ({
                ...was,
                [set.setId]: !(was[set.setId] ?? openedId === set.setId),
              }))
            }
            {...(onRestoreSet && orgName
              ? {
                  onRestore: (slices?: number[]) => {
                    setOptions(ASKED_NONE);
                    setAskingSet({ setId: set.setId, ...(slices ? { slices } : {}) });
                  },
                }
              : {})}
            {...(onDelete ? { onDelete: () => onDelete(set.setId) } : {})}
            busy={isRestoring || isDeleting}
          />
        </div>
      ))}

      {/* The org's backups, on this machine, all at once: what a person's
          erasure or the org's masking leaves in clear in each of them. */}
      {onDeleteAll && backups.length + sets.length > 0 && !isRestoring && (
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
              confirmLabel={t('dataops.backupDeleteAll')}
              question={t('dataops.backupDeleteAllConfirm', {
                count: backups.length + sets.length,
              })}
              onConfirm={() => {
                afterDelete.current = {
                  gone: [...backups.map((b) => b.operationId), ...sets.map((s) => s.setId)],
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

      {/* Nothing is sent before the yes: the org, what each object of the
          backup holds, how the restore writes, and what it writes over,
          whoever wrote it. Production Guard still asks on a production org. */}
      {onRestore && orgName && (
        <DangerConfirm
          open={askedBackup !== undefined}
          variant="warning"
          onClose={closeQuestion}
          onConfirm={() => {
            const asked = options;
            const given = accord;
            closeQuestion();
            // Confirmed once what the org runs was listed below: what fires
            // is accepted, the emails as their box says.
            if (askedBackup && orgId) onRestore(askedBackup.operationId, asked, given);
            else if (askedBackup) onRestore(askedBackup.operationId, asked);
          }}
          {...(orgId && automationHeld !== undefined ? { held: automationHeld } : {})}
          title={
            askedBackup
              ? t('dataops.restoreConfirm.title', { org: orgName, date: takenAt(askedBackup, t) })
              : ''
          }
          description={askedBackup ? restoreSentence(askedBackup, options.includeChanged, t) : ''}
          confirmLabel={t('dataops.restoreConfirm.confirm', { org: orgName })}
        >
          {askedBackup && (
            <div className="flex flex-col gap-1" data-testid="restore-confirm-objects">
              <p>{t('dataops.restoreConfirm.objects')}</p>
              <ul className="list-disc pl-4">
                {askedBackup.objectResults.map((o) => (
                  <li key={o.objectApiName}>
                    {o.objectApiName}:{' '}
                    {t('common.recordCountFormatted', {
                      count: o.recordCount,
                      formatted: formatNumber(o.recordCount),
                    })}
                  </li>
                ))}
              </ul>
              {/* A restore of a partial backup leaves the rest of each object
                  as it is: said where the restore is asked. */}
              {isPartialBackup(askedBackup) && <p>{t('dataops.backupPartialLead')}</p>}
            </div>
          )}
          {/* How the restore writes, asked with it: a restore writes only
              what changed since the backup — a backup of 12 000 contacts,
              three of them changed, was written back whole — and a Sync run's
              backup is restored as removing the run gives its values back,
              leaving a record changed or deleted since unless asked. */}
          {askedBackup && (
            <div className="flex flex-col gap-2" data-testid="restore-confirm-options">
              {rewriteAllBox}
              {askedBackup.origin === 'sync' && (
                <label className="flex items-start gap-2 text-xs text-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={options.includeChanged}
                    onChange={(e) =>
                      setOptions((was) => ({ ...was, includeChanged: e.target.checked }))
                    }
                    data-testid={`restore-include-changed-${askedBackup.operationId}`}
                  />
                  <span>{t('dataops.restoreIncludeChanged')}</span>
                </label>
              )}
            </div>
          )}
          {askedBackup && orgId && (
            <DataOpsAutomation
              orgId={orgId}
              org={orgName}
              act="restore"
              objects={askedBackup.objectResults.map((o) => ({
                objectApiName: o.objectApiName,
                records: o.recordCount,
              }))}
              accord={accord}
              onAccordChange={setAccord}
              onHeld={setAutomationHeld}
            />
          )}
        </DangerConfirm>
      )}

      {/* A set's restore asks as a backup's does: the org, what each object
          gets back, what it costs, and what the org runs as it writes. */}
      {onRestoreSet && orgName && (
        <DangerConfirm
          open={askedSet !== undefined}
          variant="warning"
          onClose={closeQuestion}
          onConfirm={() => {
            const asked = askingSet;
            const rewriteAll = options.rewriteAll;
            const given = accord;
            closeQuestion();
            if (!askedSet || !asked) return;
            if (orgId) onRestoreSet(askedSet.setId, asked.slices, { rewriteAll }, given);
            else onRestoreSet(askedSet.setId, asked.slices, { rewriteAll });
          }}
          {...(orgId && automationHeld !== undefined ? { held: automationHeld } : {})}
          title={
            askedSet
              ? askingSet?.slices?.length === 1
                ? t('dataops.slices.set.confirmTitleSlice', {
                    index: formatNumber(askingSet.slices[0]),
                    org: orgName,
                    date:
                      formatStoredDate(askedSet.startedAt, (d) => d.toLocaleString(uiLocale())) ??
                      t('common.dateUnknown'),
                  })
                : t('dataops.slices.set.confirmTitleAll', {
                    org: orgName,
                    date:
                      formatStoredDate(askedSet.startedAt, (d) => d.toLocaleString(uiLocale())) ??
                      t('common.dateUnknown'),
                  })
              : ''
          }
          description={askedSet ? t('dataops.slices.set.confirmDescription') : ''}
          confirmLabel={t('dataops.restoreConfirm.confirm', { org: orgName })}
        >
          {askedSet && (
            <div className="flex flex-col gap-1" data-testid="restore-set-confirm-objects">
              <p>{t('dataops.restoreConfirm.objects')}</p>
              <ul className="list-disc pl-4">
                {askedObjects.map((o) => (
                  <li key={o.objectApiName}>
                    {o.objectApiName}:{' '}
                    {t('common.recordCountFormatted', {
                      count: o.records,
                      formatted: formatNumber(o.records),
                    })}
                  </li>
                ))}
              </ul>
              <p data-testid="restore-set-cost">
                {t('dataops.slices.set.cost', {
                  requests: formatNumber(2 * Math.ceil(askedRows / RESTORE_BATCH)),
                })}
              </p>
            </div>
          )}
          {askedSet && rewriteAllBox}
          {askedSet && orgId && (
            <DataOpsAutomation
              orgId={orgId}
              org={orgName}
              act="restore"
              objects={askedObjects}
              accord={accord}
              onAccordChange={setAccord}
              onHeld={setAutomationHeld}
            />
          )}
        </DangerConfirm>
      )}
    </div>
  );
};
