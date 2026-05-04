import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UIConflict } from '@sandforge/shared';
import { useConflictStore, unresolvedCount, filteredConflicts } from './useConflictStore';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Create a mock UIConflict with the given index. */
function makeMockConflict(index: number, opts?: Partial<UIConflict>): UIConflict {
  return {
    id: `Account:001${String(index).padStart(15, '0')}:${index}`,
    objectApiName: 'Account',
    recordId: `001${String(index).padStart(15, '0')}`,
    conflictType: 'edit/edit',
    sourceValues: { Name: `Source ${index}`, Industry: 'Tech' },
    targetValues: { Name: `Target ${index}`, Industry: 'Finance' },
    conflictFields: ['Name', 'Industry'],
    timestamp: `2026-03-27T00:00:${String(index % 60).padStart(2, '0')}Z`,
    resolved: false,
    ...opts,
  };
}

describe('useConflictStore', () => {
  beforeEach(() => {
    useConflictStore.setState({
      conflicts: [],
      selectedConflictId: null,
      filterObject: null,
      filterType: null,
    });
    mockPostMessage.mockClear();
  });

  it('should start with empty state', () => {
    const state = useConflictStore.getState();
    expect(state.conflicts).toEqual([]);
    expect(state.selectedConflictId).toBeNull();
    expect(state.filterObject).toBeNull();
    expect(state.filterType).toBeNull();
  });

  it('should add a conflict and deduplicate by id', () => {
    const conflict = makeMockConflict(1);
    useConflictStore.getState().addConflict(conflict);
    expect(useConflictStore.getState().conflicts).toHaveLength(1);

    // Adding same id again should not duplicate
    useConflictStore.getState().addConflict(conflict);
    expect(useConflictStore.getState().conflicts).toHaveLength(1);

    // Adding different id should add
    useConflictStore.getState().addConflict(makeMockConflict(2));
    expect(useConflictStore.getState().conflicts).toHaveLength(2);
  });

  it('should batch add conflicts via addConflicts', () => {
    const batch = [makeMockConflict(1), makeMockConflict(2), makeMockConflict(3)];
    useConflictStore.getState().addConflicts(batch);
    expect(useConflictStore.getState().conflicts).toHaveLength(3);
  });

  it('should resolve a conflict and send message to extension', () => {
    const conflict = makeMockConflict(1);
    useConflictStore.getState().addConflict(conflict);

    useConflictStore.getState().resolveConflict(conflict.id, 'source_wins');

    const state = useConflictStore.getState();
    expect(state.conflicts[0].resolved).toBe(true);
    expect(state.conflicts[0].resolution).toBe('source_wins');

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const msg = mockPostMessage.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(msg.type).toBe('realtime:resolve-conflict');
    expect(msg.payload.conflictId).toBe(conflict.id);
    expect(msg.payload.resolution).toBe('source_wins');
  });

  it('should resolve a conflict with per-field resolutions', () => {
    const conflict = makeMockConflict(1);
    useConflictStore.getState().addConflict(conflict);

    const fieldResolutions = {
      Name: { value: 'Custom Name', source: 'manual' as const },
      Industry: { value: 'Tech', source: 'source' as const },
    };

    useConflictStore.getState().resolveConflict(conflict.id, 'manual', fieldResolutions);

    const state = useConflictStore.getState();
    expect(state.conflicts[0].fieldResolutions).toEqual(fieldResolutions);
  });

  it('should resolve all unresolved with source_wins via resolveAllSource', () => {
    const conflicts = [makeMockConflict(1), makeMockConflict(2), makeMockConflict(3)];
    useConflictStore.getState().addConflicts(conflicts);

    useConflictStore.getState().resolveAllSource();

    const state = useConflictStore.getState();
    expect(state.conflicts.every((c) => c.resolved)).toBe(true);
    expect(state.conflicts.every((c) => c.resolution === 'source_wins')).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(3);
  });

  it('should resolve all unresolved with target_wins via resolveAllTarget', () => {
    const conflicts = [makeMockConflict(1), makeMockConflict(2)];
    useConflictStore.getState().addConflicts(conflicts);

    useConflictStore.getState().resolveAllTarget();

    const state = useConflictStore.getState();
    expect(state.conflicts.every((c) => c.resolved)).toBe(true);
    expect(state.conflicts.every((c) => c.resolution === 'target_wins')).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
  });

  it('should clear resolved conflicts', () => {
    const conflicts = [makeMockConflict(1), makeMockConflict(2), makeMockConflict(3)];
    useConflictStore.getState().addConflicts(conflicts);
    useConflictStore.getState().resolveConflict(conflicts[0].id, 'source_wins');

    useConflictStore.getState().clearResolved();

    const state = useConflictStore.getState();
    expect(state.conflicts).toHaveLength(2);
    expect(state.conflicts.every((c) => !c.resolved)).toBe(true);
  });

  it('should evict oldest conflicts when exceeding 500 capacity (FIFO)', () => {
    const batch: UIConflict[] = [];
    for (let i = 1; i <= 510; i++) {
      batch.push(makeMockConflict(i));
    }
    useConflictStore.getState().addConflicts(batch);

    const state = useConflictStore.getState();
    expect(state.conflicts).toHaveLength(500);
    // First conflict should be #11 (oldest 10 were evicted)
    expect(state.conflicts[0].id).toBe(makeMockConflict(11).id);
    // Last should be #510
    expect(state.conflicts[499].id).toBe(makeMockConflict(510).id);
  });

  it('should select and deselect a conflict', () => {
    useConflictStore.getState().selectConflict('some-id');
    expect(useConflictStore.getState().selectedConflictId).toBe('some-id');

    useConflictStore.getState().selectConflict(null);
    expect(useConflictStore.getState().selectedConflictId).toBeNull();
  });

  it('should filter by object and type', () => {
    const conflicts = [
      makeMockConflict(1, { objectApiName: 'Account', conflictType: 'edit/edit' }),
      makeMockConflict(2, { objectApiName: 'Contact', conflictType: 'delete/edit' }),
      makeMockConflict(3, { objectApiName: 'Account', conflictType: 'delete/edit' }),
    ];

    const byObject = filteredConflicts(conflicts, 'Account', null);
    expect(byObject).toHaveLength(2);

    const byType = filteredConflicts(conflicts, null, 'delete/edit');
    expect(byType).toHaveLength(2);

    const byBoth = filteredConflicts(conflicts, 'Account', 'delete/edit');
    expect(byBoth).toHaveLength(1);

    const noFilter = filteredConflicts(conflicts, null, null);
    expect(noFilter).toHaveLength(3);
  });

  it('should compute unresolvedCount correctly', () => {
    const conflicts = [
      makeMockConflict(1),
      makeMockConflict(2, { resolved: true }),
      makeMockConflict(3),
    ];
    expect(unresolvedCount(conflicts)).toBe(2);
  });

  it('should not send messages for already resolved conflicts in resolveAllSource', () => {
    const conflicts = [
      makeMockConflict(1, { resolved: true, resolution: 'target_wins' }),
      makeMockConflict(2),
    ];
    useConflictStore.getState().addConflicts(conflicts);

    useConflictStore.getState().resolveAllSource();

    // Only 1 message sent for the unresolved conflict
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });
});
