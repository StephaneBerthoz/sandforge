import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CDCReplicator } from './CDCReplicator';
import type { CDCReplicatorDeps, ReplicatorApplyResult } from './CDCReplicator';
import type { CDCEvent } from '@sandforge/shared';

function createEvent(overrides?: Partial<CDCEvent>): CDCEvent {
  return {
    replayId: 1,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: ['001xx0000001234'],
    changedFields: { Name: 'Acme Corp', Industry: 'Technology' },
    commitTimestamp: new Date(Date.now() - 500).toISOString(),
    commitUser: '005xx0000001111',
    transactionKey: 'txn-abc-123',
    ...overrides,
  };
}

function createSuccessResult(recordId = '001xx0000001234'): ReplicatorApplyResult {
  return { recordId, success: true };
}

function createFailureResult(recordId = '001xx0000001234'): ReplicatorApplyResult {
  return { recordId, success: false, error: 'FIELD_INTEGRITY_EXCEPTION' };
}

function createMockDeps(overrides?: Partial<CDCReplicatorDeps>): CDCReplicatorDeps {
  return {
    applyFn: vi.fn().mockResolvedValue([createSuccessResult()]),
    targetQueryFn: vi.fn().mockResolvedValue([]),
    fieldMapping: {
      apply: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
      applyAddOns: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
    } as unknown as CDCReplicatorDeps['fieldMapping'],
    conflictStrategy: 'source_wins',
    fieldMappings: {},
    flushIntervalMs: 100,
    maxBatchSize: 50,
    ...overrides,
  };
}

describe('CDCReplicator', () => {
  let deps: CDCReplicatorDeps;
  let replicator: CDCReplicator;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
    replicator = new CDCReplicator(deps);
  });

  afterEach(() => {
    void replicator.stop();
    vi.useRealTimers();
  });

  describe('receive and flush', () => {
    it('should buffer received events', () => {
      replicator.receive(createEvent());

      expect(replicator.getBufferedCount()).toBe(1);
    });

    it('should flush buffered events to the apply function', async () => {
      replicator.receive(createEvent());
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledWith(
        'Account',
        'update',
        expect.arrayContaining([expect.objectContaining({ Id: '001xx0000001234' })]),
      );
    });

    it('should clear buffer after flush', async () => {
      replicator.receive(createEvent());
      await replicator.flush();

      expect(replicator.getBufferedCount()).toBe(0);
    });

    it('should group events by object name', async () => {
      replicator.receive(createEvent({ objectApiName: 'Account' }));
      replicator.receive(createEvent({ objectApiName: 'Contact', recordIds: ['003xx0000001111'] }));
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledTimes(2);
    });

    it('should map CREATE events to insert operation', async () => {
      replicator.receive(createEvent({ changeType: 'CREATE' }));
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledWith('Account', 'insert', expect.any(Array));
    });

    it('should map DELETE events to delete operation', async () => {
      replicator.receive(createEvent({ changeType: 'DELETE' }));
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledWith('Account', 'delete', expect.any(Array));
    });

    it('should map UNDELETE events to undelete operation', async () => {
      replicator.receive(createEvent({ changeType: 'UNDELETE' }));
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledWith('Account', 'undelete', expect.any(Array));
    });
  });

  describe('automatic flush', () => {
    it('should auto-flush on timer when running', async () => {
      replicator.start();
      replicator.receive(createEvent());

      await vi.advanceTimersByTimeAsync(200);

      expect(deps.applyFn).toHaveBeenCalled();
    });

    it('should auto-flush when buffer exceeds maxBatchSize', async () => {
      deps = createMockDeps({ maxBatchSize: 2 });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent({ replayId: 1 }));
      replicator.receive(createEvent({ replayId: 2 }));

      // Wait for the auto-flush triggered by buffer overflow
      await vi.advanceTimersByTimeAsync(10);

      expect(deps.applyFn).toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('should track total applied count', async () => {
      replicator.receive(createEvent());
      await replicator.flush();

      expect(replicator.getTotalApplied()).toBe(1);
    });

    it('should track total failed count', async () => {
      deps = createMockDeps({
        applyFn: vi.fn().mockResolvedValue([createFailureResult()]),
      });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent());
      await replicator.flush();

      expect(replicator.getTotalFailed()).toBe(1);
    });

    it('should calculate replication lag', async () => {
      vi.useRealTimers();
      const eventTime = new Date(Date.now() - 1000).toISOString();
      deps = createMockDeps();
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent({ commitTimestamp: eventTime }));
      await replicator.flush();

      expect(replicator.getAverageLagMs()).toBeGreaterThan(0);
      expect(replicator.getCurrentLagMs()).toBeGreaterThan(0);
    });

    it('should return 0 lag when no events processed', () => {
      expect(replicator.getAverageLagMs()).toBe(0);
      expect(replicator.getCurrentLagMs()).toBe(0);
    });
  });

  describe('field mapping', () => {
    it('should apply field mappings when configured for the object', async () => {
      deps = createMockDeps({
        fieldMappings: {
          Account: [
            { sourceField: 'Name', targetField: 'AccountName__c', type: 'rename' },
          ],
        },
      });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent());
      await replicator.flush();

      expect(deps.fieldMapping.apply).toHaveBeenCalledWith(
        expect.objectContaining({ Name: 'Acme Corp' }),
        expect.arrayContaining([
          expect.objectContaining({ sourceField: 'Name', targetField: 'AccountName__c' }),
        ]),
      );
    });

    it('should pass through fields when no mappings configured', async () => {
      replicator.receive(createEvent());
      await replicator.flush();

      expect(deps.applyFn).toHaveBeenCalledWith(
        'Account',
        'update',
        expect.arrayContaining([
          expect.objectContaining({
            Name: 'Acme Corp',
            Industry: 'Technology',
            Id: '001xx0000001234',
          }),
        ]),
      );
    });
  });

  describe('conflict detection', () => {
    it('should check for conflicts on UPDATE events', async () => {
      const conflictHandler = vi.fn();
      deps = createMockDeps({
        onConflict: conflictHandler,
        targetQueryFn: vi.fn().mockResolvedValue([
          {
            Id: '001xx0000001234',
            Name: 'Old Name',
            LastModifiedDate: new Date(Date.now() + 10_000).toISOString(),
          },
        ]),
      });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent());
      await replicator.flush();

      expect(conflictHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ objectApiName: 'Account' }),
          targetValues: expect.objectContaining({ Name: 'Old Name' }),
        }),
      );
    });

    it('should not check conflicts for CREATE events', async () => {
      deps = createMockDeps({ onConflict: vi.fn() });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent({ changeType: 'CREATE' }));
      await replicator.flush();

      expect(deps.targetQueryFn).not.toHaveBeenCalled();
    });

    it('should skip conflict detection when no handler is set', async () => {
      replicator.receive(createEvent());
      await replicator.flush();

      expect(deps.targetQueryFn).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should call onError callback when applyFn throws', async () => {
      const onError = vi.fn();
      const applyError = new Error('Network timeout');
      deps = createMockDeps({
        applyFn: vi.fn().mockRejectedValue(applyError),
        onError,
      });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent());
      await replicator.flush();

      expect(onError).toHaveBeenCalledWith(
        'Account',
        'update',
        applyError,
        1,
      );
      expect(replicator.getTotalFailed()).toBe(1);
    });

    it('should call onApplyResult for each event after apply', async () => {
      const onApplyResult = vi.fn();
      deps = createMockDeps({
        applyFn: vi.fn().mockResolvedValue([
          createSuccessResult(),
          createFailureResult('001xx0000005678'),
        ]),
        onApplyResult,
      });
      replicator = new CDCReplicator(deps);

      replicator.receive(createEvent({ replayId: 10 }));
      replicator.receive(createEvent({ replayId: 11, recordIds: ['001xx0000005678'] }));
      await replicator.flush();

      expect(onApplyResult).toHaveBeenCalledWith(10, true, undefined);
      expect(onApplyResult).toHaveBeenCalledWith(11, false, 'FIELD_INTEGRITY_EXCEPTION');
    });
  });

  describe('timings ring buffer', () => {
    it('should correctly wrap after exceeding capacity', async () => {
      vi.useRealTimers();
      const eventCount = 1005;
      deps = createMockDeps({
        applyFn: vi.fn().mockImplementation(
          (_obj: string, _op: string, records: Record<string, unknown>[]) =>
            Promise.resolve(records.map((r) => ({ recordId: String(r.Id), success: true }))),
        ),
      });
      replicator = new CDCReplicator(deps);

      // Apply events one-by-one and flush individually to avoid batch grouping issues
      for (let i = 0; i < eventCount; i++) {
        replicator.receive(
          createEvent({
            replayId: i,
            commitTimestamp: new Date(Date.now() - 500).toISOString(),
          }),
        );
        await replicator.flush();
      }

      expect(replicator.getTotalApplied()).toBe(eventCount);
      // Ring buffer should still work after wrapping
      expect(replicator.getAverageLagMs()).toBeGreaterThan(0);
      expect(replicator.getCurrentLagMs()).toBeGreaterThan(0);
    });

    it('should report correct average lag with ring buffer', async () => {
      vi.useRealTimers();
      deps = createMockDeps();
      replicator = new CDCReplicator(deps);

      const eventTime = new Date(Date.now() - 1000).toISOString();
      replicator.receive(createEvent({ commitTimestamp: eventTime }));
      await replicator.flush();

      const avgLag = replicator.getAverageLagMs();
      expect(avgLag).toBeGreaterThanOrEqual(900);
      expect(avgLag).toBeLessThan(2000);
    });
  });

  describe('start and stop', () => {
    it('should report running state after start', () => {
      replicator.start();

      expect(replicator.isRunning()).toBe(true);
    });

    it('should not double-start', () => {
      replicator.start();
      replicator.start();

      expect(replicator.isRunning()).toBe(true);
    });

    it('should flush remaining events on stop', async () => {
      replicator.start();
      replicator.receive(createEvent());

      await replicator.stop();

      expect(deps.applyFn).toHaveBeenCalled();
      expect(replicator.isRunning()).toBe(false);
    });
  });
});
