import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { EnrichedDiff, DiffRiskLevel } from '@sandforge/shared';

/** Props for the DiffDetailModal component. */
export interface DiffDetailModalProps {
  diff: EnrichedDiff;
  onClose: () => void;
  className?: string;
}

/** Badge variant for risk level. */
const riskBadge: Record<DiffRiskLevel, BadgeVariant> = {
  none: 'default',
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

/** Badge variant for change type. */
const changeBadge: Record<EnrichedDiff['changeType'], BadgeVariant> = {
  added: 'success',
  removed: 'error',
  modified: 'warning',
};

/**
 * Modal overlay showing detailed information about a single enriched diff.
 * Displays side-by-side source/target values, risk reasons, and dependencies.
 */
export const DiffDetailModal: React.FC<DiffDetailModalProps> = ({ diff, onClose, className }) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  /** Close on Escape key. */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    /** Focus the close button on mount for keyboard accessibility. */
    const closeBtn = dialogRef.current?.querySelector<HTMLElement>('[data-testid="close-diff-modal"]');
    closeBtn?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      ref={dialogRef}
      data-testid="diff-detail-modal"
      className={className}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('compare.diffDetails', '{{name}} diff details', { name: diff.name })}
    >
      <div
        style={{
          backgroundColor: 'var(--sf-bg-card, #1e1e1e)',
          borderRadius: 'var(--sf-radius-lg)',
          border: '1px solid var(--sf-border)',
          width: '90%',
          maxWidth: '700px',
          maxHeight: '80vh',
          overflow: 'auto',
          padding: 'var(--sf-space-5)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sf-space-2)',
            marginBottom: 'var(--sf-space-4)',
          }}
        >
          <Badge variant={changeBadge[diff.changeType]}>{diff.changeType}</Badge>
          <Badge variant={riskBadge[diff.riskLevel]}>{diff.riskLevel}</Badge>
          <span
            style={{
              flex: 1,
              fontSize: 'var(--sf-font-size-base)',
              fontWeight: 600,
              color: 'var(--sf-text-primary)',
              fontFamily: 'monospace',
            }}
            data-testid="diff-detail-name"
          >
            {diff.name}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="close-diff-modal"
            aria-label={t('common.close', 'Close')}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </Button>
        </div>

        {/* Metadata */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 'var(--sf-space-2)',
            marginBottom: 'var(--sf-space-4)',
            fontSize: 'var(--sf-font-size-xs)',
          }}
          data-testid="diff-detail-meta"
        >
          <div>
            <span style={{ color: 'var(--sf-text-muted)' }}>{t('compare.category', 'Category')}: </span>
            <span style={{ color: 'var(--sf-text-primary)' }}>{diff.category}</span>
          </div>
          <div>
            <span style={{ color: 'var(--sf-text-muted)' }}>{t('compare.group', 'Group')}: </span>
            <span style={{ color: 'var(--sf-text-primary)' }}>{diff.group}</span>
          </div>
        </div>

        {/* Side-by-side values */}
        {(diff.sourceValue || diff.targetValue) && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--sf-space-2)',
              marginBottom: 'var(--sf-space-4)',
            }}
          >
            <div>
              <h4
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontWeight: 600,
                  color: 'var(--sf-text-secondary)',
                  marginBottom: 'var(--sf-space-1)',
                }}
              >
                {t('compare.source', 'Source Org')}
              </h4>
              <pre
                data-testid="diff-source-value"
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontFamily: 'monospace',
                  backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                  padding: 'var(--sf-space-2)',
                  borderRadius: 'var(--sf-radius-sm)',
                  overflow: 'auto',
                  maxHeight: '200px',
                  color: 'var(--sf-text-primary)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {diff.sourceValue ?? t('compare.empty', '(empty)')}
              </pre>
            </div>
            <div>
              <h4
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontWeight: 600,
                  color: 'var(--sf-text-secondary)',
                  marginBottom: 'var(--sf-space-1)',
                }}
              >
                {t('compare.target', 'Target Org')}
              </h4>
              <pre
                data-testid="diff-target-value"
                style={{
                  fontSize: 'var(--sf-font-size-xs)',
                  fontFamily: 'monospace',
                  backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                  padding: 'var(--sf-space-2)',
                  borderRadius: 'var(--sf-radius-sm)',
                  overflow: 'auto',
                  maxHeight: '200px',
                  color: 'var(--sf-text-primary)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {diff.targetValue ?? t('compare.empty', '(empty)')}
              </pre>
            </div>
          </div>
        )}

        {/* Risk reasons */}
        {diff.riskReasons.length > 0 && (
          <div style={{ marginBottom: 'var(--sf-space-4)' }} data-testid="diff-risk-reasons">
            <h4
              style={{
                fontSize: 'var(--sf-font-size-xs)',
                fontWeight: 600,
                color: 'var(--sf-text-secondary)',
                marginBottom: 'var(--sf-space-1)',
              }}
            >
              {t('compare.riskReasons', 'Risk Reasons')}
            </h4>
            <ul
              style={{
                margin: 0,
                paddingLeft: 'var(--sf-space-4)',
                fontSize: 'var(--sf-font-size-xs)',
                color: 'var(--sf-text-primary)',
                lineHeight: 1.5,
              }}
            >
              {diff.riskReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Dependencies */}
        {diff.dependencies.length > 0 && (
          <div data-testid="diff-dependencies">
            <h4
              style={{
                fontSize: 'var(--sf-font-size-xs)',
                fontWeight: 600,
                color: 'var(--sf-text-secondary)',
                marginBottom: 'var(--sf-space-1)',
              }}
            >
              {t('compare.dependencies', 'Dependencies')}
            </h4>
            <div style={{ display: 'flex', gap: 'var(--sf-space-1)', flexWrap: 'wrap' }}>
              {diff.dependencies.map((dep) => (
                <Badge key={dep} variant="default">{dep}</Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
