import { describe, it, expect, beforeEach } from 'vitest';
import type { OrgFleetSummary } from '@sandforge/shared';
import { useFleetStore } from './useFleetStore';

function makeSummary(orgId: string): OrgFleetSummary {
  return {
    orgId,
    alias: orgId,
    healthScore: 85,
    apiUsedPercent: 12,
    activeAlerts: 0,
    lastUpdatedMs: Date.now(),
  };
}

describe('useFleetStore', () => {
  beforeEach(() => {
    useFleetStore.getState().clear();
  });

  it('initial state: empty partitions Record + loading=false', () => {
    const s = useFleetStore.getState();
    expect(s.partitions).toEqual({});
    expect(s.loading).toBe(false);
    expect(s.lastUpdated).toBe(0);
  });

  it('setSummaries indexes by orgId', () => {
    useFleetStore.getState().setSummaries([makeSummary('o1'), makeSummary('o2')]);
    const s = useFleetStore.getState();
    expect(s.partitions.o1).toBeDefined();
    expect(s.partitions.o2).toBeDefined();
    expect(s.partitions.o1.orgId).toBe('o1');
  });

  it('partitions referential equality changes on each setSummaries (audit M5 fix)', () => {
    useFleetStore.getState().setSummaries([makeSummary('o1')]);
    const ref1 = useFleetStore.getState().partitions;
    useFleetStore.getState().setSummaries([makeSummary('o1')]);
    const ref2 = useFleetStore.getState().partitions;
    // Different object identity → React re-renders. With a Map this would
    // hold the same reference and skip the re-render — that was the bug.
    expect(ref1).not.toBe(ref2);
  });

  it('markLoading flips loading flag without touching partitions', () => {
    useFleetStore.getState().setSummaries([makeSummary('o1')]);
    useFleetStore.getState().markLoading(true);
    const s = useFleetStore.getState();
    expect(s.loading).toBe(true);
    expect(s.partitions.o1).toBeDefined();
  });

  it('clear empties the store', () => {
    useFleetStore.getState().setSummaries([makeSummary('o1'), makeSummary('o2')]);
    useFleetStore.getState().clear();
    const s = useFleetStore.getState();
    expect(s.partitions).toEqual({});
    expect(s.loading).toBe(false);
    expect(s.lastUpdated).toBe(0);
  });
});
