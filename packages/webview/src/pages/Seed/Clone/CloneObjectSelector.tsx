import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CloneObjectConfig } from '@sandforge/shared';
import { Input } from '../../../components/ui/Input';
import { Badge } from '../../../components/ui/Badge';
import { Skeleton } from '../../../components/ui/Skeleton';
import type { SourceObjectInfo } from './useClone';

/** Props for the CloneObjectSelector component. */
export interface CloneObjectSelectorProps {
  /** Objects available on the source org. */
  sourceObjects: SourceObjectInfo[];
  /** Currently selected objects with optional WHERE clauses. */
  selectedObjects: CloneObjectConfig[];
  /** Toggle an object's selection state. */
  onObjectToggle: (objectApiName: string) => void;
  /** Update the WHERE clause for an object. */
  onWhereClauseChange: (objectApiName: string, whereClause: string) => void;
  /** Whether objects are loading. */
  loading?: boolean;
}

/**
 * Searchable object selector with checkboxes and per-object
 * optional SOQL WHERE clause input. Shows a selected count badge.
 */
export const CloneObjectSelector: React.FC<CloneObjectSelectorProps> = ({
  sourceObjects,
  selectedObjects,
  onObjectToggle,
  onWhereClauseChange,
  loading = false,
}) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredObjects = useMemo(() => {
    if (!searchTerm.trim()) return sourceObjects;
    const lower = searchTerm.toLowerCase();
    return sourceObjects.filter(
      (obj) => obj.name.toLowerCase().includes(lower) || obj.label.toLowerCase().includes(lower),
    );
  }, [sourceObjects, searchTerm]);

  const selectedSet = useMemo(
    () => new Set(selectedObjects.map((o) => o.objectApiName)),
    [selectedObjects],
  );

  /** Get the WHERE clause for a specific object. */
  const getWhereClause = (objectApiName: string): string => {
    const obj = selectedObjects.find((o) => o.objectApiName === objectApiName);
    return obj?.whereClause ?? '';
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="clone-objects-loading">
        <Skeleton variant="text" width="40%" height="1em" />
        <Skeleton variant="rect" height="120px" />
        <Skeleton variant="text" width="60%" height="1em" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="clone-object-selector">
      {/* Header with selected count */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.clone.objectSelector.title')}
        </span>
        <Badge variant="info">
          {t('seed.clone.objectSelector.selected', { count: selectedObjects.length })}
        </Badge>
      </div>

      {/* Search input */}
      <Input
        placeholder={t('seed.clone.objectSelector.search')}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        data-testid="clone-object-search"
      />

      {/* Object list */}
      <div
        className="flex flex-col gap-1 max-h-[400px] overflow-y-auto"
        role="group"
        aria-label={t('seed.clone.objectSelector.title')}
        data-testid="clone-object-list"
      >
        {filteredObjects.map((obj) => {
          const isSelected = selectedSet.has(obj.name);
          return (
            <div key={obj.name} className="flex flex-col">
              <label
                className="flex items-center gap-[var(--sf-space-2)] px-[var(--sf-space-2)] py-[var(--sf-space-1)] rounded cursor-pointer hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] text-xs"
                data-testid={`clone-obj-${obj.name}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onObjectToggle(obj.name)}
                  className="accent-[var(--vscode-focusBorder,#007fd4)]"
                  data-testid={`clone-obj-check-${obj.name}`}
                />
                <span className="text-[var(--vscode-editor-foreground,#d4d4d4)] font-medium">
                  {obj.label}
                </span>
                <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                  {obj.name}
                </span>
              </label>

              {/* WHERE clause input -- shown only for selected objects */}
              {isSelected && (
                <div
                  className="ml-6 mt-1 mb-2 flex flex-col gap-1"
                  data-testid={`clone-where-section-${obj.name}`}
                >
                  <Input
                    placeholder={t('seed.clone.objectSelector.wherePlaceholder')}
                    value={getWhereClause(obj.name)}
                    onChange={(e) => onWhereClauseChange(obj.name, e.target.value)}
                    className="text-xs"
                    data-testid={`clone-where-input-${obj.name}`}
                  />
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('seed.clone.objectSelector.whereHint')}
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {filteredObjects.length === 0 && (
          <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('seed.noObjects')}
          </span>
        )}
      </div>
    </div>
  );
};
