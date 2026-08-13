import { useMemo } from 'react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import type { ApiLimit } from '@sandforge/shared';

/**
 * Usage percentage above which a limit counts as a warning. Same threshold
 * the Monitor page uses for its `criticalLimits` list, so Home and Monitor
 * never disagree on how many limits are in trouble.
 */
const LIMIT_WARNING_THRESHOLD = 60;

/** Subset of the `monitor:data` payload this summary reads. */
interface MonitorSummaryPayload {
  limits: ApiLimit[];
  healthScore: number;
}

/** Health figures for the Home dashboard, or `null` when unknown. */
export interface OrgHealthSummary {
  /** True while the monitor round-trip is in flight. */
  loading: boolean;
  /** Org health score 0-100, or null when no org is selected / no data yet. */
  healthScore: number | null;
  /** Number of limits at or above the warning threshold, or null when unknown. */
  limitWarnings: number | null;
  /** DailyApiRequests usage percentage, or null when unknown. */
  apiUsedPercent: number | null;
}

/**
 * Fetches the org health figures the Home dashboard displays.
 *
 * Uses the single `monitor:refresh` -> `monitor:data` round trip rather than
 * the narrower `monitor:health-score` / `monitor:api-usage` pair: one request
 * carries the health score *and* the limits array, so Home costs the host one
 * call instead of two. Every field is `null` until a response lands, so the
 * caller can render a placeholder instead of a fabricated zero.
 */
export function useOrgHealthSummary(orgId: string | null): OrgHealthSummary {
  const { data, loading } = useBridgeQuery<MonitorSummaryPayload>(
    'monitor:refresh',
    orgId ? { orgId } : undefined,
    { responseType: 'monitor:data', skip: !orgId },
  );

  const limitWarnings = useMemo(() => {
    if (!data?.limits) return null;
    return data.limits.filter((l) => l.usedPercent >= LIMIT_WARNING_THRESHOLD).length;
  }, [data?.limits]);

  const apiUsedPercent = useMemo(() => {
    const api = data?.limits?.find((l) => l.name === 'DailyApiRequests');
    return api?.usedPercent ?? null;
  }, [data?.limits]);

  return {
    loading: Boolean(orgId) && loading,
    healthScore: data?.healthScore ?? null,
    limitWarnings,
    apiUsedPercent,
  };
}
