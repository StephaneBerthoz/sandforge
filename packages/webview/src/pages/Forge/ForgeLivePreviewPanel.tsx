import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, AlertTriangle, Globe } from 'lucide-react';
import type { ForgeTabMode } from './useForgeForm';
import { isPiiField } from './forgeUtils';
import type { RecordPreview } from './forgeUtils';

/** Props for the ForgeLivePreviewPanel component. */
export interface ForgeLivePreviewPanelProps {
  /** Preview data for the current record, or null when not loaded. */
  preview: RecordPreview | null;
  /** Current input mode (drives the placeholder hint text). */
  inputMode: ForgeTabMode;
  /** Source org id (drives the record-mode placeholder text). */
  sourceOrgId: string;
  /** Whether PII anonymization is enabled (hides the PII warning). */
  anonymize: boolean;
  /** Dismiss the preview card. */
  onClosePreview: () => void;
  /**
   * The ALL chip is picked: there is no record to preview, and the panel says
   * what the run starts from instead, the whole source org.
   */
  wholeOrg?: boolean;
  /** The name the source org is shown under, or '' when none is picked. */
  sourceAlias?: string;
  /** The name the target org is shown under, or '' when none is picked. */
  targetAlias?: string;
  /**
   * The source holds real people's data — a production org, or a sandbox
   * marked Staging — which a clone of its whole anonymizes unless unticked:
   * the card says why Anonymize PII came on.
   */
  sourceHoldsRealData?: boolean;
}

/**
 * Right-hand live preview panel: record preview card (or placeholder), the
 * root record's object and field count, and the PII warning banner.
 *
 * For a clone of the whole org, a card in their place: what discovery will
 * list and count, from which org into which, and, when Anonymize PII is
 * off, that every personal field of the org goes as it is. The record
 * banner could not say it: it counts the fields of one previewed record,
 * and ALL previews none. Of a source that holds real people's data, why
 * Anonymize PII came on.
 */
export const ForgeLivePreviewPanel: React.FC<ForgeLivePreviewPanelProps> = ({
  preview,
  inputMode,
  sourceOrgId,
  anonymize,
  onClosePreview,
  wholeOrg = false,
  sourceAlias = '',
  targetAlias = '',
  sourceHoldsRealData = false,
}) => {
  const { t, i18n } = useTranslation();

  const piiFieldCount = useMemo(
    () => preview?.fields.filter((f) => isPiiField(f.name)).length ?? 0,
    [preview],
  );
  /** Every field of the root object, as its describe counts them. */
  const rootFieldCount = preview ? (preview.totalFieldCount ?? preview.fields.length) : 0;

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg bg-surface-2 border border-subtle">
      <div className="text-[10px] text-text-secondary uppercase tracking-widest">
        {t('forge.livePreview')}
      </div>

      {wholeOrg && (
        <div
          className="rounded-lg border border-subtle bg-surface-1 p-3 flex flex-col gap-1.5"
          data-testid="forge-all-preview"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-hue-forge">
            <Globe size={14} aria-hidden="true" />
            {t('forge.wholeOrg')}
          </div>
          <p className="text-[11px] text-text-primary" data-testid="forge-all-preview-body">
            {!sourceAlias
              ? t('forge.allPreviewNoSource')
              : targetAlias
                ? t('forge.allPreviewBody', { source: sourceAlias, target: targetAlias })
                : t('forge.allPreviewBodyNoTarget', { source: sourceAlias })}
          </p>
          {sourceHoldsRealData && anonymize && sourceAlias && (
            <p className="text-[11px] text-text-secondary" data-testid="forge-all-real-data">
              {t('forge.allPreviewRealData', { source: sourceAlias })}
            </p>
          )}
        </div>
      )}
      {wholeOrg && !anonymize && (
        <div
          className="rounded-md border border-status-error/30 bg-status-error/10 p-2.5 flex items-center gap-2"
          data-testid="forge-all-pii-off"
        >
          <AlertTriangle size={16} className="text-status-error shrink-0" />
          <div className="text-[11px] text-text-primary">{t('forge.allPreviewPiiOff')}</div>
        </div>
      )}

      {/* Record preview card or placeholder */}
      {wholeOrg ? null : preview ? (
        <div
          className="rounded-lg border border-subtle bg-surface-1 p-3"
          data-testid="forge-record-preview"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-sm bg-forge/20 text-hue-forge">
              {preview.objectLabel}
            </span>
            <span className="text-[10px] font-mono text-text-secondary">
              {preview.recordId.slice(0, 5)}...{preview.recordId.slice(-4)}
            </span>
            <button
              type="button"
              onClick={onClosePreview}
              className="ml-auto text-text-secondary hover:text-text-primary transition-colors"
              aria-label={t('forge.closePreview', 'Close preview')}
            >
              <X size={12} />
            </button>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {preview.fields.map((f) => (
              <React.Fragment key={f.name}>
                <span className="text-text-secondary">{f.name}</span>
                <span className="text-text-primary font-mono truncate flex items-center gap-1">
                  {isPiiField(f.name) && (
                    <span className="shrink-0 text-[9px] px-1 py-px rounded-sm bg-status-error/10 text-status-error font-sans">
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
          <Search size={20} className="mx-auto mb-2 text-text-secondary" />
          <p className="text-xs text-text-secondary">
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

      {/* The root record, and only that: the graph is not known before
          discovery. An "Estimated Graph" box stood here, counting one object,
          the root object's whole table as its records and that table's size
          — 180,000 records and 180 MB for one Account of a large org, when
          the clone copies a few dozen rows. Discovery already says its counts
          are the source tables' for a one-record clone. */}
      {preview && !wholeOrg && (
        <p
          className="rounded-lg border border-subtle bg-surface-1 p-3 text-xs text-text-primary"
          data-testid="forge-root-record"
        >
          {t('forge.rootRecordSummary', {
            object: preview.objectLabel,
            count: rootFieldCount,
            // In the panel's language, read off i18next: the formatters
            // module would add some 22 kB to what Forge parses before it
            // paints, for one figure.
            formatted: rootFieldCount.toLocaleString(i18n.resolvedLanguage ?? i18n.language),
          })}
        </p>
      )}

      {/* PII warning banner */}
      {piiFieldCount > 0 && !anonymize && !wholeOrg && (
        <div
          className="rounded-md border border-status-error/30 bg-status-error/10 p-2.5 flex items-center gap-2"
          data-testid="forge-pii-warning"
        >
          <AlertTriangle size={16} className="text-status-error shrink-0" />
          <div>
            <div className="text-[11px] text-status-error font-medium">
              {t('forge.piiWarning', { count: piiFieldCount })}
            </div>
            <div className="text-[10px] text-text-primary">{t('forge.piiWarningHint')}</div>
          </div>
        </div>
      )}
    </div>
  );
};
