import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../theme';
import { Input } from '../../../components/ui/Input';
import type { AutopilotObjectInfo } from './AutopilotWizard';

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
}

/** Step 2: Select root objects for autopilot seeding. */
export const Step2Objects: React.FC<Step2ObjectsProps> = ({
  availableObjects,
  selectedObjects,
  selectAll,
  onToggleObject,
  onToggleAll,
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

  /** Format record count with locale-aware number formatting. */
  const formatCount = (count: number): string => count.toLocaleString();

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="step2-objects">
      <p className="text-sm text-text-secondary">{t('autopilot.step2.description')}</p>

      <div className="flex items-center gap-[var(--sf-space-3)]">
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
            className="accent-[var(--sf-accent)]"
            data-testid="select-all-checkbox"
          />
          {t('autopilot.step2.selectAll')}
        </label>
      </div>

      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto" data-testid="object-list">
        {filteredObjects.map((obj) => {
          const isSelected = selectedObjects.includes(obj.apiName);
          return (
            <label
              key={obj.apiName}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors',
                isSelected ? 'bg-[var(--sf-bg-active)]' : 'hover:bg-[var(--sf-bg-hover)]',
              )}
              data-testid={`object-${obj.apiName}`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleObject(obj.apiName)}
                className="accent-[var(--sf-accent)]"
              />
              <span className="text-sm text-text-primary flex-1">
                {obj.label}
                <span className="text-xs text-text-secondary ml-1">({obj.apiName})</span>
              </span>
              <span className="text-xs text-text-secondary tabular-nums">
                {formatCount(obj.recordCount)} {t('autopilot.step2.records')}
              </span>
            </label>
          );
        })}
        {filteredObjects.length === 0 && (
          <p className="text-sm text-text-secondary py-4 text-center">
            {t('autopilot.step2.noResults')}
          </p>
        )}
      </div>

      <div className="text-xs text-text-secondary">
        {t('autopilot.step2.selectedCount', {
          count: selectedObjects.length,
          total: availableObjects.length,
        })}
      </div>
    </div>
  );
};
