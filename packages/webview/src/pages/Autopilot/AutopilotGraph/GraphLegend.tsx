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

/** Node status legend entries: the tokens ObjectNode and the minimap paint with. */
const NODE_STATUSES: LegendItem[] = [
  { labelKey: 'autopilot.graph.pending', colorClass: 'bg-text-secondary' },
  { labelKey: 'autopilot.graph.extracting', colorClass: 'bg-hue-blue' },
  { labelKey: 'autopilot.graph.anonymizing', colorClass: 'bg-hue-purple' },
  { labelKey: 'autopilot.graph.loading', colorClass: 'bg-hue-green' },
  { labelKey: 'autopilot.graph.completed', colorClass: 'bg-status-success' },
  { labelKey: 'autopilot.graph.failed', colorClass: 'bg-status-error' },
];

/** Edge type legend entries: the tokens RelationEdge strokes with. */
const EDGE_TYPES: LegendItem[] = [
  { labelKey: 'autopilot.graph.masterDetail', colorClass: 'bg-hue-amber' },
  { labelKey: 'autopilot.graph.lookup', colorClass: 'bg-hue-blue', dashed: true },
  { labelKey: 'autopilot.graph.hierarchical', colorClass: 'bg-hue-cyan', dashed: true },
  { labelKey: 'autopilot.graph.polymorphic', colorClass: 'bg-hue-purple' },
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
      className="absolute bottom-3 left-3 z-10 rounded-md border border-subtle bg-[var(--sf-bg-primary)] p-3 text-xs shadow-lg"
    >
      {/* Node statuses */}
      <div className="mb-2 font-semibold text-[var(--sf-text-primary)]">
        {t('autopilot.graph.legend.statuses')}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {NODE_STATUSES.map((item) => (
          <div key={item.labelKey} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${item.colorClass}`} />
            <span className="text-text-secondary">{t(item.labelKey)}</span>
          </div>
        ))}
      </div>

      {/* Edge types */}
      <div className="mb-2 font-semibold text-[var(--sf-text-primary)]">
        {t('autopilot.graph.legend.relationships')}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {EDGE_TYPES.map((item) => (
          <div key={item.labelKey} className="flex items-center gap-1.5">
            <span
              className={`inline-block h-0.5 w-4 ${item.colorClass} ${item.dashed ? 'border-t border-dashed border-current' : ''}`}
            />
            <span className="text-text-secondary">{t(item.labelKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
