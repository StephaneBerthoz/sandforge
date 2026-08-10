import React, { useState, useCallback } from 'react';
import { Info } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { getPersistedItem, setPersistedItem, removePersistedItem } from '../../utils/webviewStorage';

const STORAGE_KEY = 'sf-dismissed-tooltips';

/**
 * Read the list of dismissed tooltip IDs from the persisted webview state.
 * Returns an empty array on parse failure.
 */
function getDismissedIds(): string[] {
  try {
    const raw = getPersistedItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Check whether a specific tooltip ID has been dismissed.
 *
 * @param id - The tooltip identifier
 * @returns true if the tooltip was previously dismissed
 */
export function isDismissed(id: string): boolean {
  return getDismissedIds().includes(id);
}

/**
 * Reset all dismissed tooltips by clearing the persisted webview state key.
 * Useful for a settings page "reset tips" button.
 */
export function resetAllTooltips(): void {
  removePersistedItem(STORAGE_KEY);
}

/** InfoTooltip component props. */
export interface InfoTooltipProps {
  /** Unique identifier for this tooltip (used for dismiss persistence). */
  id: string;
  /** Text content displayed inside the tooltip. */
  content: string;
  /** Which side of the icon the tooltip appears on. */
  side?: 'top' | 'bottom';
  /** Additional CSS class for the wrapper. */
  className?: string;
}

/**
 * Dismissible info tooltip with a small (i) icon.
 *
 * Renders a muted info icon that shows a tooltip on hover with content
 * and a dismiss button. Once dismissed, the tooltip ID is stored in
 * the VS Code webview state under `sf-dismissed-tooltips` and the icon is hidden.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  id,
  content,
  side = 'top',
  className,
}) => {
  const [dismissed, setDismissed] = useState(() => isDismissed(id));

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const ids = getDismissedIds();
      if (!ids.includes(id)) {
        ids.push(id);
        setPersistedItem(STORAGE_KEY, JSON.stringify(ids));
      }
      setDismissed(true);
    },
    [id],
  );

  if (dismissed) return null;

  return (
    <Tooltip
      content={content}
      side={side}
      className={className}
      dismissible
      onDismiss={handleDismiss}
    >
      <button
        type="button"
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[var(--vscode-descriptionForeground,#868686)] hover:ring-1 hover:ring-[var(--sf-info,#3B82F6)] transition-shadow"
        aria-label={content}
        data-testid={`info-tooltip-${id}`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  );
};
