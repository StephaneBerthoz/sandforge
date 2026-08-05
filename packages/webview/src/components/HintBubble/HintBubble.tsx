import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** localStorage prefix for dismissed hints. */
const HINT_DISMISSED_PREFIX = 'sandforge-hint-dismissed-';

/** Props for the HintBubble component. */
export interface HintBubbleProps {
  /** Unique hint identifier for tracking. */
  hintId: string;
  /** The translated hint message to display. */
  message: string;
  /** Position relative to the anchor element. */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Called when the user dismisses the hint. */
  onDismiss: (hintId: string) => void;
  /** Whether this hint has already been seen. */
  seen?: boolean;
  /** Optional URL to Salesforce documentation. */
  docUrl?: string;
  /** Optional example values to display. */
  examples?: string[];
}

/**
 * Check if a hint has been permanently dismissed via localStorage.
 * @param hintId - The unique hint identifier.
 * @returns Whether the hint has been dismissed.
 */
export function isHintDismissed(hintId: string): boolean {
  return localStorage.getItem(`${HINT_DISMISSED_PREFIX}${hintId}`) === 'true';
}

/**
 * A contextual tooltip bubble that appears once for first-time hints.
 * Features:
 * - Fade-in animation with configurable delay
 * - Optional link to Salesforce documentation
 * - Optional example values display
 * - "Don't show again" per-hint persistence via localStorage
 */
export const HintBubble: React.FC<HintBubbleProps> = ({
  hintId,
  message,
  position = 'bottom',
  onDismiss,
  seen = false,
  docUrl,
  examples,
}) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [permanentlyDismissed, setPermanentlyDismissed] = useState(false);

  useEffect(() => {
    if (!seen && !isHintDismissed(hintId)) {
      const timer = setTimeout(() => setVisible(true), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [seen, hintId]);

  const handleDismiss = useCallback((): void => {
    if (permanentlyDismissed) {
      localStorage.setItem(`${HINT_DISMISSED_PREFIX}${hintId}`, 'true');
    }
    setVisible(false);
    onDismiss(hintId);
  }, [permanentlyDismissed, hintId, onDismiss]);

  if (seen || !visible || isHintDismissed(hintId)) {
    return null;
  }

  const arrowPositionClass: Record<string, string> = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2',
  };

  const arrowClass: Record<string, string> = {
    top: 'left-4 -bottom-1 border-l-transparent border-r-transparent border-b-transparent',
    bottom: 'left-4 -top-1 border-l-transparent border-r-transparent border-t-transparent',
    left: '-right-1 top-3 border-t-transparent border-b-transparent border-r-transparent',
    right: '-left-1 top-3 border-t-transparent border-b-transparent border-l-transparent',
  };

  return (
    <div
      className={`absolute z-50 ${arrowPositionClass[position]}`}
      data-testid={`hint-${hintId}`}
      role="tooltip"
      aria-label={message}
      style={{
        animation: 'fadeIn 0.3s ease-out',
        opacity: 1,
      }}
    >
      <div
        className="relative rounded-lg px-3 py-2 max-w-xs shadow-lg"
        style={{
          background: 'var(--sf-bg-card)',
          border: '1px solid var(--sf-accent, #E8A838)',
          color: 'var(--sf-text-primary)',
          fontSize: 'var(--sf-font-size-sm, 12px)',
        }}
      >
        {/* Arrow */}
        <div
          className={`absolute w-0 h-0 border-4 ${arrowClass[position]}`}
          style={{ borderColor: 'var(--sf-accent, #E8A838)' }}
        />

        <p className="mb-2">{message}</p>

        {/* Example values */}
        {examples && examples.length > 0 && (
          <div
            className="mb-2 rounded px-2 py-1"
            data-testid={`hint-examples-${hintId}`}
            style={{
              background: 'var(--sf-bg-primary)',
              fontSize: '11px',
            }}
          >
            {examples.map((example) => (
              <span
                key={example}
                className="inline-block mr-2"
                style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
              >
                {example}
              </span>
            ))}
          </div>
        )}

        {/* Documentation link */}
        {docUrl && (
          <a
            href={docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline mb-2 block"
            data-testid={`hint-doc-link-${hintId}`}
            style={{ color: 'var(--sf-text-link)' }}
          >
            {t('help.viewDocs')}
          </a>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleDismiss}
            className="text-xs font-medium px-2 py-0.5 rounded"
            style={{
              background: 'var(--sf-accent, #E8A838)',
              color: '#1E1E2E',
            }}
            aria-label={t('hints.gotIt')}
            data-testid={`hint-dismiss-${hintId}`}
          >
            {t('hints.gotIt')}
          </button>

          {/* Don't show again checkbox */}
          <label
            className="flex items-center gap-1 text-xs cursor-pointer"
            style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
          >
            <input
              type="checkbox"
              checked={permanentlyDismissed}
              onChange={(e) => setPermanentlyDismissed(e.target.checked)}
              data-testid={`hint-dont-show-${hintId}`}
            />
            {t('hints.dontShowHint')}
          </label>
        </div>
      </div>
    </div>
  );
};
