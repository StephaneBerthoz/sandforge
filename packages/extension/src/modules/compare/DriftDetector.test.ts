import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftDetector } from './DriftDetector';
import type { FetchComponentNamesFn } from './DriftDetector';
import type { OrgSnapshot, MetadataComponentType } from '@sandforge/shared';

function createSnapshot(
  id: string,
  orgId: string,
  types: MetadataComponentType[],
  componentCount: number
): OrgSnapshot {
  return {
    id,
    orgId,
    name: `Snapshot ${id}`,
    componentTypes: types,
    componentCount,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('DriftDetector', () => {
  let detector: DriftDetector;
  let fetchComponentNames: FetchComponentNamesFn;

  beforeEach(() => {
    fetchComponentNames = vi.fn<FetchComponentNamesFn>().mockReturnValue([]);
    detector = new DriftDetector(fetchComponentNames);
  });

  describe('detect', () => {
    it('should return zero drift when baseline and current are identical', () => {
      vi.mocked(fetchComponentNames).mockReturnValue(['ClassA', 'ClassB']);

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(0);
      expect(result.driftScore).toBe(0);
    });

    it('should detect added components in current snapshot', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['ClassA'];
        }
        return ['ClassA', 'ClassB'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].fullName).toBe('ClassB');
      expect(result.driftedComponents[0].changeType).toBe('added');
    });

    it('should detect removed components from baseline', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['ClassA', 'ClassB'];
        }
        return ['ClassA'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].fullName).toBe('ClassB');
      expect(result.driftedComponents[0].changeType).toBe('removed');
    });

    it('should calculate drift score as percentage of baseline', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['A', 'B', 'C', 'D', 'E'];
        }
        return ['A', 'B', 'C', 'D', 'E', 'F'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 5);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 6);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBe(20);
    });

    it('should cap drift score at 100', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['A'];
        }
        return ['B', 'C', 'D', 'E'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 4);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBeLessThanOrEqual(100);
    });

    it('should handle multiple component types', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') {
          if (type === 'ApexClass') return ['ClassA'];
          if (type === 'Flow') return ['FlowA'];
          return [];
        }
        if (type === 'ApexClass') return ['ClassA', 'ClassB'];
        if (type === 'Flow') return [];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass', 'Flow'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass', 'Flow'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(2);
      const changes = result.driftedComponents.map((c) => `${c.fullName}:${c.changeType}`);
      expect(changes).toContain('ClassB:added');
      expect(changes).toContain('FlowA:removed');
    });

    it('should include the orgId in the result', () => {
      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.orgId).toBe('org-1');
    });

    it('should set detectedAt to a valid ISO date', () => {
      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.detectedAt).toBeDefined();
      expect(new Date(result.detectedAt).toISOString()).toBe(result.detectedAt);
    });

    it('should set detectedAt on each drifted component', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return [];
        }
        return ['NewClass'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents[0].detectedAt).toBe(result.detectedAt);
    });

    it('should handle component types only in current snapshot', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') return [];
        if (type === 'Flow') return ['NewFlow'];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass', 'Flow'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].componentType).toBe('Flow');
      expect(result.driftedComponents[0].changeType).toBe('added');
    });

    it('should handle baseline componentCount of zero without division error', () => {
      vi.mocked(fetchComponentNames).mockReturnValue([]);

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBe(0);
    });

    it('should set the correct componentType on drifted components', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') return [];
        if (type === 'Layout') return ['AccountLayout'];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['Layout'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['Layout'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents[0].componentType).toBe('Layout');
    });
  });
});
