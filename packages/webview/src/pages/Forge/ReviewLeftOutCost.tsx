import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { leftOutCosts } from '@sandforge/shared';
import type { ForgeGraph, ForgeLeftOutCost } from '@sandforge/shared';

/** The sentence each cost is said in. */
const COST_KEYS: Record<ForgeLeftOutCost['kind'], string> = {
  lookup: 'forge.preview.leftOutLookup',
  status: 'forge.preview.leftOutStatus',
  sellingModel: 'forge.preview.leftOutSellingModel',
};

/** Props for {@link ReviewLeftOutCost}. */
export interface ReviewLeftOutCostProps {
  /** The graph the run is started with, as the user left its nodes. */
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>;
}

/**
 * What the objects the user left out cost the run, before it starts: the
 * objects whose records it cannot write without them, and the records it
 * leaves drafts.
 *
 * An object unchecked on the Forge page said nothing of it: the run sent the
 * records that could not be written without it, and the target refused each.
 * The run now holds them back and says so in its results; said here, it can
 * still be checked again. Nothing is shown when the user left nothing out
 * that costs anything the graph can tell.
 */
export const ReviewLeftOutCost: React.FC<ReviewLeftOutCostProps> = ({ graph }) => {
  const { t } = useTranslation();
  const costs = useMemo(() => leftOutCosts(graph), [graph]);
  if (costs.length === 0) return null;
  return (
    <div
      data-testid="forge-left-out-cost"
      className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warning" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t('forge.preview.leftOutCost')}</p>
        <ul className="flex flex-col gap-0.5">
          {costs.map((cost) => (
            <li
              key={`${cost.kind}|${cost.object}|${cost.leftOut}`}
              data-testid="forge-left-out-cost-row"
            >
              {t(COST_KEYS[cost.kind], { object: cost.object, leftOut: cost.leftOut })}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
