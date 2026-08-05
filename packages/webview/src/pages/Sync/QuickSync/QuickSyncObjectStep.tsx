import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SmartObjectSuggestion, RelationshipSuggestion } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';

/** Props for the QuickSyncObjectStep component. */
export interface QuickSyncObjectStepProps {
  /** Objects explicitly selected by the user. */
  selectedObjects: string[];
  /** Auto-detected parent objects. */
  parentObjects: string[];
  /** Source org identifier for fetching suggestions. */
  sourceOrgId: string;
  /** Callback to add an object. */
  onAddObject: (apiName: string) => void;
  /** Callback to remove an object. */
  onRemoveObject: (apiName: string) => void;
  /** Callback to add a parent dependency object. */
  onAddParentObject: (apiName: string) => void;
  /** Callback to proceed to next step. */
  onNext: () => void;
  /** Whether the Next button should be enabled. */
  canGoNext: boolean;
  /** Callback to go back to previous step. */
  onBack: () => void;
}

/** Relationship banner shown when a parent dependency is detected. */
interface RelationshipBanner {
  childObject: string;
  parentObject: string;
}

/**
 * Quick Sync Screen 2: Object selection with smart suggestions.
 *
 * Shows suggested objects as clickable chips, a searchable input to add
 * any object, and relationship detection notifications.
 */
export const QuickSyncObjectStep: React.FC<QuickSyncObjectStepProps> = ({
  selectedObjects,
  parentObjects,
  sourceOrgId,
  onAddObject,
  onRemoveObject,
  onAddParentObject,
  onNext,
  canGoNext,
  onBack,
}) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [relationshipBanner, setRelationshipBanner] = useState<RelationshipBanner | null>(null);

  // Fetch smart object suggestions (handler payload: { orgId, alreadySelected })
  const suggestionsQuery = useBridgeQuery<{ suggestions: SmartObjectSuggestion[] }>(
    'quicksync:suggest-objects',
    { orgId: sourceOrgId, alreadySelected: selectedObjects },
    { skip: !sourceOrgId },
  );

  // Detect relationships mutation (handler payload: { orgId, objectApiName, alreadySelected })
  const detectRelationships = useBridgeMutation<{ suggestions: RelationshipSuggestion[] }>(
    'quicksync:detect-relationships',
  );

  const suggestions = useMemo(
    () => suggestionsQuery.data?.suggestions ?? [],
    [suggestionsQuery.data],
  );

  // Available objects from suggestions for the search dropdown
  const availableForSearch = useMemo(() => {
    return suggestions
      .filter((s) => s.isAvailable && !selectedObjects.includes(s.objectApiName))
      .map((s) => s.objectApiName);
  }, [suggestions, selectedObjects]);

  const filteredObjects = useMemo(() => {
    if (!searchTerm) return availableForSearch;
    const lower = searchTerm.toLowerCase();
    return availableForSearch.filter((name) => name.toLowerCase().includes(lower));
  }, [availableForSearch, searchTerm]);

  // Trigger relationship detection when objects change
  const handleAddObject = useCallback(
    (apiName: string) => {
      onAddObject(apiName);
      detectRelationships.mutate({
        orgId: sourceOrgId,
        objectApiName: apiName,
        alreadySelected: [...selectedObjects, apiName],
      });
    },
    [onAddObject, detectRelationships, sourceOrgId, selectedObjects],
  );

  // Show relationship banner when detection returns results
  useEffect(() => {
    const detected = detectRelationships.data?.suggestions;
    if (detected && detected.length > 0) {
      const suggestion = detected[0];
      if (
        !selectedObjects.includes(suggestion.parentObject) &&
        !parentObjects.includes(suggestion.parentObject)
      ) {
        setRelationshipBanner({
          childObject: suggestion.childObject,
          parentObject: suggestion.parentObject,
        });
      }
    }
  }, [detectRelationships.data, selectedObjects, parentObjects]);

  const handleAddParent = useCallback(() => {
    if (relationshipBanner) {
      onAddParentObject(relationshipBanner.parentObject);
      setRelationshipBanner(null);
    }
  }, [relationshipBanner, onAddParentObject]);

  const handleDismissBanner = useCallback(() => {
    setRelationshipBanner(null);
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="quick-sync-object-step">
      <p className="text-xs text-text-secondary">{t('quickSync.selectObjects')}</p>

      {/* Suggested objects chips */}
      <div data-testid="quick-sync-suggestions">
        <p className="text-xs font-medium text-text-primary mb-2">
          {t('quickSync.suggestedObjects')}
        </p>
        <div className="flex flex-wrap gap-2">
          {suggestions.slice(0, 5).map((s) => {
            const isSelected = selectedObjects.includes(s.objectApiName);
            return (
              <button
                key={s.objectApiName}
                type="button"
                className="focus:outline-none"
                onClick={() => {
                  if (!isSelected && s.isAvailable) {
                    handleAddObject(s.objectApiName);
                  }
                }}
                disabled={!s.isAvailable}
                data-testid={`suggestion-chip-${s.objectApiName}`}
              >
                <Badge
                  variant={isSelected ? 'info' : s.isAvailable ? 'default' : 'default'}
                  className={`cursor-pointer ${!s.isAvailable ? 'opacity-40' : ''} ${isSelected ? '' : 'opacity-80 hover:opacity-100'}`}
                >
                  {s.label}
                </Badge>
              </button>
            );
          })}
        </div>
      </div>

      {/* Relationship detection banner */}
      {relationshipBanner && (
        <div
          className="flex items-center gap-3 p-3 rounded-lg bg-[var(--sf-info-bg)] border border-[var(--sf-info-border)]"
          data-testid="relationship-banner"
        >
          <span className="codicon codicon-info text-[var(--sf-info)]" aria-hidden="true" />
          <span className="text-xs flex-1 text-text-primary">
            {t('quickSync.addParent', {
              parent: relationshipBanner.parentObject,
              child: relationshipBanner.childObject,
            })}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={handleAddParent}
            data-testid="relationship-add-btn"
          >
            {t('quickSync.add')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismissBanner}
            data-testid="relationship-dismiss-btn"
          >
            {t('quickSync.dismiss')}
          </Button>
        </div>
      )}

      {/* Search input */}
      <div>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('quickSync.searchObjects')}
          className="w-full px-2 py-1.5 text-sm rounded bg-[var(--sf-bg-input)] text-[var(--sf-text-input)] border border-[var(--sf-border-input)] focus:outline-none focus:border-[var(--sf-accent)]"
          data-testid="quick-sync-object-search"
        />
        {searchTerm && filteredObjects.length > 0 && (
          <div
            className="mt-1 max-h-32 overflow-y-auto rounded border border-[var(--sf-border)] bg-[var(--sf-bg-dropdown)]"
            data-testid="quick-sync-search-results"
          >
            {filteredObjects.map((name) => (
              <button
                key={name}
                type="button"
                className="w-full text-left px-2 py-1 text-xs text-text-primary hover:bg-[var(--sf-bg-hover)] focus:outline-none"
                onClick={() => {
                  handleAddObject(name);
                  setSearchTerm('');
                }}
                data-testid={`search-result-${name}`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected objects */}
      <div data-testid="quick-sync-selected-objects">
        {selectedObjects.length === 0 ? (
          <p className="text-xs text-text-secondary italic">{t('quickSync.noObjectsSelected')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selectedObjects.map((name) => {
              const isParent = parentObjects.includes(name);
              return (
                <div key={name} className="flex items-center gap-1">
                  <Badge variant={isParent ? 'warning' : 'info'}>
                    {name}
                    {isParent && (
                      <span className="ml-1 text-[8px] opacity-75">
                        ({t('quickSync.parentDependency')})
                      </span>
                    )}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => onRemoveObject(name)}
                    className="codicon codicon-close text-[10px] text-text-secondary hover:text-[var(--sf-error)] focus:outline-none"
                    aria-label={`Remove ${name}`}
                    data-testid={`remove-object-${name}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} data-testid="quick-sync-object-back">
          {t('quickSync.back')}
        </Button>
        <Button
          variant="primary"
          onClick={onNext}
          disabled={!canGoNext}
          data-testid="quick-sync-object-next"
        >
          {t('quickSync.next')}
        </Button>
      </div>
    </div>
  );
};
