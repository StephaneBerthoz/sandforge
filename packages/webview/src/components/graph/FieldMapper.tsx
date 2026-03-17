import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Wand2 } from 'lucide-react';
import { cn } from '../../theme';
import { Button } from '../ui/Button';

/** Single source-to-target mapping with optional metadata. */
export interface FieldMapping {
  sourceField: string;
  targetField: string;
  confidence?: number;
  transform?: string;
}

/** Props for the FieldMapper component. */
export interface FieldMapperProps {
  /** Source field names (left column). */
  sourceFields: string[];
  /** Target field names (right column). */
  targetFields: string[];
  /** Current set of mappings. */
  mappings: FieldMapping[];
  /** Callback when mappings change. */
  onMappingChange: (mappings: FieldMapping[]) => void;
  /** Optional callback for auto-matching fields. */
  onAutoMatch?: () => void;
  /** Additional CSS class for the container. */
  className?: string;
}

/** Height of each field pill in pixels. */
const PILL_HEIGHT = 32;

/** Vertical gap between pills in pixels. */
const PILL_GAP = 6;

/** Width of the SVG overlay between columns. */
const SVG_WIDTH = 120;

/**
 * Compute the Y center of a field pill given its index.
 */
function pillCenter(index: number): number {
  return index * (PILL_HEIGHT + PILL_GAP) + PILL_HEIGHT / 2;
}

/**
 * Interactive field mapping component with two columns and SVG Bezier curves.
 *
 * Click a source field, then click a target field to create a mapping.
 * Click an existing connection path to remove it.
 */
export const FieldMapper: React.FC<FieldMapperProps> = ({
  sourceFields,
  targetFields,
  mappings,
  onMappingChange,
  onAutoMatch,
  className,
}) => {
  const { t } = useTranslation();
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /** Set of source fields that are already mapped. */
  const mappedSources = useMemo(
    () => new Set(mappings.map((m) => m.sourceField)),
    [mappings],
  );

  /** Set of target fields that are already mapped. */
  const mappedTargets = useMemo(
    () => new Set(mappings.map((m) => m.targetField)),
    [mappings],
  );

  /** Source field index lookup. */
  const sourceIndex = useMemo(() => {
    const map = new Map<string, number>();
    sourceFields.forEach((f, i) => map.set(f, i));
    return map;
  }, [sourceFields]);

  /** Target field index lookup. */
  const targetIndex = useMemo(() => {
    const map = new Map<string, number>();
    targetFields.forEach((f, i) => map.set(f, i));
    return map;
  }, [targetFields]);

  /** Handle clicking a source field. */
  const handleSourceClick = useCallback(
    (field: string) => {
      if (mappedSources.has(field)) return;
      setSelectedSource((prev) => (prev === field ? null : field));
    },
    [mappedSources],
  );

  /** Handle clicking a target field — creates mapping if a source is selected. */
  const handleTargetClick = useCallback(
    (field: string) => {
      if (!selectedSource) return;
      if (mappedTargets.has(field)) return;
      const newMapping: FieldMapping = {
        sourceField: selectedSource,
        targetField: field,
      };
      onMappingChange([...mappings, newMapping]);
      setSelectedSource(null);
    },
    [selectedSource, mappedTargets, mappings, onMappingChange],
  );

  /** Handle clicking a connection path to remove the mapping. */
  const handlePathClick = useCallback(
    (index: number) => {
      const next = mappings.filter((_, i) => i !== index);
      onMappingChange(next);
    },
    [mappings, onMappingChange],
  );

  /** Clear selection when pressing Escape. */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedSource(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const maxFields = Math.max(sourceFields.length, targetFields.length, 1);
  const svgHeight = maxFields * (PILL_HEIGHT + PILL_GAP);

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col gap-3 bg-[var(--vscode-editor-background,#1e1e1e)] rounded-xl p-4',
        className,
      )}
      data-testid="field-mapper"
    >
      {/* Header with auto-match button */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('sync.fieldMapping')} ({mappings.length})
        </span>
        {onAutoMatch && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Wand2 size={14} />}
            onClick={onAutoMatch}
            data-testid="auto-match-btn"
          >
            {t('sync.autoMatch', { defaultValue: 'Auto Match' })}
          </Button>
        )}
      </div>

      {/* Canvas: source pills | SVG overlay | target pills */}
      <div className="flex items-start" data-testid="field-mapper-canvas">
        {/* Source column */}
        <div className="flex flex-col" style={{ gap: PILL_GAP }} data-testid="field-mapper-source-col">
          {sourceFields.map((field) => {
            const isMapped = mappedSources.has(field);
            const isSelected = selectedSource === field;
            return (
              <button
                key={field}
                className={cn(
                  'px-3 text-xs font-mono rounded-full border transition-colors text-left truncate',
                  isMapped
                    ? 'bg-[var(--vscode-focusBorder,#007fd4)] bg-opacity-20 border-[var(--vscode-focusBorder,#007fd4)] text-[var(--vscode-editor-foreground,#d4d4d4)]'
                    : isSelected
                      ? 'bg-[var(--vscode-list-activeSelectionBackground,#094771)] border-[var(--vscode-focusBorder,#007fd4)] text-[var(--vscode-editor-foreground,#d4d4d4)] ring-1 ring-[var(--vscode-focusBorder,#007fd4)]'
                      : 'bg-[var(--vscode-input-background,#3c3c3c)] border-[var(--vscode-panel-border,#3c3c3c)] text-[var(--vscode-descriptionForeground,#868686)] hover:border-[var(--vscode-focusBorder,#007fd4)] hover:text-[var(--vscode-editor-foreground,#d4d4d4)]',
                  isMapped && 'cursor-default',
                )}
                style={{ height: PILL_HEIGHT, minWidth: 140, maxWidth: 180 }}
                onClick={() => handleSourceClick(field)}
                disabled={isMapped}
                data-testid={`field-source-${field}`}
              >
                {field}
              </button>
            );
          })}
        </div>

        {/* SVG overlay for Bezier curves */}
        <svg
          width={SVG_WIDTH}
          height={svgHeight}
          className="shrink-0"
          data-testid="field-mapper-svg"
        >
          {mappings.map((mapping, index) => {
            const srcIdx = sourceIndex.get(mapping.sourceField);
            const tgtIdx = targetIndex.get(mapping.targetField);
            if (srcIdx === undefined || tgtIdx === undefined) return null;

            const y1 = pillCenter(srcIdx);
            const y2 = pillCenter(tgtIdx);
            const midX = SVG_WIDTH / 2;

            return (
              <path
                key={`${mapping.sourceField}-${mapping.targetField}`}
                d={`M0,${y1} C${midX},${y1} ${midX},${y2} ${SVG_WIDTH},${y2}`}
                fill="none"
                stroke="var(--vscode-focusBorder,#007fd4)"
                strokeWidth={2}
                opacity={0.7}
                className="cursor-pointer hover:opacity-100 hover:stroke-[var(--vscode-errorForeground,#f48771)]"
                onClick={() => handlePathClick(index)}
                data-testid={`field-mapper-path-${mapping.sourceField}-${mapping.targetField}`}
              />
            );
          })}
        </svg>

        {/* Target column */}
        <div className="flex flex-col" style={{ gap: PILL_GAP }} data-testid="field-mapper-target-col">
          {targetFields.map((field) => {
            const isMapped = mappedTargets.has(field);
            const isClickable = selectedSource !== null && !isMapped;
            return (
              <button
                key={field}
                className={cn(
                  'px-3 text-xs font-mono rounded-full border transition-colors text-left truncate',
                  isMapped
                    ? 'bg-[#4ec9b0] bg-opacity-20 border-[#4ec9b0] text-[var(--vscode-editor-foreground,#d4d4d4)]'
                    : isClickable
                      ? 'bg-[var(--vscode-input-background,#3c3c3c)] border-dashed border-[var(--vscode-focusBorder,#007fd4)] text-[var(--vscode-editor-foreground,#d4d4d4)] animate-pulse'
                      : 'bg-[var(--vscode-input-background,#3c3c3c)] border-[var(--vscode-panel-border,#3c3c3c)] text-[var(--vscode-descriptionForeground,#868686)]',
                )}
                style={{ height: PILL_HEIGHT, minWidth: 140, maxWidth: 180 }}
                onClick={() => handleTargetClick(field)}
                disabled={isMapped || !selectedSource}
                data-testid={`field-target-${field}`}
              >
                {field}
              </button>
            );
          })}
        </div>
      </div>

      {/* Hint text */}
      {mappings.length === 0 && (
        <p className="text-[10px] text-center text-[var(--vscode-descriptionForeground,#868686)]">
          {t('sync.fieldMapperHint', { defaultValue: 'Click a source field, then a target field to create a mapping' })}
        </p>
      )}
    </div>
  );
};
