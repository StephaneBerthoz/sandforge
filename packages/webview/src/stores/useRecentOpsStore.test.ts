import { describe, it, expect, beforeEach } from 'vitest';
import { useRecentOpsStore } from './useRecentOpsStore';
import type { RecentOp } from './useRecentOpsStore';

const makeOp = (id: string, overrides?: Partial<RecentOp>): RecentOp => ({
  id,
  type: 'seed',
  label: `Op ${id}`,
  status: 'success',
  timestamp: Date.now(),
  ...overrides,
});

describe('useRecentOpsStore', () => {
  beforeEach(() => {
    useRecentOpsStore.setState({ ops: [] });
  });

  it('should start with an empty ops list', () => {
    expect(useRecentOpsStore.getState().ops).toHaveLength(0);
  });

  it('should add an operation to the front', () => {
    const op = makeOp('1');
    useRecentOpsStore.getState().addOp(op);
    expect(useRecentOpsStore.getState().ops).toHaveLength(1);
    expect(useRecentOpsStore.getState().ops[0].id).toBe('1');
  });

  it('should prepend new operations', () => {
    useRecentOpsStore.getState().addOp(makeOp('1'));
    useRecentOpsStore.getState().addOp(makeOp('2'));
    const { ops } = useRecentOpsStore.getState();
    expect(ops[0].id).toBe('2');
    expect(ops[1].id).toBe('1');
  });

  it('should cap ops at 10', () => {
    for (let i = 0; i < 12; i++) {
      useRecentOpsStore.getState().addOp(makeOp(String(i)));
    }
    expect(useRecentOpsStore.getState().ops).toHaveLength(10);
    // Most recent should be first
    expect(useRecentOpsStore.getState().ops[0].id).toBe('11');
  });

  it('should update an existing operation by id', () => {
    useRecentOpsStore.getState().addOp(makeOp('1', { status: 'running' }));
    useRecentOpsStore.getState().updateOp('1', { status: 'success', recordCount: 42 });
    const op = useRecentOpsStore.getState().ops[0];
    expect(op.status).toBe('success');
    expect(op.recordCount).toBe(42);
  });

  it('should not modify other ops when updating', () => {
    useRecentOpsStore.getState().addOp(makeOp('1'));
    useRecentOpsStore.getState().addOp(makeOp('2'));
    useRecentOpsStore.getState().updateOp('1', { status: 'failed' });
    expect(useRecentOpsStore.getState().ops[0].status).toBe('success'); // id=2
    expect(useRecentOpsStore.getState().ops[1].status).toBe('failed'); // id=1
  });

  it('should clear all ops', () => {
    useRecentOpsStore.getState().addOp(makeOp('1'));
    useRecentOpsStore.getState().addOp(makeOp('2'));
    useRecentOpsStore.getState().clearOps();
    expect(useRecentOpsStore.getState().ops).toHaveLength(0);
  });
});
