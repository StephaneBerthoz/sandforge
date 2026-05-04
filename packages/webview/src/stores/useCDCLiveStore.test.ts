import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCDCLiveStore } from './useCDCLiveStore';
import type { CDCFeedEvent } from './useCDCLiveStore';
import { useConflictStore } from './useConflictStore';

/** Create a mock CDCFeedEvent with the given replay ID. */
function makeMockEvent(replayId: number): CDCFeedEvent {
  return {
    replayId,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: [`001${String(replayId).padStart(15, '0')}`],
    commitTimestamp: `2026-03-27T00:00:${String(replayId % 60).padStart(2, '0')}Z`,
    changedFields: { Name: `Account ${replayId}` },
    commitUser: '005xx000001Sv0pAAC',
    applied: false,
  };
}

/** Post a mock postMessage from the extension to the window. */
const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

describe('useCDCLiveStore', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
    mockPostMessage.mockClear();
  });

  it('should start with default state', () => {
    const state = useCDCLiveStore.getState();
    expect(state.status).toBe('disconnected');
    expect(state.watchedObjects).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.eventCount).toBe(0);
    expect(state.sourceOrgId).toBeNull();
    expect(state.targetOrgId).toBeNull();
  });

  it('should push events to ring buffer and retain only last 5000 when overflow', () => {
    const batch: CDCFeedEvent[] = [];
    for (let i = 1; i <= 6000; i++) {
      batch.push(makeMockEvent(i));
    }
    useCDCLiveStore.getState().pushEvents(batch);

    const state = useCDCLiveStore.getState();
    expect(state.events).toHaveLength(5000);
    expect(state.eventCount).toBe(6000);
    // First event should be #1001 (oldest retained)
    expect(state.events[0].replayId).toBe(1001);
    // Last event should be #6000 (newest)
    expect(state.events[4999].replayId).toBe(6000);
  });

  it('should push a batch of events and maintain order', () => {
    const batch = [makeMockEvent(10), makeMockEvent(20), makeMockEvent(30)];
    useCDCLiveStore.getState().pushEvents(batch);

    const state = useCDCLiveStore.getState();
    expect(state.events).toHaveLength(3);
    expect(state.events[0].replayId).toBe(10);
    expect(state.events[1].replayId).toBe(20);
    expect(state.events[2].replayId).toBe(30);
    expect(state.eventCount).toBe(3);
  });

  it('should toggle auto-sync and create entry with default strategy', () => {
    useCDCLiveStore.getState().toggleAutoSync('Account');

    const state = useCDCLiveStore.getState();
    expect(state.autoSyncObjects['Account']).toEqual({
      enabled: true,
      conflictStrategy: 'source_wins',
    });

    // Toggle again removes it
    useCDCLiveStore.getState().toggleAutoSync('Account');
    expect(useCDCLiveStore.getState().autoSyncObjects['Account']).toBeUndefined();
  });

  it('should set conflict strategy for an existing auto-sync entry', () => {
    useCDCLiveStore.getState().toggleAutoSync('Contact');
    useCDCLiveStore.getState().setConflictStrategy('Contact', 'newest_wins');

    const state = useCDCLiveStore.getState();
    expect(state.autoSyncObjects['Contact'].conflictStrategy).toBe('newest_wins');
  });

  it('should clear events and reset ring buffer', () => {
    useCDCLiveStore.getState().pushEvents([makeMockEvent(1), makeMockEvent(2)]);
    expect(useCDCLiveStore.getState().events).toHaveLength(2);

    useCDCLiveStore.getState().clearEvents();

    const state = useCDCLiveStore.getState();
    expect(state.events).toEqual([]);
    expect(state.eventCount).toBe(0);
  });

  it('should post realtime:start message when startStream is called', () => {
    useCDCLiveStore.getState().setOrgs('org-src', 'org-tgt');
    useCDCLiveStore.getState().setWatchedObjects(['Account', 'Contact']);
    useCDCLiveStore.getState().startStream();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const msg = mockPostMessage.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(msg.type).toBe('realtime:start');
    expect(msg.payload.sourceOrgId).toBe('org-src');
    expect(msg.payload.targetOrgId).toBe('org-tgt');
    expect(msg.payload.watchedObjects).toEqual(['Account', 'Contact']);
    expect(useCDCLiveStore.getState().status).toBe('connecting');
  });

  it('should update status via setStatus', () => {
    useCDCLiveStore.getState().setStatus('syncing');
    expect(useCDCLiveStore.getState().status).toBe('syncing');

    useCDCLiveStore.getState().setStatus('error');
    expect(useCDCLiveStore.getState().status).toBe('error');
  });

  it('should set orgs via setOrgs', () => {
    useCDCLiveStore.getState().setOrgs('src-1', 'tgt-1');

    const state = useCDCLiveStore.getState();
    expect(state.sourceOrgId).toBe('src-1');
    expect(state.targetOrgId).toBe('tgt-1');
  });

  it('should post realtime:stop message when stopStream is called', () => {
    useCDCLiveStore.getState().stopStream();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const msg = mockPostMessage.mock.calls[0][0] as { type: string };
    expect(msg.type).toBe('realtime:stop');
  });

  it('should forward realtime:conflict messages to useConflictStore', () => {
    // Reset conflict store
    useConflictStore.setState({
      conflicts: [],
      selectedConflictId: null,
      filterObject: null,
      filterType: null,
    });

    // Simulate a realtime:conflict message from the extension
    const conflictPayload = {
      objectApiName: 'Account',
      recordIds: ['001000000000001'],
      changeType: 'UPDATE',
      sourceValues: { Name: 'Source Name', Industry: 'Tech' },
      targetValues: { Name: 'Target Name', Industry: 'Tech' },
      replayId: 42,
      targetLastModified: '2026-03-27T12:00:00Z',
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'realtime:conflict', payload: conflictPayload },
      }),
    );

    const conflicts = useConflictStore.getState().conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('Account:001000000000001:42');
    expect(conflicts[0].objectApiName).toBe('Account');
    expect(conflicts[0].recordId).toBe('001000000000001');
    expect(conflicts[0].conflictType).toBe('edit/edit');
    expect(conflicts[0].conflictFields).toContain('Name');
    expect(conflicts[0].conflictFields).not.toContain('Industry'); // Same value, not a conflict
    expect(conflicts[0].resolved).toBe(false);
    expect(conflicts[0].timestamp).toBe('2026-03-27T12:00:00Z');
  });
});
