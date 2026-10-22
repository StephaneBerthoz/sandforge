import React, { useState, useCallback } from 'react';
import { Info } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { getPersistedItem, setPersistedItem } from '../../utils/webviewStorage';

const STORAGE_KEY = 'sf-dismissed-tooltips';

/**
 * Tooltip ids that were renamed, each with the id it has now. The webview
 * state keeps a dismissal under the id the tooltip had when it was closed:
 * the Seed steps' tooltips moved from `help.seed.*` to `seed.stepHelp.*`
 * with their text, and one closed before showed once more under its new id.
 */
const RENAMED_TOOLTIP_IDS: ReadonlyMap<string, string> = new Map([
  ['help.seed.selectObjects', 'seed.stepHelp.selectObjects'],
  ['help.seed.configureFields', 'seed.stepHelp.configureFields'],
  ['help.seed.execute', 'seed.stepHelp.execute'],
]);

/**
 * Read the list of dismissed tooltip IDs from the persisted webview state,
 * each under the id its tooltip has now. Returns an empty array on parse
 * failure.
 */
function getDismissedIds(): string[] {
  try {
    const raw = getPersistedItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed
      .filter((id): id is string => typeof id === 'string')
      .map((id) => RENAMED_TOOLTIP_IDS.get(id) ?? id);
    return [...new Set(ids)];
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
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-(--vscode-descriptionForeground,#868686) hover:ring-1 hover:ring-(--sf-info,#3B82F6) transition-shadow"
        aria-label={content}
        data-testid={`info-tooltip-${id}`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  );
};
