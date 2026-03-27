import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { UIConflict, FieldResolution, ConflictType } from '@sandforge/shared';
import { useConflictStore, unresolvedCount } from '../../stores/useConflictStore';
import { ConflictDiffViewer } from './ConflictDiffViewer';
import { Badge } from '../../components/ui/Badge';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { cn } from '../../theme';

/** Conflict type display map keyed by ConflictType. */
const conflictTypeI18nMap: Record<ConflictType, string> = {
  'edit/edit': 'sync.conflictResolution.conflictTypes.editEdit',
  'delete/edit': 'sync.conflictResolution.conflictTypes.deleteEdit',
  'edit/delete': 'sync.conflictResolution.conflictTypes.editDelete',
  'create/edit': 'sync.conflictResolution.conflictTypes.createEdit',
};

/** Props for the ConflictResolutionPanel component. */
export interface ConflictResolutionPanelProps {
  /** The conflict to resolve. */
  conflict: UIConflict;
  /** Callback fired after the conflict is resolved. */
  onResolved?: () => void;
}

/**
 * Panel for resolving a single conflict with per-field source/target/manual choices.
 * Embeds the ConflictDiffViewer and provides bulk actions behind DangerConfirm.
 */
export const ConflictResolutionPanel: React.FC<ConflictResolutionPanelProps> = ({
  conflict,
  onResolved,
}) => {
  const { t } = useTranslation();
  const resolveConflict = useConflictStore((s) => s.resolveConflict);
  const resolveAllSource = useConflictStore((s) => s.resolveAllSource);
  const resolveAllTarget = useConflictStore((s) => s.resolveAllTarget);
  const allConflicts = useConflictStore((s) => s.conflicts);
  const unresolvedTotal = unresolvedCount(allConflicts);

  /** Per-field resolution state. */
  const [fieldResolutions, setFieldResolutions] = useState<Record<string, FieldResolution>>({});
  /** Which field is in manual edit mode. */
  const [editingField, setEditingField] = useState<string | null>(null);
  /** Manual edit value. */
  const [editValue, setEditValue] = useState('');
  /** Whether the bulk source confirm dialog is open. */
  const [showBulkSource, setShowBulkSource] = useState(false);
  /** Whether the bulk target confirm dialog is open. */
  const [showBulkTarget, setShowBulkTarget] = useState(false);

  /** Check if all conflict fields have a resolution. */
  const allFieldsResolved = conflict.conflictFields.every((f) => fieldResolutions[f]);

  /** Set a field resolution choice. */
  const pickField = useCallback(
    (field: string, source: 'source' | 'target', value: unknown) => {
      setFieldResolutions((prev) => ({
        ...prev,
        [field]: { value, source },
      }));
    },
    [],
  );

  /** Enter manual edit mode for a field. */
  const startManualEdit = useCallback(
    (field: string) => {
      setEditingField(field);
      const current = fieldResolutions[field]?.value;
      setEditValue(current !== undefined ? String(current) : '');
    },
    [fieldResolutions],
  );

  /** Confirm manual edit for a field. */
  const confirmManualEdit = useCallback(
    (field: string) => {
      setFieldResolutions((prev) => ({
        ...prev,
        [field]: { value: editValue, source: 'manual' },
      }));
      setEditingField(null);
      setEditValue('');
    },
    [editValue],
  );

  /** Apply the resolution for this conflict. */
  const handleApply = useCallback(() => {
    resolveConflict(conflict.id, 'manual', fieldResolutions);
    onResolved?.();
  }, [conflict.id, fieldResolutions, resolveConflict, onResolved]);

  /** Handle bulk source resolution. */
  const handleBulkSource = useCallback(() => {
    resolveAllSource();
    setShowBulkSource(false);
  }, [resolveAllSource]);

  /** Handle bulk target resolution. */
  const handleBulkTarget = useCallback(() => {
    resolveAllTarget();
    setShowBulkTarget(false);
  }, [resolveAllTarget]);

  // Read-only view for already resolved conflicts
  if (conflict.resolved) {
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="conflict-resolution-panel">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{conflict.objectApiName}</span>
          <span className="font-mono text-[10px]">{conflict.recordId}</span>
          <Badge variant="success">{t('sync.conflictResolution.resolved')}</Badge>
        </div>
        <ConflictDiffViewer conflict={conflict} />
        {conflict.fieldResolutions && (
          <div data-testid="resolved-summary">
            <p className="text-[10px] font-semibold text-[var(--sf-text-secondary)] mb-1">
              {t('sync.conflictResolution.applyResolution')}
            </p>
            {Object.entries(conflict.fieldResolutions).map(([field, res]) => (
              <div key={field} className="flex items-center gap-2 text-[10px]">
                <span className="font-medium">{field}:</span>
                <span className="font-mono">{String(res.value)}</span>
                <Badge variant="default">{res.source}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="conflict-resolution-panel">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold">{conflict.objectApiName}</span>
        <span className="font-mono text-[10px]">{conflict.recordId}</span>
        <Badge variant="warning">{t(conflictTypeI18nMap[conflict.conflictType])}</Badge>
        <span className="text-[10px] text-[var(--sf-text-muted)]">
          {t('sync.conflictResolution.fieldCount', { count: conflict.conflictFields.length })}
        </span>
      </div>

      {/* Diff viewer */}
      <ConflictDiffViewer conflict={conflict} />

      {/* Bulk actions */}
      <div className="flex items-center gap-2" data-testid="bulk-actions">
        <button
          type="button"
          onClick={() => setShowBulkSource(true)}
          className="text-xs px-2 py-1 rounded bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]"
          data-testid="bulk-source-btn"
        >
          {t('sync.conflictResolution.applySourceAll')}
        </button>
        <button
          type="button"
          onClick={() => setShowBulkTarget(true)}
          className="text-xs px-2 py-1 rounded bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]"
          data-testid="bulk-target-btn"
        >
          {t('sync.conflictResolution.applyTargetAll')}
        </button>
      </div>

      {/* Per-field resolution controls */}
      <div className="flex flex-col gap-1" data-testid="field-resolutions">
        {conflict.conflictFields.map((field) => {
          const resolution = fieldResolutions[field];
          const sourceVal = conflict.sourceValues[field];
          const targetVal = conflict.targetValues[field];

          return (
            <div
              key={field}
              className="flex items-center gap-2 p-1.5 rounded border border-[var(--sf-border-subtle)] text-xs"
              data-testid={`field-resolution-${field}`}
            >
              <span className="font-medium min-w-[80px]">{field}</span>

              {/* Source pick */}
              <button
                type="button"
                onClick={() => pickField(field, 'source', sourceVal)}
                className={cn(
                  'px-2 py-0.5 rounded font-mono text-[10px] border transition-colors',
                  resolution?.source === 'source'
                    ? 'border-blue-500 bg-blue-900/30 text-blue-200'
                    : 'border-[var(--sf-border-subtle)] hover:bg-[var(--sf-bg-hover)]',
                )}
                data-testid={`pick-source-${field}`}
              >
                {String(sourceVal ?? '-')}
              </button>

              {/* Target pick */}
              <button
                type="button"
                onClick={() => pickField(field, 'target', targetVal)}
                className={cn(
                  'px-2 py-0.5 rounded font-mono text-[10px] border transition-colors',
                  resolution?.source === 'target'
                    ? 'border-emerald-500 bg-emerald-900/30 text-emerald-200'
                    : 'border-[var(--sf-border-subtle)] hover:bg-[var(--sf-bg-hover)]',
                )}
                data-testid={`pick-target-${field}`}
              >
                {String(targetVal ?? '-')}
              </button>

              {/* Manual edit */}
              {editingField === field ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="px-1 py-0.5 text-[10px] rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#d4d4d4)] border border-[var(--vscode-input-border,#3c3c3c)] w-24"
                    data-testid={`manual-input-${field}`}
                  />
                  <button
                    type="button"
                    onClick={() => confirmManualEdit(field)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)]"
                    data-testid={`manual-confirm-${field}`}
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startManualEdit(field)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] border transition-colors',
                    resolution?.source === 'manual'
                      ? 'border-amber-500 bg-amber-900/30 text-amber-200'
                      : 'border-[var(--sf-border-subtle)] hover:bg-[var(--sf-bg-hover)]',
                  )}
                  data-testid={`pick-manual-${field}`}
                >
                  {resolution?.source === 'manual' ? String(resolution.value) : t('sync.conflictResolution.manualEdit')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Apply button */}
      <button
        type="button"
        onClick={handleApply}
        disabled={!allFieldsResolved}
        className={cn(
          'text-xs px-3 py-1.5 rounded font-medium transition-colors',
          allFieldsResolved
            ? 'bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)]'
            : 'bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-disabledForeground,#6b6b6b)] cursor-not-allowed',
        )}
        data-testid="apply-resolution-btn"
      >
        {t('sync.conflictResolution.applyResolution')}
      </button>

      {/* Danger confirm dialogs for bulk actions */}
      <DangerConfirm
        open={showBulkSource}
        onClose={() => setShowBulkSource(false)}
        onConfirm={handleBulkSource}
        title={t('sync.conflictResolution.applySourceAll')}
        description={t('sync.conflictResolution.confirmBulk', { count: unresolvedTotal })}
        confirmText="CONFIRM"
        variant="warning"
      />
      <DangerConfirm
        open={showBulkTarget}
        onClose={() => setShowBulkTarget(false)}
        onConfirm={handleBulkTarget}
        title={t('sync.conflictResolution.applyTargetAll')}
        description={t('sync.conflictResolution.confirmBulk', { count: unresolvedTotal })}
        confirmText="CONFIRM"
        variant="warning"
      />
    </div>
  );
};
