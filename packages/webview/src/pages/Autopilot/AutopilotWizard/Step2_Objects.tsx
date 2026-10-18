import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTOPILOT_COUNTS_PER_REQUEST } from '@sandforge/shared';
import { cn } from '../../../theme';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import type { AutopilotObjectInfo } from './AutopilotWizard';
import { uiLocale } from '../../../utils/formatters';

/** Step2Objects component props. */
export interface Step2ObjectsProps {
  /** All available objects to select from */
  readonly availableObjects: AutopilotObjectInfo[];
  /** Currently selected object API names */
  readonly selectedObjects: string[];
  /** Whether all objects are selected */
  readonly selectAll: boolean;
  /** Toggle a single object */
  readonly onToggleObject: (apiName: string) => void;
  /** Toggle all objects */
  readonly onToggleAll: () => void;
  /**
   * Count the records of the objects the search shows whose count is not
   * known, at most {@link AUTOPILOT_COUNTS_PER_REQUEST} of them a click.
   * Absent, the step offers no such count.
   */
  readonly onCountShown?: (apiNames: string[]) => void;
  /** Whether a count is in flight: the count of the objects shown waits for it. */
  readonly counting?: boolean;
}

/** Step 2: Select root objects for autopilot seeding. */
export const Step2Objects: React.FC<Step2ObjectsProps> = ({
  availableObjects,
  selectedObjects,
  selectAll,
  onToggleObject,
  onToggleAll,
  onCountShown,
  counting = false,
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  const filteredObjects = useMemo(() => {
    if (!filter.trim()) return availableObjects;
    const lower = filter.toLowerCase();
    return availableObjects.filter(
      (o) => o.apiName.toLowerCase().includes(lower) || o.label.toLowerCase().includes(lower),
    );
  }, [availableObjects, filter]);

  /** The objects shown whose records no one has asked to count, and that can be picked. */
  const uncountedShown = useMemo(
    () =>
      filteredObjects
        .filter((o) => o.recordCount === undefined && !o.countAsked && !o.missingInTarget)
        .map((o) => o.apiName),
    [filteredObjects],
  );

  /** Format record count with locale-aware number formatting. */
  const formatCount = (count: number): string => count.toLocaleString(uiLocale());

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="step2-objects">
      <p className="text-sm text-text-secondary">{t('autopilot.step2.description')}</p>

      <div className="flex items-center gap-(--sf-space-3)">
        <Input
          placeholder={t('autopilot.step2.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="object-search-input"
        />
        <label className="flex items-center gap-2 text-sm text-text-primary whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={selectAll}
            onChange={onToggleAll}
            className="accent-(--sf-accent)"
            data-testid="select-all-checkbox"
          />
          {t('autopilot.step2.selectAll')}
        </label>
      </div>

      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto" data-testid="object-list">
        {filteredObjects.map((obj) => {
          const isSelected = selectedObjects.includes(obj.apiName);
          // Not in the target: shown, so the user knows why it cannot be
          // copied, and not to be picked.
          const missing = obj.missingInTarget === true;
          return (
            <label
              key={obj.apiName}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-sm transition-colors',
                missing
                  ? 'cursor-not-allowed'
                  : isSelected
                    ? 'cursor-pointer bg-status-info/10'
                    : 'cursor-pointer hover:bg-(--sf-bg-hover)',
              )}
              data-testid={`object-${obj.apiName}`}
            >
              <input
                type="checkbox"
                checked={isSelected && !missing}
                disabled={missing}
                onChange={() => onToggleObject(obj.apiName)}
                className="accent-(--sf-accent)"
              />
              <span className="text-sm text-text-primary flex-1">
                {obj.label}
                <span className="text-xs text-text-primary ml-1">({obj.apiName})</span>
                {missing && (
                  <span
                    className="text-xs text-status-warning ml-2"
                    data-testid={`object-${obj.apiName}-missing`}
                  >
                    {t('autopilot.step2.notInTarget')}
                  </span>
                )}
              </span>
              {/* Counted once picked, or asked for: listing the org counts nothing. */}
              {obj.recordCount !== undefined && (
                <span className="text-xs text-text-primary tabular-nums">
                  {t('common.recordCountFormatted', {
                    count: obj.recordCount,
                    formatted: formatCount(obj.recordCount),
                  })}
                </span>
              )}
            </label>
          );
        })}
        {filteredObjects.length === 0 && (
          <p className="text-sm text-text-secondary py-4 text-center">
            {t('autopilot.step2.noResults')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-(--sf-space-3)">
        <span className="text-xs text-text-secondary">
          {t('autopilot.step2.selectedCount', {
            count: selectedObjects.length,
            total: availableObjects.length,
          })}
        </span>
        {onCountShown && (
          <Button
            variant="secondary"
            size="sm"
            disabled={counting || uncountedShown.length === 0}
            onClick={() => onCountShown(uncountedShown)}
            data-testid="count-shown-button"
          >
            {t('autopilot.step2.countShown', {
              objects: Math.min(uncountedShown.length, AUTOPILOT_COUNTS_PER_REQUEST),
            })}
          </Button>
        )}
      </div>
    </div>
  );
};
