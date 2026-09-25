import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { VirtualList } from '../../components/ui/VirtualList';

/** Object info for selection. */
export interface SeedObjectInfo {
  apiName: string;
  label: string;
  recordCount: number;
  dependencies: string[];
}

/** Step2 props. */
export interface Step2SelectObjectsProps {
  availableObjects: SeedObjectInfo[];
  selectedObjects: string[];
  onToggle: (apiName: string) => void;
}

/** Step 2 — Select the objects to seed. */
export const Step2SelectObjects: React.FC<Step2SelectObjectsProps> = ({
  availableObjects,
  selectedObjects,
  onToggle,
}) => {
  const { t } = useTranslation();

  /** O(1) lookup set built from selectedObjects array. */
  const selectedSet = React.useMemo(() => new Set(selectedObjects), [selectedObjects]);

  return (
    <div className="flex flex-col gap-3" data-testid="step-select-objects">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-secondary">{t('seed.selectObjectsDesc')}</p>
      </div>

      {availableObjects.length > 0 && (
        <VirtualList
          items={availableObjects}
          renderItem={(obj) => {
            const isSelected = selectedSet.has(obj.apiName);
            return (
              <button
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-sm text-left text-xs w-full mb-1',
                  'border border-(--sf-border)',
                  'hover:bg-(--sf-bg-hover)',
                  isSelected && 'border-(--sf-accent) bg-(--sf-bg-hover)',
                )}
                onClick={() => onToggle(obj.apiName)}
                role="checkbox"
                aria-checked={isSelected}
                data-testid={`obj-${obj.apiName}`}
              >
                <span
                  className={cn(
                    'w-4 h-4 rounded-sm border flex items-center justify-center text-[10px]',
                    isSelected
                      ? 'bg-(--sf-button-bg) border-(--sf-button-bg) text-(--sf-button-fg)'
                      : 'border-(--sf-border-input)',
                  )}
                >
                  {isSelected ? '\u2713' : ''}
                </span>
                <span className="text-text-primary flex-1">{obj.label}</span>
                <span className="text-text-primary">{obj.apiName}</span>
                {obj.dependencies.length > 0 && (
                  <Badge variant="default">
                    {t('common.dependencyCount', { count: obj.dependencies.length })}
                  </Badge>
                )}
              </button>
            );
          }}
          keyExtractor={(obj) => obj.apiName}
          estimatedItemHeight={38}
          maxHeight="16rem"
          overscan={5}
        />
      )}

      {availableObjects.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-4">{t('seed.noObjects')}</p>
      )}
    </div>
  );
};
