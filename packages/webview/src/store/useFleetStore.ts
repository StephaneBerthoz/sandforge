import { create } from 'zustand';
import type { OrgFleetSummary } from '@sandforge/shared';

/**
 * Plan 03-07 fleet-overview state.
 *
 * `partitions` is a `Record<orgId, OrgFleetSummary>` (NOT a Map) so React
 * referential-equality checks correctly trigger re-renders on update —
 * see audit M5 / RESEARCH §3 P-03.7 ("Map ban in Zustand stores").
 */
export interface FleetState {
  partitions: Record<string, OrgFleetSummary>;
  lastUpdated: number;
  loading: boolean;
  setSummaries: (orgs: OrgFleetSummary[]) => void;
  markLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useFleetStore = create<FleetState>()((set) => ({
  partitions: {},
  lastUpdated: 0,
  loading: false,
  setSummaries: (orgs) =>
    set({
      partitions: orgs.reduce<Record<string, OrgFleetSummary>>((acc, o) => {
        acc[o.orgId] = o;
        return acc;
      }, {}),
      lastUpdated: Date.now(),
      loading: false,
    }),
  markLoading: (loading) => set({ loading }),
  clear: () => set({ partitions: {}, lastUpdated: 0, loading: false }),
}));
