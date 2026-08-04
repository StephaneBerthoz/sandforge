import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHistoryStore } from './ForgeHistoryStore.js';
import type { ForgeExecutionResult } from '@sandforge/shared';

const mockGet = vi.fn<[key: string], unknown>();
const mockUpdate = vi.fn<[key: string, value: unknown], Promise<void>>();

function createStore(): ForgeHistoryStore {
  return new ForgeHistoryStore({ get: mockGet, update: mockUpdate });
}

const sampleResult: ForgeExecutionResult = {
  forgeId: 'f-1',
  status: 'success',
  graph: { nodes: [], edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 },
  duration: 1000,
  timestamp: '2026-01-01T00:00:00Z',
  idRemapCount: 5,
};

describe('ForgeHistoryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('should return empty array when no history', () => {
    mockGet.mockReturnValue(undefined);
    const store = createStore();
    expect(store.list()).toEqual([]);
  });

  it('should return stored history', () => {
    mockGet.mockReturnValue([sampleResult]);
    const store = createStore();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].forgeId).toBe('f-1');
  });

  it('should add a result to history (newest first)', async () => {
    mockGet.mockReturnValue([]);
    const store = createStore();
    await store.add(sampleResult);
    expect(mockUpdate).toHaveBeenCalledWith('forge:history', [sampleResult]);
  });

  it('should limit history to 50 entries', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({ ...sampleResult, forgeId: `f-${i}` }));
    mockGet.mockReturnValue(existing);
    const store = createStore();
    await store.add({ ...sampleResult, forgeId: 'f-new' });
    const saved = mockUpdate.mock.calls[0][1] as ForgeExecutionResult[];
    expect(saved).toHaveLength(50);
    expect(saved[0].forgeId).toBe('f-new');
    expect(saved[49].forgeId).toBe('f-48');
  });

  it('should return recent 10 for display', () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({ ...sampleResult, forgeId: `f-${i}` }));
    mockGet.mockReturnValue(existing);
    const store = createStore();
    const recent = store.listRecent();
    expect(recent).toHaveLength(10);
    expect(recent[0].forgeId).toBe('f-0');
  });

  it('should clear all history', async () => {
    const store = createStore();
    await store.clear();
    expect(mockUpdate).toHaveBeenCalledWith('forge:history', []);
  });
});
