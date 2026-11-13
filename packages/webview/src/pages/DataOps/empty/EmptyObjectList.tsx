import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/Input';
import { formatNumber } from '../../../utils/formatters';

/** Objects listed at once; the filter reaches the others. */
export const LISTED_OBJECTS = 50;

/** Props for {@link EmptyObjectList}. */
export interface EmptyObjectListProps {
  /** The objects offered, by API name. */
  objects: readonly string[];
  /** Those ticked, in the order they were ticked. */
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** What the objects are ticked for, as the fieldset's legend. */
  legend: string;
  /** What is said of the objects ticked: the count, in the section's words. */
  tickedLine: (count: number) => string;
  /** Prefix of the test ids: `empty-pick` or `empty-exclude`. */
  testIdPrefix: string;
}

/**
 * Objects ticked by checkbox, with a filter over the list: the objects an
 * emptying picks among, or those it leaves out of the whole org. The list
 * is the extension's — every object people work in that the user may
 * delete — never the page's own guess.
 */
export const EmptyObjectList: React.FC<EmptyObjectListProps> = ({
  objects,
  selected,
  onChange,
  legend,
  tickedLine,
  testIdPrefix,
}) => {
  const { t } = useTranslation();
  const filterId = useId();
  const [filter, setFilter] = useState('');
  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? objects.filter((name) => name.toLowerCase().includes(needle)) : objects;
  }, [objects, filter]);
  const listed = matching.slice(0, LISTED_OBJECTS);
  const ticked = new Set(selected);

  const toggle = (name: string): void => {
    onChange(ticked.has(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  };

  return (
    <fieldset className="flex flex-col gap-2" data-testid={testIdPrefix}>
      <legend className="mb-1 text-xs font-medium text-text-primary">{legend}</legend>
      <div className="max-w-xs">
        <Input
          id={filterId}
          type="search"
          label={t('dataopsEmpty.list.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid={`${testIdPrefix}-filter`}
        />
      </div>
      <ul
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-sm border border-(--sf-border) p-1"
        data-testid={`${testIdPrefix}-list`}
      >
        {listed.map((name) => (
          <li key={name}>
            <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-(--sf-bg-hover)">
              <input
                type="checkbox"
                checked={ticked.has(name)}
                onChange={() => toggle(name)}
                data-testid={`${testIdPrefix}-option-${name}`}
              />
              {/* Primary, not secondary: the row's hover fill takes secondary
                  text under AA on the dark default theme. */}
              <span className="font-mono text-text-primary">{name}</span>
            </label>
          </li>
        ))}
      </ul>
      {matching.length === 0 && (
        <p className="text-xs text-text-secondary">{t('dataopsEmpty.list.noMatch')}</p>
      )}
      {matching.length > listed.length && (
        <p className="text-xs text-text-secondary" data-testid={`${testIdPrefix}-more`}>
          {t('dataopsEmpty.list.more', {
            shown: formatNumber(listed.length),
            total: formatNumber(matching.length),
          })}
        </p>
      )}
      <p
        aria-live="polite"
        className="text-xs text-text-secondary"
        data-testid={`${testIdPrefix}-ticked`}
      >
        {tickedLine(selected.length)}
        {selected.length > 0 && `: ${selected.join(', ')}`}
      </p>
    </fieldset>
  );
};
