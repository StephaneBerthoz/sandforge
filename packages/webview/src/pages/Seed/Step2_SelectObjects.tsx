import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

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
  onSmartSuggest?: () => void;
}

/** Step 2 — Select objects to seed with smart dependency suggestion. */
export const Step2SelectObjects: React.FC<Step2SelectObjectsProps> = ({
  availableObjects,
  selectedObjects,
  onToggle,
  onSmartSuggest,
}) => {
  const { t } = useTranslation();

  /** O(1) lookup set built from selectedObjects array. */
  const selectedSet = React.useMemo(() => new Set(selectedObjects), [selectedObjects]);

  return (
    <div className="flex flex-col gap-3" data-testid="step-select-objects">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          {t('seed.selectObjectsDesc')}
        </p>
        {onSmartSuggest && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onSmartSuggest}
            data-testid="smart-suggest-btn"
          >
            {t('seed.smartSuggest')}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {availableObjects.map((obj) => {
          const isSelected = selectedSet.has(obj.apiName);
          return (
            <button
              key={obj.apiName}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded text-left text-xs',
                'border border-[var(--vscode-panel-border,#3c3c3c)]',
                'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]',
                isSelected &&
                  'border-[var(--vscode-focusBorder,#007fd4)] bg-[var(--vscode-list-hoverBackground,#2a2d2e)]',
              )}
              onClick={() => onToggle(obj.apiName)}
              role="checkbox"
              aria-checked={isSelected}
              data-testid={`obj-${obj.apiName}`}
            >
              <span
                className={cn(
                  'w-4 h-4 rounded border flex items-center justify-center text-[10px]',
                  isSelected
                    ? 'bg-[var(--vscode-focusBorder,#007fd4)] border-[var(--vscode-focusBorder,#007fd4)] text-white'
                    : 'border-[var(--vscode-input-border,#3c3c3c)]',
                )}
              >
                {isSelected ? '\u2713' : ''}
              </span>
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)] flex-1">
                {obj.label}
              </span>
              <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                {obj.apiName}
              </span>
              {obj.dependencies.length > 0 && (
                <Badge variant="default">
                  {obj.dependencies.length} {t('seed.dependencies').toLowerCase()}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {availableObjects.length === 0 && (
        <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-4">
          {t('seed.noObjects')}
        </p>
      )}
    </div>
  );
};
