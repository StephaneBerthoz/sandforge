import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';

/** Objects listed at once; the filter reaches the others. */
export const LISTED_OBJECTS = 50;

/** An object of the org, as `seed:describe-global` lists it. */
interface OrgObject {
  apiName: string;
  label: string;
}

/** Props for {@link ObjectPicker}. */
export interface ObjectPickerProps {
  /** The org whose objects are offered. */
  orgId: string;
  /** The objects picked, in the order they were picked. */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** The most that can be picked. */
  max: number;
  /** What the objects are picked for, as the fieldset's legend. */
  legend: string;
  /** Prefix of the test ids, one per tab: `quality`, `compliance`, `cleanup`. */
  testIdPrefix: string;
}

/**
 * The objects of an org a DataOps tab reads, picked by checkbox up to a bound,
 * with a filter over the list. The list is the one Seed offers — the org's
 * objects a record can be created in, which is where people type the data
 * these tabs look at.
 */
export const ObjectPicker: React.FC<ObjectPickerProps> = ({
  orgId,
  selected,
  onChange,
  max,
  legend,
  testIdPrefix,
}) => {
  const { t } = useTranslation();
  const filterId = useId();
  const [filter, setFilter] = useState('');

  const objectsQuery = useBridgeQuery<{ objects: OrgObject[] }>(
    'seed:describe-global',
    { orgId },
    { responseType: 'seed:describe-global:response', errorType: 'seed:error' },
  );

  const objects = useMemo(() => objectsQuery.data?.objects ?? [], [objectsQuery.data]);
  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle
      ? objects.filter(
          (o) => o.label.toLowerCase().includes(needle) || o.apiName.toLowerCase().includes(needle),
        )
      : objects;
  }, [objects, filter]);
  const listed = matching.slice(0, LISTED_OBJECTS);
  const full = selected.length >= max;

  const toggle = (apiName: string): void => {
    onChange(
      selected.includes(apiName) ? selected.filter((n) => n !== apiName) : [...selected, apiName],
    );
  };

  return (
    <fieldset className="flex flex-col gap-2" data-testid={`${testIdPrefix}-objects`}>
      <legend className="mb-1 text-xs font-medium text-text-primary">{legend}</legend>
      {objectsQuery.error && (
        <ErrorBanner message={objectsQuery.error} data-testid={`${testIdPrefix}-objects-error`} />
      )}
      {objectsQuery.loading && (
        <p role="status" className="text-xs text-text-secondary">
          {t('dataops.objectPicker.loading')}
        </p>
      )}
      {objects.length > 0 && (
        <>
          <div className="max-w-xs">
            <Input
              id={filterId}
              type="search"
              label={t('dataops.objectPicker.filter')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid={`${testIdPrefix}-object-filter`}
            />
          </div>
          <ul
            className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded border border-[var(--sf-border)] p-1"
            data-testid={`${testIdPrefix}-object-list`}
          >
            {listed.map((o) => {
              const checked = selected.includes(o.apiName);
              return (
                <li key={o.apiName}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--sf-bg-hover)]">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={() => toggle(o.apiName)}
                      data-testid={`${testIdPrefix}-object-option-${o.apiName}`}
                    />
                    <span className="flex-1 text-text-primary">{o.label}</span>
                    {/* Primary, not secondary: the row's hover fill takes
                        secondary text under AA on the dark default theme. */}
                    {o.label !== o.apiName && (
                      <span className="font-mono text-text-primary">{o.apiName}</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {matching.length === 0 && (
            <p className="text-xs text-text-secondary">{t('dataops.objectPicker.noMatch')}</p>
          )}
          {matching.length > listed.length && (
            <p className="text-xs text-text-secondary" data-testid={`${testIdPrefix}-more-objects`}>
              {t('dataops.objectPicker.more', { shown: listed.length, total: matching.length })}
            </p>
          )}
        </>
      )}
      <p
        aria-live="polite"
        className="text-xs text-text-secondary"
        data-testid={`${testIdPrefix}-selected`}
      >
        {t('dataops.objectPicker.selected', { part: selected.length, max })}
        {selected.length > 0 && `: ${selected.join(', ')}`}
      </p>
    </fieldset>
  );
};
