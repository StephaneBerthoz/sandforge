import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckpointIgnoreFieldsResponse, OrgCheckpoint } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { formatNumber } from '../../utils/formatters';
import { comparableFields, ignoredAfter, isIgnored } from './rewindPreviewFacts';

/** Fields listed at once; the filter reaches the others. */
const LISTED_FIELDS = 50;

/** Props for {@link StopComparingFields}. */
export interface StopComparingFieldsProps {
  /** The checkpoint whose compared fields change. */
  checkpoint: OrgCheckpoint;
  /**
   * The objects whose fields are offered: those whose records a rewind's
   * automation set again. Every object of the checkpoint when absent.
   */
  objects?: readonly string[];
  onClose: () => void;
  /**
   * Saved: the checkpoint as it is now kept, and the fields offered here that
   * it no longer compares.
   */
  onSaved: (checkpoint: OrgCheckpoint, ignored: string[]) => void;
}

/**
 * The fields a checkpoint stops comparing, chosen among the fields it holds:
 * one the org's automation sets again on every save — a last-touched date, a
 * score a flow recomputes — keeps every rewind partial, and a rewind neither
 * compares nor writes back a field the checkpoint leaves out. Unticking one
 * compares it again. The fields it already leaves out come first; the others
 * of the objects offered follow, filtered by name.
 */
export const StopComparingFields: React.FC<StopComparingFieldsProps> = ({
  checkpoint,
  objects,
  onClose,
  onSaved,
}) => {
  const { t } = useTranslation();
  const filterId = useId();
  const [filter, setFilter] = useState('');
  // Ordered once, as the dialog opens: a field ticked or unticked here stays
  // where it was, under the pointer.
  const shown = useMemo(() => {
    const offered = checkpoint.objects
      .filter((object) => objects === undefined || objects.includes(object.objectApiName))
      .flatMap(comparableFields);
    const already = offered.filter((field) => isIgnored(field, checkpoint.ignoredFields));
    return [...already, ...offered.filter((field) => !already.includes(field))];
  }, [checkpoint, objects]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(shown.filter((field) => isIgnored(field, checkpoint.ignoredFields))),
  );
  const saving = useBridgeMutation<CheckpointIgnoreFieldsResponse['payload']>(
    'checkpoint:ignore-fields',
  );

  const saved = saving.data?.checkpoint;
  const announceSaved = useLatestRef(() => {
    if (saved)
      onSaved(
        saved,
        shown.filter((field) => ticked.has(field)),
      );
  });
  useEffect(() => {
    if (saved) announceSaved.current();
  }, [saved, announceSaved]);

  const needle = filter.trim().toLowerCase();
  const matching = needle ? shown.filter((field) => field.toLowerCase().includes(needle)) : shown;
  const listed = matching.slice(0, LISTED_FIELDS);

  const toggle = (field: string, on: boolean): void => {
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  };
  const save = (): void => {
    saving.mutate({
      checkpointId: checkpoint.checkpointId,
      fields: ignoredAfter(checkpoint.ignoredFields, shown, ticked),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('checkpoint.stopComparing.title', { name: checkpoint.name })}
      description={t('checkpoint.stopComparing.intro')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            data-testid="checkpoint-stop-comparing-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving.loading}
            disabled={saving.loading}
            data-testid="checkpoint-stop-comparing-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs text-text-primary">
        {saving.error && (
          <ErrorBanner
            message={saving.error}
            code={saving.errorCode}
            data-testid="checkpoint-stop-comparing-error"
          />
        )}
        <Input
          id={filterId}
          type="search"
          label={t('checkpoint.stopComparing.filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          data-testid="checkpoint-stop-comparing-filter"
        />
        <ul
          className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-sm border border-subtle p-1"
          data-testid="checkpoint-stop-comparing-fields"
        >
          {listed.map((field) => (
            <li key={field}>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1">
                <input
                  type="checkbox"
                  checked={ticked.has(field)}
                  onChange={(event) => toggle(field, event.target.checked)}
                  data-testid={`checkpoint-stop-comparing-${field}`}
                />
                <span className="font-mono break-all">{field}</span>
              </label>
            </li>
          ))}
        </ul>
        {matching.length === 0 && (
          <p className="text-text-secondary">{t('checkpoint.stopComparing.noMatch')}</p>
        )}
        {matching.length > listed.length && (
          <p className="text-text-secondary" data-testid="checkpoint-stop-comparing-more">
            {t('checkpoint.take.moreObjects', {
              shown: formatNumber(listed.length),
              total: formatNumber(matching.length),
            })}
          </p>
        )}
        <p
          aria-live="polite"
          className="text-text-secondary"
          data-testid="checkpoint-stop-comparing-count"
        >
          {t('checkpoint.stopComparing.ticked', {
            count: ticked.size,
            formatted: formatNumber(ticked.size),
          })}
        </p>
      </div>
    </Dialog>
  );
};
