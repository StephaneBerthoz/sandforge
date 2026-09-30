import React from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, List } from 'lucide-react';
import { cn } from '../../theme';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import type { ForgeObjectsView } from '../../stores/useForgeViewStore';

/** Props for the ForgeViewToggle component. */
export interface ForgeViewToggleProps {
  /** The view the screen shows now. */
  view: ForgeObjectsView;
}

/**
 * The Graph/Table switch of the discovery, Review and execution screens. The
 * view picked is kept for the panel, over the `sandforge.forge.graphView`
 * setting: it started on the graph at every discovery, Review drew the graph
 * whatever its size, and the execution had no table.
 */
export const ForgeViewToggle: React.FC<ForgeViewToggleProps> = ({ view }) => {
  const { t } = useTranslation();
  const choose = useForgeViewStore((s) => s.choose);

  const button = (
    value: ForgeObjectsView,
    icon: React.ReactNode,
    label: string,
  ): React.ReactNode => (
    <button
      type="button"
      data-testid={`forge-view-${value}`}
      onClick={() => choose(value)}
      className={cn(
        'px-2.5 py-1.5 text-xs transition-colors',
        view === value
          ? 'bg-hue-forge text-(--sf-bg-primary)'
          : 'text-text-secondary hover:text-text-primary',
      )}
      aria-pressed={view === value}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex rounded-md border border-subtle overflow-hidden">
      {button('graph', <LayoutGrid size={14} className="inline mr-1" />, t('forge.graphView'))}
      {button('table', <List size={14} className="inline mr-1" />, t('forge.tableView'))}
    </div>
  );
};
