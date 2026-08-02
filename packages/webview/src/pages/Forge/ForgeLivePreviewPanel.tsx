import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, AlertTriangle } from 'lucide-react';
import type { ForgeInputMode } from '../../stores/useForgeStore';
import { isPiiField } from './forgeUtils';
import type { RecordPreview } from './forgeUtils';

/** Props for the ForgeLivePreviewPanel component. */
export interface ForgeLivePreviewPanelProps {
  /** Preview data for the current record, or null when not loaded. */
  preview: RecordPreview | null;
  /** Current input mode (drives the placeholder hint text). */
  inputMode: ForgeInputMode;
  /** Source org id (drives the record-mode placeholder text). */
  sourceOrgId: string;
  /** Whether PII anonymization is enabled (hides the PII warning). */
  anonymize: boolean;
  /** Dismiss the preview card. */
  onClosePreview: () => void;
}

/**
 * Right-hand live preview panel: record preview card (or placeholder),
 * estimated graph stats, and the PII warning banner.
 */
export const ForgeLivePreviewPanel: React.FC<ForgeLivePreviewPanelProps> = ({
  preview,
  inputMode,
  sourceOrgId,
  anonymize,
  onClosePreview,
}) => {
  const { t } = useTranslation();

  const piiFieldCount = useMemo(
    () => preview?.fields.filter((f) => isPiiField(f.name)).length ?? 0,
    [preview],
  );

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg bg-surface-2 border border-subtle">
      <div className="text-[10px] text-text-muted uppercase tracking-widest">
        {t('forge.livePreview')}
      </div>

      {/* Record preview card or placeholder */}
      {preview ? (
        <div
          className="rounded-lg border border-subtle bg-surface-1 p-3"
          data-testid="forge-record-preview"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-forge/20 text-forge">
              {preview.objectLabel}
            </span>
            <span className="text-[10px] font-mono text-text-muted">
              {preview.recordId.slice(0, 5)}...{preview.recordId.slice(-4)}
            </span>
            <button
              type="button"
              onClick={onClosePreview}
              className="ml-auto text-text-muted hover:text-text-primary transition-colors"
              aria-label={t('forge.closePreview', 'Close preview')}
            >
              <X size={12} />
            </button>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {preview.fields.map((f) => (
              <React.Fragment key={f.name}>
                <span className="text-text-muted">{f.name}</span>
                <span className="text-text-primary font-mono truncate flex items-center gap-1">
                  {isPiiField(f.name) && (
                    <span className="shrink-0 text-[9px] px-1 py-px rounded bg-red-500/20 text-red-400 font-sans">
                      PII
                    </span>
                  )}
                  {f.value}
                </span>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-subtle p-6 text-center">
          <Search size={20} className="mx-auto mb-2 text-text-muted/50" />
          <p className="text-xs text-text-muted">
            {inputMode === 'record'
              ? sourceOrgId
                ? t('forge.recordIdPlaceholder')
                : t('forge.noOrgSelected')
              : inputMode === 'soql'
                ? t('forge.soqlPreviewHint')
                : inputMode === 'template'
                  ? t('forge.templatePreviewHint')
                  : t('forge.aiPreviewHint')}
          </p>
        </div>
      )}

      {/* Estimated graph stats */}
      <div className="rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="text-[10px] text-text-muted mb-2">{t('forge.estimatedGraph')}</div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div>
            <div className="text-lg font-bold text-forge" data-testid="est-objects">
              {preview ? '1' : '—'}
            </div>
            <div className="text-[9px] text-text-muted">{t('forge.objects')}</div>
          </div>
          <div>
            <div className="text-lg font-bold text-forge" data-testid="est-fields">
              {preview ? String(preview.totalFieldCount ?? preview.fields?.length ?? 0) : '—'}
            </div>
            <div className="text-[9px] text-text-muted">{t('forge.fields')}</div>
          </div>
          <div>
            <div className="text-lg font-bold text-green-500" data-testid="est-size">
              {preview?.estimatedSize != null ? `${preview.estimatedSize.toFixed(2)} MB` : '—'}
            </div>
            <div className="text-[9px] text-text-muted">{t('forge.estSize')}</div>
          </div>
          <div>
            <div className="text-lg font-bold text-yellow-500" data-testid="est-records">
              {preview?.estimatedRecordCount != null ? String(preview.estimatedRecordCount) : '—'}
            </div>
            <div className="text-[9px] text-text-muted">{t('forge.estRecords')}</div>
          </div>
        </div>
      </div>

      {/* PII warning banner */}
      {piiFieldCount > 0 && !anonymize && (
        <div
          className="rounded-md border border-red-500/30 bg-red-500/10 p-2.5 flex items-center gap-2"
          data-testid="forge-pii-warning"
        >
          <AlertTriangle size={16} className="text-red-400 shrink-0" />
          <div>
            <div className="text-[11px] text-red-400 font-medium">
              {t('forge.piiWarning', { count: piiFieldCount })}
            </div>
            <div className="text-[10px] text-text-muted">{t('forge.piiWarningHint')}</div>
          </div>
        </div>
      )}
    </div>
  );
};
