import React, { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackupSetSummary, SliceState, SliceSummary } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';
import { DeleteQuestion } from './DeleteQuestion';

/** The word for where a slice stands, in the interface language. */
const SLICE_STATE_KEYS: Record<SliceState, string> = {
  pending: 'dataops.slices.state.pending',
  snapshotted: 'dataops.slices.state.snapshotted',
  masking: 'dataops.slices.state.masking',
  masked: 'dataops.slices.state.masked',
  restored: 'dataops.slices.state.restored',
};

/** The word for where a set stands, and the badge it wears. */
const SET_STATE = {
  open: { key: 'dataops.slices.set.state.open', variant: 'warning' },
  done: { key: 'dataops.slices.set.state.done', variant: 'success' },
  abandoned: { key: 'dataops.slices.set.state.abandoned', variant: 'default' },
} as const;

/** A moment the extension stored, as the page writes dates. */
function dateOf(stored: string, unknown: string): string {
  return formatStoredDate(stored, (d) => d.toLocaleString(uiLocale())) ?? unknown;
}

/**
 * The slices of a set, one row each: the rows its backup holds, and of a
 * masking, what was masked, refused, and deleted from the org since its
 * backup, which nothing masks or puts back. A slice of rows created during
 * the run in a range already masked is marked late. Given `onRestore`, each
 * row offers to restore its slice alone.
 */
export const SliceTable: React.FC<{
  slices: readonly SliceSummary[];
  kind: 'masking' | 'backup';
  testId: string;
  onRestore?: (index: number) => void;
  /** Why no slice can be restored now, by the id of the sentence that says it. */
  restoreHeldBy?: string;
  restoreDisabled?: boolean;
}> = ({ slices, kind, testId, onRestore, restoreHeldBy, restoreDisabled = false }) => {
  const { t } = useTranslation();
  const masking = kind === 'masking';
  return (
    <table className="w-full text-xs text-text-primary" data-testid={testId}>
      <thead>
        <tr className="text-text-secondary">
          <th scope="col" className="text-left font-normal">
            {t('dataops.slices.table.slice')}
          </th>
          <th scope="col" className="text-left font-normal">
            {t('dataops.slices.table.object')}
          </th>
          <th scope="col" className="text-right font-normal">
            {t('dataops.slices.table.rows')}
          </th>
          {masking && (
            <>
              <th scope="col" className="text-right font-normal">
                {t('dataops.slices.table.masked')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dataops.slices.table.refused')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dataops.slices.table.deletedSince')}
              </th>
            </>
          )}
          <th scope="col" className="text-left font-normal">
            {t('dataops.slices.table.state')}
          </th>
          {onRestore && (
            <th scope="col" className="text-right font-normal">
              <span className="sr-only">{t('dataops.slices.table.actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {slices.map((slice) => (
          <tr
            key={`${slice.objectApiName}-${slice.index}`}
            data-testid={`${testId}-${slice.index}`}
          >
            <th scope="row" className="text-left font-normal tabular-nums">
              {formatNumber(slice.index)}
              {slice.late && ` (${t('dataops.slices.table.late')})`}
            </th>
            <td>{slice.objectApiName}</td>
            <td className="text-right tabular-nums">
              {formatNumber(slice.rows)}
              {slice.sizeUsed !== undefined &&
                ` ${t('dataops.slices.table.sizeUsed', { size: formatNumber(slice.sizeUsed) })}`}
            </td>
            {masking && (
              <>
                <td className="text-right tabular-nums">{formatNumber(slice.masked)}</td>
                <td className="text-right tabular-nums">{formatNumber(slice.refused)}</td>
                <td className="text-right tabular-nums">{formatNumber(slice.deletedSince)}</td>
              </>
            )}
            <td>
              {slice.state === 'restored' && slice.restoredAt
                ? t('dataops.slices.state.restoredOn', {
                    date: dateOf(slice.restoredAt, t('common.dateUnknown')),
                  })
                : t(SLICE_STATE_KEYS[slice.state])}
            </td>
            {onRestore && (
              <td className="text-right">
                {slice.state !== 'pending' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRestore(slice.index)}
                    disabled={restoreDisabled}
                    focusableWhenDisabled={restoreHeldBy !== undefined}
                    aria-describedby={restoreHeldBy}
                    data-testid={`${testId}-${slice.index}-restore`}
                  >
                    {t('dataops.slices.set.restoreSlice', { index: formatNumber(slice.index) })}
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** SliceSetRow component props. */
export interface SliceSetRowProps {
  set: BackupSetSummary;
  /** Whether its slices show, as a Restore of the masking run that took it opens it. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Restore every slice not restored yet, or the slices named. */
  onRestore?: (slices?: number[]) => void;
  /** Delete the set, every slice's backup with it, once asked to confirm. */
  onDelete?: () => void;
  /** A restore or a deletion of the org runs: nothing else is started. */
  busy?: boolean;
}

/**
 * One set of slices of the org, as Restore lists it: one row whatever its
 * slices, which a slice is restored and deleted with. It says what took it, a
 * masking run or a backup, when, where it stands, and what it holds; opened,
 * each slice, which restores alone. A masking set still open restores
 * nothing: its run, resumed, would mask again over what a restore puts back.
 */
export const SliceSetRow: React.FC<SliceSetRowProps> = ({
  set,
  expanded = false,
  onToggle,
  onRestore,
  onDelete,
  busy = false,
}) => {
  const { t } = useTranslation();
  const slicesId = useId();
  const heldId = useId();
  const questionId = useId();
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [askingDelete, setAskingDelete] = useState(false);
  const testId = `restore-set-${set.setId}`;
  const openRun = set.kind === 'masking' && set.state === 'open';
  const state = SET_STATE[set.state];
  const filters = Object.entries(set.wheres ?? {});
  const restorable = set.slices.some((s) => s.state !== 'pending');
  return (
    <div
      className="flex flex-col gap-2 rounded border border-subtle bg-surface-1 p-3"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-text-primary">
            {t(
              set.kind === 'masking'
                ? 'dataops.slices.set.kindMasking'
                : 'dataops.slices.set.kindBackup',
              { date: dateOf(set.startedAt, t('common.dateUnknown')) },
            )}
          </span>
          <span className="text-xs text-text-secondary" data-testid={`${testId}-summary`}>
            {t('dataops.slices.set.summary', {
              count: set.slices.length,
              formatted: formatNumber(set.slices.length),
              size: formatNumber(set.size),
              records: formatNumber(set.totalRecords),
            })}
          </span>
        </div>
        <Badge variant={state.variant} data-testid={`${testId}-state`}>
          {t(state.key)}
        </Badge>
      </div>
      {filters.length > 0 && (
        <p className="text-xs text-text-secondary" data-testid={`${testId}-filters`}>
          {t('dataops.slices.set.filtered', {
            filters: filters.map(([object, where]) => `${object}: ${where}`).join('; '),
          })}
        </p>
      )}
      {openRun && onRestore && (
        <p id={heldId} className="text-xs text-text-primary" data-testid={`${testId}-held`}>
          {t('dataops.slices.set.openHeld')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onToggle && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggle}
            aria-expanded={expanded}
            {...(expanded ? { 'aria-controls': slicesId } : {})}
            data-testid={`${testId}-toggle`}
          >
            {t(expanded ? 'dataops.slices.set.collapse' : 'dataops.slices.set.expand')}
          </Button>
        )}
        {onRestore && restorable && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => onRestore()}
            disabled={busy || openRun}
            focusableWhenDisabled={openRun}
            {...(openRun ? { 'aria-describedby': heldId } : {})}
            data-testid={`${testId}-all`}
          >
            {t('dataops.slices.set.restoreAll')}
          </Button>
        )}
        {onDelete && (
          <Button
            ref={deleteButton}
            variant="secondary"
            size="sm"
            onClick={() => setAskingDelete(true)}
            disabled={busy}
            focusableWhenDisabled
            data-testid={`${testId}-delete`}
          >
            {t('dataops.slices.set.delete')}
          </Button>
        )}
      </div>
      {onDelete && askingDelete && (
        <DeleteQuestion
          id={questionId}
          testId={`${testId}-delete`}
          question={t('dataops.slices.set.deleteConfirm')}
          confirmLabel={t('dataops.slices.set.delete')}
          onConfirm={() => {
            setAskingDelete(false);
            deleteButton.current?.focus();
            onDelete();
          }}
          onCancel={() => {
            setAskingDelete(false);
            deleteButton.current?.focus();
          }}
        />
      )}
      {expanded && (
        <div id={slicesId} className="overflow-x-auto">
          <SliceTable
            slices={set.slices}
            kind={set.kind}
            testId={`${testId}-slices`}
            {...(onRestore
              ? {
                  onRestore: (index: number) => onRestore([index]),
                  restoreDisabled: busy || openRun,
                  ...(openRun ? { restoreHeldBy: heldId } : {}),
                }
              : {})}
          />
        </div>
      )}
    </div>
  );
};
