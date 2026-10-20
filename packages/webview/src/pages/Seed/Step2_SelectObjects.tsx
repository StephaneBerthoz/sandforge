import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { VirtualList } from '../../components/ui/VirtualList';
import { objectsToList, parentSuggestions } from './seedObjectChoices';

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

/**
 * Step 2 — Select the objects to seed: a search, the objects an empty org is
 * seeded with first pinned at the top, every other one under them, and the
 * parents of the objects ticked offered in one click (a contact's account).
 */
export const Step2SelectObjects: React.FC<Step2SelectObjectsProps> = ({
  availableObjects,
  selectedObjects,
  onToggle,
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  /** O(1) lookup set built from selectedObjects array. */
  const selectedSet = useMemo(() => new Set(selectedObjects), [selectedObjects]);
  const { common, others } = useMemo(
    () => objectsToList(availableObjects, search),
    [availableObjects, search],
  );
  const suggestions = useMemo(
    () => parentSuggestions(selectedObjects, new Set(availableObjects.map((o) => o.apiName))),
    [selectedObjects, availableObjects],
  );

  const renderObject = (obj: SeedObjectInfo): React.ReactNode => {
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
          {isSelected ? '✓' : ''}
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
  };

  return (
    <div className="flex flex-col gap-3" data-testid="step-select-objects">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-secondary">{t('seed.selectObjectsDesc')}</p>
      </div>

      {availableObjects.length > 0 && (
        <>
          <Input
            type="search"
            placeholder={t('seed.objectSearch')}
            aria-label={t('seed.objectSearch')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="seed-object-search"
          />

          {common.length > 0 && (
            <div className="flex flex-col" data-testid="seed-common-objects">
              <span className="text-[10px] font-medium text-text-secondary mb-1">
                {t('seed.commonObjects')}
              </span>
              {common.map((obj) => (
                <React.Fragment key={obj.apiName}>{renderObject(obj)}</React.Fragment>
              ))}
            </div>
          )}

          {others.length > 0 && (
            <div className="flex flex-col" data-testid="seed-other-objects">
              {common.length > 0 && (
                <span className="text-[10px] font-medium text-text-secondary mb-1">
                  {t('seed.otherObjects')}
                </span>
              )}
              <VirtualList
                items={others}
                renderItem={renderObject}
                keyExtractor={(obj) => obj.apiName}
                estimatedItemHeight={38}
                maxHeight="16rem"
                overscan={5}
              />
            </div>
          )}

          {common.length === 0 && others.length === 0 && (
            <p className="text-xs text-center text-text-secondary py-4">{t('seed.noObjects')}</p>
          )}

          {suggestions.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="seed-parent-suggestions">
              {suggestions.map(({ child, parent }) => (
                <div
                  key={parent}
                  className="flex flex-wrap items-center gap-2 text-xs text-text-primary"
                  data-testid={`seed-parent-suggestion-${parent}`}
                >
                  <span>{t('seed.parentSuggestion', { child, parent })}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onToggle(parent)}
                    data-testid={`seed-add-parent-${parent}`}
                  >
                    {t('seed.addParent', { parent })}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {availableObjects.length === 0 && (
        <p className="text-xs text-center text-text-secondary py-4">{t('seed.noObjects')}</p>
      )}
    </div>
  );
};
