import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, LayoutGrid, List } from 'lucide-react';
import { cn } from '../../theme';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import type { ForgeObjectsView } from '../../stores/useForgeViewStore';
import { uiLocale } from '../../utils/formatters';

/** Props for the ForgeViewToggle component. */
export interface ForgeViewToggleProps {
  /** The view the screen shows now. */
  view: ForgeObjectsView;
  /**
   * The screen's graph is large (`forgeGraphIsLarge`): the switch says how
   * slow drawing it is, and a pick made here is one made on a large graph,
   * which alone draws the next large one.
   */
  large?: boolean;
  /** How many objects the graph holds, which the warning names. */
  objectCount?: number;
}

/**
 * The Graph/Table switch of the discovery, Review and execution screens. The
 * view picked is kept for the panel, over the `sandforge.forge.graphView`
 * setting: it started on the graph at every discovery, Review drew the graph
 * whatever its size, and the execution had no table.
 *
 * A large graph (`forgeGraphIsLarge`) is the exception: it is listed, over the
 * setting and over the graph picked on a smaller one, until the graph is
 * picked here on a large one (`choiceOnLarge`). The discovery does not show
 * the switch for it at all; Review and the execution show it with the warning.
 */
export const ForgeViewToggle: React.FC<ForgeViewToggleProps> = ({
  view,
  large = false,
  objectCount = 0,
}) => {
  const { t } = useTranslation();
  const choose = useForgeViewStore((s) => s.choose);
  const warningId = useId();

  const button = (
    value: ForgeObjectsView,
    icon: React.ReactNode,
    label: string,
  ): React.ReactNode => (
    <button
      type="button"
      data-testid={`forge-view-${value}`}
      onClick={() => choose(value, large)}
      className={cn(
        'px-2.5 py-1.5 text-xs transition-colors',
        view === value
          ? 'bg-hue-forge text-(--sf-bg-primary)'
          : 'text-text-secondary hover:text-text-primary',
      )}
      aria-pressed={view === value}
      // The warning is said before the click that would hold the panel still.
      aria-describedby={large && value === 'graph' ? warningId : undefined}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <>
      <div className="flex rounded-md border border-subtle overflow-hidden">
        {button('graph', <LayoutGrid size={14} className="inline mr-1" />, t('forgeRun.graphView'))}
        {button('table', <List size={14} className="inline mr-1" />, t('forgeRun.tableView'))}
      </div>
      {/* Beside the switch whichever view is shown: listed, it says why the
          graph was not drawn; drawn, why the panel may be slow to answer. */}
      {large && (
        <p
          id={warningId}
          data-testid="forge-view-graph-slow"
          className="flex items-center gap-1.5 text-xs text-text-secondary"
        >
          <AlertTriangle size={12} aria-hidden="true" className="shrink-0 text-status-warning" />
          {t('forgeRun.graphViewSlow', {
            count: objectCount,
            formatted: objectCount.toLocaleString(uiLocale()),
          })}
        </p>
      )}
    </>
  );
};
