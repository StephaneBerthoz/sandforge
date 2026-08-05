import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldMapping, MappingType } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

/** Field info for mapping. */
export interface FieldInfo {
  apiName: string;
  label: string;
  type: string;
}

/** Auto-map suggestion with confidence score. */
export interface AutoMapSuggestionUI {
  sourceField: string;
  targetField: string;
  confidence: number;
  reason: string;
}

/** FieldMappingCanvas component props. */
export interface FieldMappingCanvasProps {
  sourceFields: FieldInfo[];
  targetFields: FieldInfo[];
  mappings: FieldMapping[];
  onAddMapping: (sourceField: string, targetField: string) => void;
  onRemoveMapping: (index: number) => void;
  onChangeMappingType: (index: number, type: MappingType) => void;
  onAutoMap?: () => void;
  /** Auto-map suggestions to display as preview. */
  autoMapSuggestions?: AutoMapSuggestionUI[];
  className?: string;
}

const MAPPING_TYPES: MappingType[] = [
  'direct',
  'rename',
  'transform',
  'constant',
  'formula',
  'exclude',
  'add_on',
];

/** Visual field mapping canvas for source-to-target mapping. */
export const FieldMappingCanvas: React.FC<FieldMappingCanvasProps> = ({
  sourceFields,
  targetFields,
  mappings,
  onAddMapping,
  onRemoveMapping,
  onChangeMappingType,
  onAutoMap,
  autoMapSuggestions = [],
  className,
}) => {
  const { t } = useTranslation();
  const [pendingSource, setPendingSource] = React.useState('');
  const [pendingTarget, setPendingTarget] = React.useState('');

  const mappedSourceFields = new Set(mappings.map((m) => m.sourceField));
  const mappedTargetFields = new Set(mappings.map((m) => m.targetField));

  const sourceOptions = sourceFields
    .filter((f) => !mappedSourceFields.has(f.apiName))
    .map((f) => ({ value: f.apiName, label: `${f.label} (${f.apiName})` }));
  const targetOptions = targetFields
    .filter((f) => !mappedTargetFields.has(f.apiName))
    .map((f) => ({ value: f.apiName, label: `${f.label} (${f.apiName})` }));
  const typeOptions = MAPPING_TYPES.map((mt) => ({
    value: mt,
    label: t(`sync.mappingTypes.${mt}`),
  }));

  const handleAdd = () => {
    if (pendingSource && pendingTarget) {
      onAddMapping(pendingSource, pendingTarget);
      setPendingSource('');
      setPendingTarget('');
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="field-mapping-canvas">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--sf-text-primary)]">
          {t('sync.fieldMapping')} ({mappings.length})
        </span>
        {onAutoMap && (
          <Button variant="secondary" size="sm" onClick={onAutoMap} data-testid="auto-map-btn">
            {t('sync.autoMap')}
          </Button>
        )}
      </div>

      {/* Existing mappings */}
      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
        {mappings.map((m, i) => (
          <div
            key={i}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded text-xs',
              'border border-[var(--sf-border)]',
            )}
            data-testid={`mapping-${i}`}
          >
            <span className="text-[var(--sf-text-primary)] w-32 truncate">{m.sourceField}</span>
            <Badge variant="default">{'\u2192'}</Badge>
            <span className="text-[var(--sf-text-primary)] w-32 truncate">{m.targetField}</span>
            <Select
              options={typeOptions}
              value={m.type}
              onChange={(e) => onChangeMappingType(i, e.target.value as MappingType)}
              className="w-28"
            />
            <button
              className="text-[var(--sf-error)] hover:opacity-70 px-1"
              onClick={() => onRemoveMapping(i)}
              data-testid={`remove-mapping-${i}`}
            >
              x
            </button>
          </div>
        ))}
      </div>

      {mappings.length === 0 && autoMapSuggestions.length === 0 && (
        <p className="text-xs text-center text-[var(--sf-text-secondary)] py-2">
          {t('sync.unmapped')}
        </p>
      )}

      {/* Auto-map suggestions preview */}
      {autoMapSuggestions.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="auto-map-suggestions">
          <span className="text-[10px] font-medium text-[var(--sf-text-muted,#868686)]">
            {t('sync.suggestedMappings', 'Suggested Mappings')} ({autoMapSuggestions.length})
          </span>
          {autoMapSuggestions.map((s, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-2 px-2 py-1 rounded text-xs',
                'border border-dashed border-[var(--sf-info,#3B82F6)]',
                'bg-[var(--sf-info,#3B82F6)]',
                'bg-opacity-5',
              )}
              data-testid={`suggestion-${i}`}
            >
              <span className="text-[var(--sf-text-primary)] w-28 truncate">{s.sourceField}</span>
              <Badge variant="default">{'\u2192'}</Badge>
              <span className="text-[var(--sf-text-primary)] w-28 truncate">{s.targetField}</span>
              <Badge
                variant={
                  s.confidence >= 0.8 ? 'success' : s.confidence >= 0.5 ? 'warning' : 'default'
                }
              >
                {Math.round(s.confidence * 100)}%
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Add new mapping */}
      <div className="flex items-center gap-2" data-testid="add-mapping-row">
        <Select
          options={sourceOptions}
          value={pendingSource}
          onChange={(e) => setPendingSource(e.target.value)}
          placeholder={t('sync.sourceField')}
          className="flex-1"
        />
        <Badge variant="default">{'\u2192'}</Badge>
        <Select
          options={targetOptions}
          value={pendingTarget}
          onChange={(e) => setPendingTarget(e.target.value)}
          placeholder={t('sync.targetField')}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleAdd}
          disabled={!pendingSource || !pendingTarget}
          data-testid="add-mapping-btn"
        >
          {t('sync.addMapping')}
        </Button>
      </div>
    </div>
  );
};
