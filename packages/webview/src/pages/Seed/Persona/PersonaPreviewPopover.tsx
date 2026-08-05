import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { PersonaMsg } from '@sandforge/shared';
import { DataTable } from '../../../components/ui/DataTable';
import type { DataTableColumn } from '../../../components/ui/DataTable';

/** Props for the PersonaPreviewPopover component. */
export interface PersonaPreviewPopoverProps {
  /** The persona being previewed. */
  persona: PersonaMsg;
  /** 5 sample records generated from the persona's data patterns. */
  sampleRecords: Record<string, string>[];
  /** Called when the popover should close. */
  onClose: () => void;
}

/**
 * An absolutely positioned popover that displays a DataTable with
 * 5 sample records generated from a persona's data patterns.
 * Closes on outside click or Escape key.
 */
export const PersonaPreviewPopover: React.FC<PersonaPreviewPopoverProps> = ({
  persona,
  sampleRecords,
  onClose,
}) => {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);

  /** Close on click outside. */
  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  /** Close on Escape key. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClickOutside, handleKeyDown]);

  const fieldNames = Object.keys(persona.dataPatterns);

  const columns: DataTableColumn<Record<string, string>>[] = fieldNames.map((fieldName) => ({
    key: fieldName,
    header: fieldName,
    width: `${Math.max(100, Math.min(200, fieldName.length * 10))}px`,
  }));

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 max-w-[400px] rounded border shadow-lg bg-[var(--sf-bg-card)] border-[var(--sf-border-subtle)] text-[var(--sf-text-primary)]"
      data-testid="persona-preview-popover"
      role="dialog"
      aria-label={t('seed.persona.preview.title')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--sf-border-subtle)]">
        <div className="flex flex-col">
          <span className="text-xs font-semibold">{persona.name}</span>
          <span className="text-[10px] text-[var(--sf-text-secondary)]">
            {t('seed.persona.preview.sampleData')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-[var(--sf-bg-toolbar-hover)] text-[var(--sf-text-secondary)]"
          data-testid="preview-close-btn"
          aria-label={t('common.close')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Data table with sample records */}
      <div className="p-2 overflow-x-auto max-h-[300px] overflow-y-auto">
        {sampleRecords.length > 0 ? (
          <DataTable
            columns={columns}
            data={sampleRecords}
            keyExtractor={(_row, index) => String(index)}
            className="text-[10px]"
          />
        ) : (
          <p className="text-xs text-center py-4 text-[var(--sf-text-secondary)]">
            {t('common.noData')}
          </p>
        )}
      </div>
    </div>
  );
};
