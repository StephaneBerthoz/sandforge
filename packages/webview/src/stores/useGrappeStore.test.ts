import { describe, it, expect, beforeEach } from 'vitest';
import { useGrappeStore } from './useGrappeStore';

describe('useGrappeStore', () => {
  beforeEach(() => {
    useGrappeStore.getState().reset();
  });

  it('should have correct initial state', () => {
    const state = useGrappeStore.getState();
    expect(state.active).toBe(false);
    expect(state.operationId).toBeNull();
    expect(state.totalPartitions).toBe(0);
    expect(state.totalRecords).toBe(0);
    expect(state.partitions.size).toBe(0);
  });

  it('should start a grappe operation', () => {
    useGrappeStore.getState().start('op-1', 5, 10000);
    const state = useGrappeStore.getState();
    expect(state.active).toBe(true);
    expect(state.operationId).toBe('op-1');
    expect(state.totalPartitions).toBe(5);
    expect(state.totalRecords).toBe(10000);
  });

  it('should update partition progress', () => {
    useGrappeStore.getState().start('op-1', 3, 5000);
    useGrappeStore.getState().updatePartition('p-1', 50, 1000);
    const state = useGrappeStore.getState();
    expect(state.partitions.size).toBe(1);
    const p = state.partitions.get('p-1');
    expect(p?.percentage).toBe(50);
    expect(p?.processedRecords).toBe(1000);
  });

  it('should complete a grappe operation', () => {
    useGrappeStore.getState().start('op-1', 2, 3000);
    useGrappeStore.getState().complete(2800, 200);
    const state = useGrappeStore.getState();
    expect(state.active).toBe(false);
    expect(state.totalProcessed).toBe(2800);
    expect(state.totalFailed).toBe(200);
  });

  it('should reset to initial state', () => {
    useGrappeStore.getState().start('op-1', 5, 10000);
    useGrappeStore.getState().updatePartition('p-1', 100, 2000);
    useGrappeStore.getState().reset();
    const state = useGrappeStore.getState();
    expect(state.active).toBe(false);
    expect(state.operationId).toBeNull();
    expect(state.partitions.size).toBe(0);
  });

  it('should track multiple partitions', () => {
    useGrappeStore.getState().start('op-1', 3, 6000);
    useGrappeStore.getState().updatePartition('p-1', 100, 2000);
    useGrappeStore.getState().updatePartition('p-2', 50, 1000);
    useGrappeStore.getState().updatePartition('p-3', 0, 0);
    const state = useGrappeStore.getState();
    expect(state.partitions.size).toBe(3);
    expect(state.partitions.get('p-1')?.percentage).toBe(100);
    expect(state.partitions.get('p-2')?.percentage).toBe(50);
    expect(state.partitions.get('p-3')?.percentage).toBe(0);
  });
});
