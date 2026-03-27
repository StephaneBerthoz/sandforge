import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSyncHistoryStore } from './useSyncHistoryStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

const makeMockEntry = (id: string): SyncHistoryEntry => ({
  id,
  configSnapshot: {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'Test sync config',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [],
    enableRollback: false,
    dryRun: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  result: {
    operationId: 'op-1',
    status: 'success',
    objectResults: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        processed: 100,
        success: 98,
        failed: 2,
        skipped: 0,
        conflictCount: 0,
        errors: ['Row 55: duplicate value'],
      },
    ],
    totalProcessed: 100,
    totalSuccess: 98,
    totalFailed: 2,
    totalSkipped: 0,
    duration: 5000,
    timestamp: '2024-01-01T00:05:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:05:00Z',
  triggeredBy: 'manual',
});

describe('useSyncHistoryStore', () => {
  beforeEach(() => {
    useSyncHistoryStore.setState({
      entries: [],
      selectedEntry: null,
      loading: false,
      error: null,
    });
  });

  it('should start with empty state', () => {
    const state = useSyncHistoryStore.getState();
    expect(state.entries).toHaveLength(0);
    expect(state.selectedEntry).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('fetchHistory sets loading to true', () => {
    useSyncHistoryStore.getState().fetchHistory();
    expect(useSyncHistoryStore.getState().loading).toBe(true);
  });

  it('handleMessage with list response updates entries and sets loading=false', () => {
    useSyncHistoryStore.setState({ loading: true });
    const entries = [makeMockEntry('h-1'), makeMockEntry('h-2')];

    useSyncHistoryStore.getState().handleMessage({
      type: 'sync:history:list:response',
      payload: { entries },
    });

    const state = useSyncHistoryStore.getState();
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0].id).toBe('h-1');
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('handleMessage with detail response updates selectedEntry', () => {
    useSyncHistoryStore.setState({ loading: true });
    const entry = makeMockEntry('h-1');

    useSyncHistoryStore.getState().handleMessage({
      type: 'sync:history:detail:response',
      payload: { entry },
    });

    const state = useSyncHistoryStore.getState();
    expect(state.selectedEntry).not.toBeNull();
    expect(state.selectedEntry?.id).toBe('h-1');
    expect(state.loading).toBe(false);
  });

  it('clearSelection sets selectedEntry to null', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry('h-1') });
    useSyncHistoryStore.getState().clearSelection();
    expect(useSyncHistoryStore.getState().selectedEntry).toBeNull();
  });

  it('handleMessage with error sets error string and loading=false', () => {
    useSyncHistoryStore.setState({ loading: true });

    useSyncHistoryStore.getState().handleMessage({
      type: 'sync:history:error',
      payload: { message: 'Network error' },
    });

    const state = useSyncHistoryStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('Network error');
  });

  it('fetchDetail sets loading to true', () => {
    useSyncHistoryStore.getState().fetchDetail('h-1');
    expect(useSyncHistoryStore.getState().loading).toBe(true);
  });

  it('handleMessage with export response triggers download', () => {
    const createObjectURLSpy = vi.fn().mockReturnValue('blob:test');
    const revokeObjectURLSpy = vi.fn();
    const clickSpy = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue({
      href: '',
      download: '',
      click: clickSpy,
    } as unknown as HTMLAnchorElement);

    Object.defineProperty(globalThis, 'URL', {
      value: { createObjectURL: createObjectURLSpy, revokeObjectURL: revokeObjectURLSpy },
      writable: true,
    });

    useSyncHistoryStore.getState().handleMessage({
      type: 'sync:history:export:response',
      payload: { data: 'id,name\n1,test', format: 'csv' },
    });

    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(clickSpy).toHaveBeenCalled();

    createElementSpy.mockRestore();
  });

  it('handleMessage ignores unknown message types', () => {
    const stateBefore = useSyncHistoryStore.getState();
    useSyncHistoryStore.getState().handleMessage({
      type: 'unknown:message',
      payload: {},
    });
    const stateAfter = useSyncHistoryStore.getState();
    expect(stateAfter.entries).toEqual(stateBefore.entries);
    expect(stateAfter.loading).toBe(stateBefore.loading);
  });
});
