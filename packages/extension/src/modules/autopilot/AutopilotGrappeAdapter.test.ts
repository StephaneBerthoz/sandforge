import { describe, it, expect } from 'vitest';
import { AutopilotGrappeAdapter } from './AutopilotGrappeAdapter';

describe('AutopilotGrappeAdapter', () => {
  describe('shouldUseGrappe', () => {
    it('returns true when count exceeds threshold', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      expect(adapter.shouldUseGrappe(5001)).toBe(true);
      expect(adapter.shouldUseGrappe(10000)).toBe(true);
    });

    it('returns false when count is at or below threshold', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      expect(adapter.shouldUseGrappe(5000)).toBe(false);
      expect(adapter.shouldUseGrappe(100)).toBe(false);
      expect(adapter.shouldUseGrappe(0)).toBe(false);
    });
  });

  describe('partition', () => {
    it('returns single partition when count <= partitionSize', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      const partitions = adapter.partition('Account', 1500);
      expect(partitions).toHaveLength(1);
      expect(partitions[0]).toEqual({
        id: 'Account-0',
        objectApiName: 'Account',
        offset: 0,
        limit: 1500,
        recordCount: 1500,
      });
    });

    it('returns multiple partitions when count > partitionSize', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      const partitions = adapter.partition('Contact', 5500);
      expect(partitions).toHaveLength(3);
      expect(partitions[0]).toEqual({
        id: 'Contact-0',
        objectApiName: 'Contact',
        offset: 0,
        limit: 2000,
        recordCount: 2000,
      });
      expect(partitions[1]).toEqual({
        id: 'Contact-1',
        objectApiName: 'Contact',
        offset: 2000,
        limit: 2000,
        recordCount: 2000,
      });
      expect(partitions[2]).toEqual({
        id: 'Contact-2',
        objectApiName: 'Contact',
        offset: 4000,
        limit: 1500,
        recordCount: 1500,
      });
    });

    it('covers all records with no gaps or overlaps', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      const totalRecords = 7777;
      const partitions = adapter.partition('Lead', totalRecords);

      // Verify no gaps: each partition starts where the previous ended
      for (let i = 1; i < partitions.length; i++) {
        const prev = partitions[i - 1];
        expect(partitions[i].offset).toBe(prev.offset + prev.limit);
      }

      // Verify total coverage
      const totalCovered = partitions.reduce((sum, p) => sum + p.recordCount, 0);
      expect(totalCovered).toBe(totalRecords);

      // Verify last partition ends exactly at totalRecords
      const last = partitions[partitions.length - 1];
      expect(last.offset + last.limit).toBe(totalRecords);
    });

    it('handles exact multiple of partitionSize', () => {
      const adapter = new AutopilotGrappeAdapter(5000, 2000);
      const partitions = adapter.partition('Account', 4000);
      expect(partitions).toHaveLength(2);
      expect(partitions[0].limit).toBe(2000);
      expect(partitions[1].limit).toBe(2000);
      const totalCovered = partitions.reduce((sum, p) => sum + p.recordCount, 0);
      expect(totalCovered).toBe(4000);
    });
  });

  describe('custom configuration', () => {
    it('respects custom threshold and partitionSize', () => {
      const adapter = new AutopilotGrappeAdapter(100, 50);
      expect(adapter.getThreshold()).toBe(100);
      expect(adapter.getPartitionSize()).toBe(50);
      expect(adapter.shouldUseGrappe(101)).toBe(true);
      expect(adapter.shouldUseGrappe(100)).toBe(false);

      const partitions = adapter.partition('Case', 130);
      expect(partitions).toHaveLength(3);
      expect(partitions[0].limit).toBe(50);
      expect(partitions[1].limit).toBe(50);
      expect(partitions[2].limit).toBe(30);
    });

    it('uses default values when no arguments provided', () => {
      const adapter = new AutopilotGrappeAdapter();
      expect(adapter.getThreshold()).toBe(5000);
      expect(adapter.getPartitionSize()).toBe(2000);
    });
  });
});
