import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { useSyncHistoryStore } from './useSyncHistoryStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Envelope shape posted to the extension host (see sendBridgeMessage). */
interface PostedEnvelope {
  protocolVersion: number;
  correlationId?: string;
  payload: { type: string; payload?: Record<string, unknown> };
}

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
    configId: 'cfg-1',
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
    mockPostMessage.mockClear();
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

  it('asks the host to save the export instead of clicking a detached anchor', () => {
    // The previous version of this test spied on createElement('a') and its
    // click — it asserted the mechanism that did not work rather than the
    // outcome. A webview is sandboxed without `allow-downloads`, so that click
    // frequently wrote nothing while the store considered the export done.
    mockPostMessage.mockClear();

    useSyncHistoryStore.getState().handleMessage({
      type: 'sync:history:export:response',
      payload: { data: 'id,name\n1,test', format: 'csv' },
    });

    const sent = mockPostMessage.mock.calls
      .map((c) => (c[0] as PostedEnvelope).payload)
      .filter((m) => m.type === 'file:save');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      suggestedName: 'sync-history.csv',
      content: 'id,name\n1,test',
      extensions: ['csv'],
    });
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

  describe('outbound bridge messages', () => {
    it('fetchHistory posts an enveloped sync:history:list', () => {
      useSyncHistoryStore.getState().fetchHistory();

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      const envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
      expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(envelope.payload.type).toBe('sync:history:list');
    });

    it('fetchDetail posts an enveloped sync:history:detail with entryId', () => {
      useSyncHistoryStore.getState().fetchDetail('h-1');

      const envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
      expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(envelope.payload.type).toBe('sync:history:detail');
      expect(envelope.payload.payload).toEqual({ entryId: 'h-1' });
    });

    it('rerun posts an enveloped sync:history:rerun with entryId', () => {
      useSyncHistoryStore.getState().rerun('h-2');

      const envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
      expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(envelope.payload.type).toBe('sync:history:rerun');
      expect(envelope.payload.payload).toEqual({ entryId: 'h-2' });
    });

    it('exportHistory posts an enveloped sync:history:export with format and ids', () => {
      useSyncHistoryStore.getState().exportHistory('csv', ['h-1', 'h-2']);

      const envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
      expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(envelope.payload.type).toBe('sync:history:export');
      expect(envelope.payload.payload).toEqual({ format: 'csv', entryIds: ['h-1', 'h-2'] });
    });
  });
});
