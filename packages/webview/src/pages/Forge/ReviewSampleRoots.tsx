import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import {
  forgeSampleWindowBound,
  type ForgeSampleOptions,
  type ForgeSampleWindow,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { filterAllowed } from '../../utils/forgeRunControls';
import { uiLocale } from '../../utils/formatters';
import { cn } from '../../theme';

/** The last days a window is offered at, as a shortcut each. */
const LAST_DAYS = [30, 90, 365] as const;

/**
 * The describe types a stratum may be of, as the drawing admits them: a
 * picklist, a checkbox, a lookup — the record type and the owner among them.
 */
const STRATUM_TYPES: ReadonlySet<string> = new Set(['picklist', 'boolean', 'reference']);

/** The record type of every object that has one: the stratum offered as a box. */
const RECORD_TYPE = 'RecordTypeId';

/** How the inputs and lists of the block look, as Review → Controls' do. */
const INPUT_CLASS = cn(
  'rounded-sm px-2 py-1 text-xs',
  'bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)',
);

/** A field of an object, as `sync:describe-fields` lists the createable ones of each org. */
interface DescribedFields {
  objectApiName: string;
  sourceFields: Array<{ apiName: string; label: string; type: string }>;
}

/**
 * What else on Review asks for Which roots to be opened and handed the
 * keyboard: the notice of a draw refused, whose way out is there.
 */
interface SampleRootsAsk {
  asked: number;
  ask: () => void;
}

/** See {@link SampleRootsAsk}. */
export const useSampleRootsAsk = create<SampleRootsAsk>((set) => ({
  asked: 0,
  ask: () => set((state) => ({ asked: state.asked + 1 })),
}));

/** Open Which roots on Review, and bring it into view with the keyboard on it. */
export function openSampleRoots(): void {
  useSampleRootsAsk.getState().ask();
}

/** The day an instant of a window starts, as a date field shows it. */
function dayOf(instant: string | undefined): string {
  return instant?.slice(0, 10) ?? '';
}

/**
 * The last day an end of a window takes, as a date field shows it: the end
 * is left out, and a day's end is the next day at 00:00Z. An end within a
 * day, as the command line may set one, shows that day.
 */
function lastDayOf(instant: string | undefined): string {
  if (instant === undefined) return '';
  if (!instant.endsWith('T00:00:00Z')) return dayOf(instant);
  const time = Date.parse(instant);
  return Number.isFinite(time) ? new Date(time - 86_400_000).toISOString().slice(0, 10) : '';
}

/** The number of conditions that choose the roots: the window, each filter, each stratum. */
export function rootConditionsOf(sample: ForgeSampleOptions | undefined): number {
  return (
    (sample?.window ? 1 : 0) +
    Object.keys(sample?.rootWhere ?? {}).length +
    (sample?.strata ?? []).length
  );
}

/** Props for {@link ReviewSampleRoots}. */
export interface ReviewSampleRootsProps {
  /** The sample's options, as the config holds them. */
  sample: ForgeSampleOptions;
  /** Change the sample's options as `next` says. */
  change: (next: (options: ForgeSampleOptions) => ForgeSampleOptions) => void;
  /**
   * The objects whose roots may be chosen: those the run takes and draws,
   * neither left out nor copied whole. An object with no root of its own is
   * among them, and refused, with the way out, when the sample is drawn.
   */
  objects: readonly string[];
  sourceOrgId: string;
  targetOrgId: string;
}

/**
 * Review's Which roots: the roots of a sample — the records drawn at the top
 * of each story, accounts, leads, a case without an account — drawn among
 * those made or last modified in a window of dates, those of an object that
 * meet a condition, and by strata, the same share of each value of a field
 * of few values. What comes under a root or above it comes whatever its date
 * or values: unlike an object's filter in Review → Controls, nothing here
 * leaves a record out of the copy, nor a lookup empty.
 *
 * Folded, its summary says every root, or how many conditions choose them.
 * Opened from the notice of a draw refused, it takes the keyboard.
 */
export const ReviewSampleRoots: React.FC<ReviewSampleRootsProps> = ({
  sample,
  change,
  objects,
  sourceOrgId,
  targetOrgId,
}) => {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  const asked = useSampleRootsAsk((s) => s.asked);
  const seen = useRef(asked);
  const conditions = rootConditionsOf(sample);

  // Asked from the notice: opened, brought into view, the keyboard on it.
  useEffect(() => {
    if (asked === seen.current) return;
    seen.current = asked;
    setOpen(true);
    const summary = summaryRef.current;
    summary?.scrollIntoView?.({ block: 'nearest' });
    summary?.focus();
  }, [asked]);

  return (
    <details
      data-testid="review-sample-roots"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="text-xs"
    >
      <summary ref={summaryRef} className="cursor-pointer text-text-primary">
        {t('forgeRun.review.sample.roots.title')}{' '}
        <span data-testid="review-sample-roots-summary" className="text-text-secondary">
          {conditions === 0
            ? t('forgeRun.review.sample.roots.every')
            : t('forgeRun.review.sample.roots.conditions', {
                count: conditions,
                formatted: conditions.toLocaleString(uiLocale()),
              })}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 pl-1">
        <p className="text-text-secondary">{t('forgeRun.review.sample.roots.hint')}</p>
        <RootsWindow
          window={sample.window}
          change={(window) => change((o) => ({ ...o, window }))}
          idPrefix={id}
        />
        <RootsWhere
          rootWhere={sample.rootWhere ?? {}}
          objects={objects}
          change={(rootWhere) =>
            change((o) => ({
              ...o,
              rootWhere: Object.keys(rootWhere).length > 0 ? rootWhere : undefined,
            }))
          }
          idPrefix={id}
        />
        <RootsStrata
          strata={sample.strata ?? []}
          objects={objects}
          sourceOrgId={sourceOrgId}
          targetOrgId={targetOrgId}
          change={(strata) =>
            change((o) => ({ ...o, strata: strata.length > 0 ? strata : undefined }))
          }
          idPrefix={id}
        />
      </div>
    </details>
  );
};

/**
 * The window of dates the roots are drawn in, in UTC: made or last modified,
 * from a day, to a day taken whole, either left empty; or the last days,
 * counted back from when the sample is drawn. A start on or after the end is
 * refused where it is typed, and never set.
 */
const RootsWindow: React.FC<{
  window: ForgeSampleWindow | undefined;
  change: (window: ForgeSampleWindow | undefined) => void;
  idPrefix: string;
}> = ({ window, change, idPrefix }) => {
  const { t } = useTranslation();
  const [field, setField] = useState<ForgeSampleWindow['field']>(window?.field ?? 'CreatedDate');
  const [from, setFrom] = useState(dayOf(window?.from));
  const [to, setTo] = useState(lastDayOf(window?.to));
  const [refused, setRefused] = useState(false);
  // A window set elsewhere — a past run, a template — shows here.
  useEffect(() => {
    if (window) setField(window.field);
    setFrom(dayOf(window?.lastDays === undefined ? window?.from : undefined));
    setTo(lastDayOf(window?.to));
  }, [window]);
  const hintId = `${idPrefix}-window-hint`;
  const errorId = `${idPrefix}-window-error`;

  /** Set the window the two days give, unless its start is not before its end. */
  const takeDays = (fromDay: string, toDay: string): void => {
    const start = fromDay ? forgeSampleWindowBound(fromDay, false) : undefined;
    const end = toDay ? forgeSampleWindowBound(toDay, true) : undefined;
    // A day the field holds half typed sets nothing yet.
    if ((fromDay && !start) || (toDay && !end)) return;
    if (start !== undefined && end !== undefined && start >= end) {
      setRefused(true);
      return;
    }
    setRefused(false);
    change(
      start === undefined && end === undefined
        ? undefined
        : {
            field,
            ...(start !== undefined ? { from: start } : {}),
            ...(end !== undefined ? { to: end } : {}),
          },
    );
  };

  return (
    <fieldset data-testid="review-sample-window" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">
        {t('forgeRun.review.sample.roots.window.legend')}
      </legend>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-window-field`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.window.field')}
          </label>
          <select
            id={`${idPrefix}-window-field`}
            data-testid="review-sample-window-field"
            value={field}
            onChange={(e) => {
              const next: ForgeSampleWindow['field'] =
                e.target.value === 'LastModifiedDate' ? 'LastModifiedDate' : 'CreatedDate';
              setField(next);
              if (window) change({ ...window, field: next });
            }}
            className={INPUT_CLASS}
          >
            <option value="CreatedDate">{t('forgeRun.review.sample.roots.window.created')}</option>
            <option value="LastModifiedDate">
              {t('forgeRun.review.sample.roots.window.modified')}
            </option>
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-window-from`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.window.from')}
          </label>
          <input
            id={`${idPrefix}-window-from`}
            data-testid="review-sample-window-from"
            type="date"
            value={from}
            aria-describedby={hintId}
            onChange={(e) => {
              setFrom(e.target.value);
              takeDays(e.target.value, to);
            }}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-window-to`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.window.to')}
          </label>
          <input
            id={`${idPrefix}-window-to`}
            data-testid="review-sample-window-to"
            type="date"
            value={to}
            aria-invalid={refused}
            aria-describedby={refused ? `${hintId} ${errorId}` : hintId}
            onChange={(e) => {
              setTo(e.target.value);
              takeDays(from, e.target.value);
            }}
            className={cn(INPUT_CLASS, refused && 'border-status-error/60')}
          />
        </div>
      </div>
      {refused && (
        <p
          id={errorId}
          role="alert"
          data-testid="review-sample-window-refused"
          className="text-status-error"
        >
          {t('forgeRun.review.sample.roots.window.refused')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {LAST_DAYS.map((days) => (
          <Button
            key={days}
            variant="secondary"
            size="sm"
            data-testid={`review-sample-window-last-${days}`}
            aria-pressed={window?.lastDays === days}
            onClick={() => {
              setRefused(false);
              setFrom('');
              setTo('');
              change({ field, lastDays: days });
            }}
          >
            {t('forgeRun.review.sample.roots.window.lastDays', {
              count: days,
              days: days.toLocaleString(uiLocale()),
            })}
          </Button>
        ))}
        {window && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="review-sample-window-clear"
            onClick={() => {
              setRefused(false);
              setFrom('');
              setTo('');
              change(undefined);
            }}
          >
            {t('forgeRun.review.sample.roots.window.clear')}
          </Button>
        )}
      </div>
      {window?.lastDays !== undefined && (
        <p data-testid="review-sample-window-following" className="text-text-primary">
          {t('forgeRun.review.sample.roots.window.following', {
            count: window.lastDays,
            days: window.lastDays.toLocaleString(uiLocale()),
          })}
        </p>
      )}
      <p id={hintId} className="text-text-secondary">
        {t('forgeRun.review.sample.roots.window.hint')}
      </p>
    </fieldset>
  );
};

/**
 * The condition the roots of an object are drawn among, as a WHERE clause the
 * schema checks, one per object; and those set, each removable. One on an
 * object no longer drawn — left out, or copied whole — would refuse the run:
 * said, with its removal.
 */
const RootsWhere: React.FC<{
  rootWhere: Readonly<Record<string, string>>;
  objects: readonly string[];
  change: (rootWhere: Record<string, string>) => void;
  idPrefix: string;
}> = ({ rootWhere, objects, change, idPrefix }) => {
  const { t } = useTranslation();
  const [object, setObject] = useState('');
  const [where, setWhere] = useState('');
  const [invalid, setInvalid] = useState(false);
  const hintId = `${idPrefix}-where-hint`;
  const errorId = `${idPrefix}-where-error`;
  const drawn = new Set(objects);
  const set = Object.entries(rootWhere).sort(([a], [b]) => a.localeCompare(b));

  return (
    <fieldset data-testid="review-sample-where" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">
        {t('forgeRun.review.sample.roots.where.legend')}
      </legend>
      <p id={hintId} className="text-text-secondary">
        {t('forgeRun.review.sample.roots.where.hint')}
      </p>
      {set.length > 0 && (
        <ul className="flex flex-col gap-1">
          {set.map(([name, text]) => {
            const item = t('forgeRun.review.sample.roots.where.item', {
              object: name,
              where: text,
            });
            return (
              <li
                key={name}
                data-testid={`review-sample-where-${name}`}
                className="flex flex-col gap-0.5"
              >
                <div className="flex items-start justify-between gap-2 text-text-primary">
                  <span className="font-mono [overflow-wrap:anywhere]">{item}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`review-sample-where-remove-${name}`}
                    aria-label={t('forgeRun.review.sample.roots.removeLabel', { what: item })}
                    onClick={() => {
                      const next = { ...rootWhere };
                      delete next[name];
                      change(next);
                    }}
                  >
                    {t('forgeRun.review.sample.roots.remove')}
                  </Button>
                </div>
                {!drawn.has(name) && (
                  <p
                    data-testid={`review-sample-where-not-drawn-${name}`}
                    className="rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1 text-text-primary"
                  >
                    {t('forgeRun.review.sample.roots.where.notDrawn', { object: name })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (object === '') return;
          const text = where.trim();
          if (text !== '' && !filterAllowed(text)) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          const next = { ...rootWhere };
          if (text === '') delete next[object];
          else next[object] = text;
          change(next);
        }}
      >
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-where-object`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.where.object')}
          </label>
          <select
            id={`${idPrefix}-where-object`}
            data-testid="review-sample-where-object"
            value={object}
            onChange={(e) => {
              setObject(e.target.value);
              setWhere(rootWhere[e.target.value] ?? '');
              setInvalid(false);
            }}
            className={cn(INPUT_CLASS, 'self-start')}
          >
            <option value="">{t('forgeRun.review.sample.roots.pick')}</option>
            {objects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {object !== '' && (
          <>
            <label htmlFor={`${idPrefix}-where-text`} className="text-text-secondary">
              {t('forgeRun.review.sample.roots.where.label', { object })}
            </label>
            <textarea
              id={`${idPrefix}-where-text`}
              data-testid="review-sample-where-text"
              rows={2}
              maxLength={512}
              value={where}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
              onChange={(e) => {
                setWhere(e.target.value);
                setInvalid(false);
              }}
              className={cn(INPUT_CLASS, 'font-mono', invalid && 'border-status-error/40')}
            />
            {invalid && (
              <p
                id={errorId}
                role="alert"
                data-testid="review-sample-where-refused"
                className="text-status-error"
              >
                {t('forgeRun.review.sample.roots.where.refused')}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                data-testid="review-sample-where-apply"
              >
                {t('forgeRun.review.sample.roots.where.apply')}
              </Button>
            </div>
          </>
        )}
      </form>
    </fieldset>
  );
};

/**
 * The fields the roots are stratified by: the record type of every object
 * that has one, a box; and an object's field of few values, among those the
 * source describes of it — a picklist, a checkbox, a lookup —, one per
 * object. A field the source will not group by, or one that names the record
 * a root comes under, is refused when the sample is drawn, with the fields
 * it can take.
 */
const RootsStrata: React.FC<{
  strata: readonly string[];
  objects: readonly string[];
  sourceOrgId: string;
  targetOrgId: string;
  change: (strata: string[]) => void;
  idPrefix: string;
}> = ({ strata, objects, sourceOrgId, targetOrgId, change, idPrefix }) => {
  const { t } = useTranslation();
  const [object, setObject] = useState('');
  const [field, setField] = useState('');
  const fields = useBridgeMutation<DescribedFields>('sync:describe-fields', {
    responseType: 'sync:describe-fields:response',
  });
  const { mutate } = fields;
  useEffect(() => {
    if (object !== '') mutate({ sourceOrgId, targetOrgId, objectApiName: object });
  }, [mutate, sourceOrgId, targetOrgId, object]);
  const described = fields.data?.objectApiName === object ? fields.data : null;
  const offered = (described?.sourceFields ?? [])
    .filter((f) => STRATUM_TYPES.has(f.type))
    .map((f) => f.apiName)
    .sort((a, b) => a.localeCompare(b));
  const everyRecordType = strata.includes(RECORD_TYPE);
  /** An object's own stratum, `Object.Field`, of `name`. */
  const ofObject = (spec: string, name: string): boolean =>
    spec.toLowerCase().startsWith(`${name.toLowerCase()}.`);

  return (
    <fieldset data-testid="review-sample-strata" className="flex flex-col gap-1">
      <legend className="font-medium text-text-primary">
        {t('forgeRun.review.sample.roots.strata.legend')}
      </legend>
      <p className="text-text-secondary">{t('forgeRun.review.sample.roots.strata.hint')}</p>
      <label className="flex items-center gap-2 text-text-primary">
        <input
          type="checkbox"
          data-testid="review-sample-strata-record-type"
          checked={everyRecordType}
          onChange={(e) =>
            change(
              e.target.checked
                ? [...strata.filter((spec) => spec.includes('.')), RECORD_TYPE]
                : strata.filter((spec) => spec !== RECORD_TYPE),
            )
          }
        />
        <span>{t('forgeRun.review.sample.roots.strata.recordType')}</span>
      </label>
      {strata.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {strata.map((spec) => {
            const dot = spec.indexOf('.');
            const item =
              dot < 0
                ? t('forgeRun.review.sample.roots.strata.everyObject', { field: spec })
                : t('forgeRun.review.sample.roots.strata.item', {
                    object: spec.slice(0, dot),
                    field: spec.slice(dot + 1),
                  });
            return (
              <li
                key={spec}
                data-testid={`review-sample-stratum-${spec}`}
                className="flex items-center justify-between gap-2 text-text-primary"
              >
                <span>{item}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('forgeRun.review.sample.roots.removeLabel', { what: item })}
                  onClick={() => change(strata.filter((s) => s !== spec))}
                >
                  {t('forgeRun.review.sample.roots.remove')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (object === '' || field === '') return;
          // One field of an object: the one asked takes the place of another.
          change([...strata.filter((spec) => !ofObject(spec, object)), `${object}.${field}`]);
          setField('');
        }}
      >
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-stratum-object`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.where.object')}
          </label>
          <select
            id={`${idPrefix}-stratum-object`}
            data-testid="review-sample-stratum-object"
            value={object}
            onChange={(e) => {
              setObject(e.target.value);
              setField('');
            }}
            className={INPUT_CLASS}
          >
            <option value="">{t('forgeRun.review.sample.roots.pick')}</option>
            {objects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-stratum-field`} className="text-text-secondary">
            {t('forgeRun.review.sample.roots.strata.field')}
          </label>
          <select
            id={`${idPrefix}-stratum-field`}
            data-testid="review-sample-stratum-field"
            value={field}
            disabled={offered.length === 0}
            onChange={(e) => setField(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{t('forgeRun.review.sample.roots.pick')}</option>
            {offered.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          data-testid="review-sample-stratum-add"
          disabled={object === '' || field === ''}
        >
          {t('forgeRun.review.sample.roots.strata.add')}
        </Button>
      </form>
      {object !== '' && fields.loading && (
        <p
          role="status"
          data-testid="review-sample-stratum-reading"
          className="text-text-secondary"
        >
          {t('forgeRun.review.sample.roots.strata.reading', { object })}
        </p>
      )}
      {object !== '' && fields.error && (
        <p role="alert" data-testid="review-sample-stratum-error" className="text-status-error">
          {t('forgeRun.review.sample.roots.strata.error', { object, error: fields.error })}
        </p>
      )}
      {described && offered.length === 0 && (
        <p data-testid="review-sample-stratum-none" className="text-text-secondary">
          {t('forgeRun.review.sample.roots.strata.none', { object })}
        </p>
      )}
    </fieldset>
  );
};
