import React from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from '../../components/ui/ProgressBar';

/**
 * A panel of the dashboard, and, while the dashboard reads again, a bar that
 * moves along its top edge.
 *
 * It laid a veil of the page's background at half strength over the whole
 * panel, a spinner in its middle: every word under it read at about half its
 * contrast for the length of the read — the secondary text of Light 2026 at
 * some 2.2:1 — while the panel's controls stayed in reach of the keyboard.
 * The panel now stays as it was, busy for assistive technology, and the bar
 * sits in its border and padding, over no text.
 */
export function PanelOverlay({
  isRefreshing,
  children,
}: {
  isRefreshing: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative" aria-busy={isRefreshing || undefined}>
      {children}
      {isRefreshing && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden rounded-t-lg"
          data-testid="panel-overlay"
        >
          <ProgressBar indeterminate size="sm" ariaLabel={t('common.loading', 'Loading...')} />
        </div>
      )}
    </div>
  );
}
