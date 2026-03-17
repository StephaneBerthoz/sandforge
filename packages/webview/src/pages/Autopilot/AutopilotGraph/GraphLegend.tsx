import React from 'react';
import { useTranslation } from 'react-i18next';

/** Descriptor for a legend entry. */
interface LegendItem {
  /** Translation key for the label */
  labelKey: string;
  /** Tailwind background color class */
  colorClass: string;
  /** Optional dash style for edge entries */
  dashed?: boolean;
}

/** Node status legend entries. */
const NODE_STATUSES: LegendItem[] = [
  { labelKey: 'autopilot.graph.legend.pending', colorClass: 'bg-gray-500' },
  { labelKey: 'autopilot.graph.legend.extracting', colorClass: 'bg-blue-500' },
  { labelKey: 'autopilot.graph.legend.anonymizing', colorClass: 'bg-purple-500' },
  { labelKey: 'autopilot.graph.legend.loading', colorClass: 'bg-green-500' },
  { labelKey: 'autopilot.graph.legend.completed', colorClass: 'bg-green-600' },
  { labelKey: 'autopilot.graph.legend.failed', colorClass: 'bg-red-500' },
];

/** Edge type legend entries. */
const EDGE_TYPES: LegendItem[] = [
  { labelKey: 'autopilot.graph.legend.masterDetail', colorClass: 'bg-amber-500' },
  { labelKey: 'autopilot.graph.legend.lookup', colorClass: 'bg-blue-500', dashed: true },
  { labelKey: 'autopilot.graph.legend.hierarchical', colorClass: 'bg-cyan-500', dashed: true },
  { labelKey: 'autopilot.graph.legend.polymorphic', colorClass: 'bg-purple-400' },
];

/**
 * GraphLegend — Displays a small overlay legend for the AutopilotGraph
 * showing node status colors and edge relationship types.
 */
export const GraphLegend: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="graph-legend"
      className="absolute bottom-3 left-3 z-10 rounded-md border border-gray-600 bg-[var(--vscode-editor-background,#1e1e1e)] p-3 text-xs shadow-lg"
    >
      {/* Node statuses */}
      <div className="mb-2 font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('autopilot.graph.legend.statuses')}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {NODE_STATUSES.map((item) => (
          <div key={item.labelKey} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${item.colorClass}`} />
            <span className="text-gray-400">{t(item.labelKey)}</span>
          </div>
        ))}
      </div>

      {/* Edge types */}
      <div className="mb-2 font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('autopilot.graph.legend.relationships')}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {EDGE_TYPES.map((item) => (
          <div key={item.labelKey} className="flex items-center gap-1.5">
            <span
              className={`inline-block h-0.5 w-4 ${item.colorClass} ${item.dashed ? 'border-t border-dashed border-current' : ''}`}
            />
            <span className="text-gray-400">{t(item.labelKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
