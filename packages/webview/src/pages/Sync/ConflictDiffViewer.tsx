import React from 'react';
import { useTranslation } from 'react-i18next';
import type { UIConflict } from '@sandforge/shared';
import { ConflictDiffService } from '@sandforge/shared';
import type { ConflictFieldDiff } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../theme';

/** Props for the ConflictDiffViewer component. */
export interface ConflictDiffViewerProps {
  /** The conflict to display diffs for. */
  conflict: UIConflict;
}

/** Badge variant mapped from diff type. */
const diffTypeBadgeVariant: Record<ConflictFieldDiff['type'], 'warning' | 'success' | 'error'> = {
  changed: 'warning',
  added: 'success',
  removed: 'error',
};

/**
 * Side-by-side diff viewer for a single conflict.
 * Compares source vs target field values with per-field highlighting.
 * When base values are available, performs a three-way diff and shows auto-resolved fields separately.
 */
export const ConflictDiffViewer: React.FC<ConflictDiffViewerProps> = ({ conflict }) => {
  const { t } = useTranslation();

  const fieldDiffs = React.useMemo(
    () => ConflictDiffService.diffFields(conflict.sourceValues, conflict.targetValues),
    [conflict.sourceValues, conflict.targetValues],
  );

  const threeWay = React.useMemo(() => {
    if (!conflict.baseValues) return null;
    return ConflictDiffService.diffThreeWay(
      conflict.baseValues,
      conflict.sourceValues,
      conflict.targetValues,
    );
  }, [conflict.baseValues, conflict.sourceValues, conflict.targetValues]);

  const hasBase = Boolean(conflict.baseValues);

  /** Render a field value as a string for display. */
  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  /** Determine whether a field is a conflict field. */
  const isConflictField = (fieldName: string): boolean =>
    conflict.conflictFields.includes(fieldName);

  /** Get all unique field names from source and target. */
  const allFields = React.useMemo(() => {
    const fields = new Set([
      ...Object.keys(conflict.sourceValues),
      ...Object.keys(conflict.targetValues),
      ...(conflict.baseValues ? Object.keys(conflict.baseValues) : []),
    ]);
    return [...fields].sort();
  }, [conflict.sourceValues, conflict.targetValues, conflict.baseValues]);

  /** Map field diffs by field name for quick lookup. */
  const diffByField = React.useMemo(() => {
    const map = new Map<string, ConflictFieldDiff>();
    for (const d of fieldDiffs) {
      map.set(d.field, d);
    }
    return map;
  }, [fieldDiffs]);

  return (
    <div className="flex flex-col gap-2" data-testid="conflict-diff-viewer">
      {/* Three-way auto-resolved section */}
      {threeWay && Object.keys(threeWay.autoResolved).length > 0 && (
        <div
          className="px-2 py-1.5 rounded bg-emerald-900/20 border border-emerald-700/30"
          data-testid="auto-resolved-section"
        >
          <p className="text-[10px] font-semibold text-emerald-300 mb-1">
            Auto-resolved ({Object.keys(threeWay.autoResolved).length} fields)
          </p>
          <div className="flex flex-wrap gap-1">
            {Object.entries(threeWay.autoResolved).map(([field, value]) => (
              <span
                key={field}
                className="text-[10px] font-mono bg-emerald-900/30 px-1.5 py-0.5 rounded"
              >
                {field}: {formatValue(value)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Field diff table */}
      <div className="overflow-auto">
        <table className="w-full border-collapse text-xs" data-testid="diff-table">
          <thead>
            <tr className="bg-[var(--sf-bg-secondary)]">
              <th className="text-left px-2 py-1 font-semibold text-[var(--sf-text-secondary)]">
                {t('sync.conflictResolution.fieldName')}
              </th>
              <th className="text-left px-2 py-1 font-semibold text-[var(--sf-text-secondary)]">
                {t('sync.conflictResolution.sourceValue')}
              </th>
              <th className="text-left px-2 py-1 font-semibold text-[var(--sf-text-secondary)]">
                {t('sync.conflictResolution.targetValue')}
              </th>
              {hasBase && (
                <th
                  className="text-left px-2 py-1 font-semibold text-[var(--sf-text-secondary)]"
                  data-testid="base-column-header"
                >
                  {t('sync.conflictResolution.baseValue')}
                </th>
              )}
              <th className="text-left px-2 py-1 font-semibold text-[var(--sf-text-secondary)]">
                Type
              </th>
            </tr>
          </thead>
          <tbody>
            {allFields.map((field) => {
              const d = diffByField.get(field);
              const isConflict = isConflictField(field);
              return (
                <tr
                  key={field}
                  className={cn(
                    'border-b border-[var(--sf-border-subtle)]',
                    isConflict && 'bg-amber-900/20',
                  )}
                  data-testid={`diff-row-${field}`}
                  data-conflict={isConflict ? 'true' : 'false'}
                >
                  <td className="px-2 py-1 font-medium">{field}</td>
                  <td className="px-2 py-1 font-mono text-[10px]">
                    {formatValue(conflict.sourceValues[field])}
                  </td>
                  <td className="px-2 py-1 font-mono text-[10px]">
                    {formatValue(conflict.targetValues[field])}
                  </td>
                  {hasBase && (
                    <td className="px-2 py-1 font-mono text-[10px]">
                      {formatValue(conflict.baseValues?.[field])}
                    </td>
                  )}
                  <td className="px-2 py-1">
                    {d ? (
                      <Badge variant={diffTypeBadgeVariant[d.type]}>{d.type}</Badge>
                    ) : (
                      <span className="text-[var(--sf-text-muted)]">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
