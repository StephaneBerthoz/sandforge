import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ActiveOperation, BaseMessage } from '@sandforge/shared';
import { MessageBroker } from './MessageBroker';
import { WebviewStateSync } from './WebviewStateSync';
import type { WebviewState, StateSyncMessage } from './WebviewStateSync';

/** Create a minimal ActiveOperation fixture. */
function makeOp(id: string): ActiveOperation {
  return {
    operationId: id,
    module: 'sync',
    description: `Operation ${id}`,
    status: 'running',
    progressPercent: 0,
    startedAt: Date.now(),
  };
}

describe('WebviewStateSync', () => {
  let broker: MessageBroker;
  let stateSync: WebviewStateSync;
  let postToWebviewSpy: MockInstance<(message: BaseMessage) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new MessageBroker();
    stateSync = new WebviewStateSync(broker);
    postToWebviewSpy = vi.spyOn(broker, 'postToWebview');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Flush the debounce timer so the push fires. */
  function flushDebounce(): void {
    vi.advanceTimersByTime(20);
  }

  describe('getState', () => {
    it('should return the default initial state', () => {
      const state = stateSync.getState();

      expect(state).toEqual({
        orgs: [],
        settings: {},
        activeOperations: [],
        extensionReady: false,
        selectedOrgId: null,
      } satisfies WebviewState);
    });
  });

  describe('updateState', () => {
    it('should merge a partial update into the current state', () => {
      stateSync.updateState({ extensionReady: true });

      const state = stateSync.getState();
      expect(state.extensionReady).toBe(true);
      expect(state.orgs).toEqual([]);
      expect(state.settings).toEqual({});
      expect(state.activeOperations).toEqual([]);
    });

    it('should replace array values rather than merging them', () => {
      const op1 = makeOp('op-1');
      const op2 = makeOp('op-2');
      const op3 = makeOp('op-3');

      stateSync.updateState({ activeOperations: [op1] });
      stateSync.updateState({ activeOperations: [op2, op3] });

      expect(stateSync.getState().activeOperations).toEqual([op2, op3]);
    });

    it('should push state to webviews after debounce', () => {
      stateSync.updateState({ extensionReady: true });

      // Not yet pushed (debounced)
      expect(postToWebviewSpy).not.toHaveBeenCalled();

      flushDebounce();
      expect(postToWebviewSpy).toHaveBeenCalledOnce();
    });

    it('should batch rapid updates into a single push', () => {
      const op1 = makeOp('op-1');

      stateSync.updateState({ extensionReady: true });
      stateSync.updateState({ activeOperations: [op1] });
      stateSync.updateState({ settings: { theme: 'dark' } });

      flushDebounce();

      // Only one push for all three updates
      expect(postToWebviewSpy).toHaveBeenCalledOnce();
      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      expect(sentMessage.payload.extensionReady).toBe(true);
      expect(sentMessage.payload.activeOperations).toEqual([op1]);
      expect(sentMessage.payload.settings).toEqual({ theme: 'dark' });
    });

    it('should send the updated state in the pushed message', () => {
      const op1 = makeOp('op-1');

      stateSync.updateState({ extensionReady: true, activeOperations: [op1] });
      flushDebounce();

      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      expect(sentMessage.type).toBe('state:sync');
      expect(sentMessage.payload.extensionReady).toBe(true);
      expect(sentMessage.payload.activeOperations).toEqual([op1]);
    });
  });

  describe('pushState', () => {
    it('should post a state:sync message via the broker', () => {
      stateSync.pushState();

      expect(postToWebviewSpy).toHaveBeenCalledOnce();
      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      expect(sentMessage.type).toBe('state:sync');
      expect(sentMessage.id).toMatch(/^state-sync-/);
      expect(sentMessage.timestamp).toBeGreaterThan(0);
    });

    it('should include the full state as the payload', () => {
      stateSync.updateState({ extensionReady: true });
      flushDebounce();
      postToWebviewSpy.mockClear();

      stateSync.pushState();

      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      expect(sentMessage.payload).toEqual({
        orgs: [],
        settings: {},
        activeOperations: [],
        extensionReady: true,
        selectedOrgId: null,
      });
    });

    it('should send a shallow copy of the state, not a reference', () => {
      const op1 = makeOp('op-1');
      const op2 = makeOp('op-2');

      stateSync.updateState({ activeOperations: [op1] });
      flushDebounce();
      postToWebviewSpy.mockClear();

      stateSync.pushState();

      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      stateSync.updateState({ activeOperations: [op2] });

      expect(sentMessage.payload.activeOperations).toEqual([op1]);
    });

    it('should assign unique ids to successive messages', () => {
      stateSync.pushState();
      stateSync.pushState();

      const id1 = (postToWebviewSpy.mock.calls[0][0] as StateSyncMessage).id;
      const id2 = (postToWebviewSpy.mock.calls[1][0] as StateSyncMessage).id;

      expect(id1).not.toBe(id2);
    });
  });

  describe('setActiveOperations', () => {
    it('should update state with ActiveOperation[] and trigger push', () => {
      const op1 = makeOp('op-1');
      const op2 = makeOp('op-2');

      stateSync.setActiveOperations([op1, op2]);

      expect(stateSync.getState().activeOperations).toEqual([op1, op2]);

      flushDebounce();
      expect(postToWebviewSpy).toHaveBeenCalledOnce();
      const sentMessage = postToWebviewSpy.mock.calls[0][0] as StateSyncMessage;
      expect(sentMessage.payload.activeOperations).toEqual([op1, op2]);
    });

    it('should support ActiveOperation[] shape with all fields', () => {
      const op: ActiveOperation = {
        operationId: 'op-full',
        module: 'seed',
        description: 'Seed Contact 10K records',
        status: 'completed',
        progressPercent: 100,
        startedAt: 1711641600000,
        completedAt: 1711641660000,
        resultSummary: '10,000 records seeded',
      };

      stateSync.setActiveOperations([op]);

      const state = stateSync.getState();
      expect(state.activeOperations).toHaveLength(1);
      expect(state.activeOperations[0].operationId).toBe('op-full');
      expect(state.activeOperations[0].completedAt).toBe(1711641660000);
      expect(state.activeOperations[0].resultSummary).toBe('10,000 records seeded');
    });

    it('should replace previous operations', () => {
      const op1 = makeOp('op-1');
      const op2 = makeOp('op-2');

      stateSync.setActiveOperations([op1]);
      stateSync.setActiveOperations([op2]);

      expect(stateSync.getState().activeOperations).toEqual([op2]);
    });
  });

  describe('reset', () => {
    it('should restore state to initial defaults', () => {
      const op1 = makeOp('op-1');

      stateSync.updateState({
        extensionReady: true,
        orgs: [{ id: 'org-1' }],
        settings: { theme: 'dark' },
        activeOperations: [op1],
      });
      flushDebounce();

      stateSync.reset();

      expect(stateSync.getState()).toEqual({
        orgs: [],
        settings: {},
        activeOperations: [],
        extensionReady: false,
        selectedOrgId: null,
      });
    });

    it('should not push state to webviews on reset', () => {
      stateSync.updateState({ extensionReady: true });
      flushDebounce();
      postToWebviewSpy.mockClear();

      stateSync.reset();
      flushDebounce();

      expect(postToWebviewSpy).not.toHaveBeenCalled();
    });
  });
});
