import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeGraph } from '@sandforge/shared';

/** Props for {@link ReviewDiscoveryCost}. */
export interface ReviewDiscoveryCostProps {
  /** The graph discovery answered with, which says what it sent each org. */
  graph: Pick<ForgeGraph, 'discoveryRequests'>;
  /** The source org, as Review names it. */
  source: string;
  /** The target org, as Review names it. */
  target: string;
}

/**
 * One line on Review of what discovery cost each org, before any row is
 * read: a step of its own, whose requests no gate of the run counts, as the
 * command line says them. A discovery of a whole org on a scratch org sent
 * the source 246 requests the panel never named. Nothing for a graph the
 * session's cache served, which sent none.
 */
export const ReviewDiscoveryCost: React.FC<ReviewDiscoveryCostProps> = ({
  graph,
  source,
  target,
}) => {
  const { t } = useTranslation();
  const sent = graph.discoveryRequests;
  if (!sent || sent.source + sent.target === 0) return null;
  return (
    <p data-testid="review-discovery-cost" className="text-xs text-text-secondary">
      {t('forgeRun.review.discoveryCost', {
        count: sent.source + sent.target,
        source: sent.source,
        target: sent.target,
        sourceOrg: source,
        targetOrg: target,
      })}
    </p>
  );
};
