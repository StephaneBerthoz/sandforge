import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RealtimeSession,
  type ChangeApplier,
  type FeedEvent,
  type SessionSnapshot,
} from './RealtimeSession';
import { SubscriptionRefused, type CometdTransport } from './cometdTransport';
import { REALTIME_CLIENT_ID, type ChangeEvent } from './changeEvent';
import type { HeldChange } from './RealtimeApplier';

/** A CometD connection the test drives: which channels the org accepts, what it sends, and when it gives up. */
function fakeTransport(refused: Record<string, string> = {}) {
  const handlers = new Map<string, (message: unknown) => void>();
  let down: ((reason: string) => void) | undefined;
  const transport: CometdTransport = {
    subscribe: vi.fn(async (channel: string, _from: number, onMessage: (m: unknown) => void) => {
      if (refused[channel]) throw new SubscriptionRefused(channel, refused[channel]);
      handlers.set(channel, onMessage);
    }),
    onDown: (listener) => {
      down = listener;
    },
    disconnect: vi.fn(),
  };
  return {
    transport,
    send: (channel: string, message: unknown) => handlers.get(channel)?.(message),
    goDown: (reason: string) => down?.(reason),
  };
}

/** A change event message on the wire. */
function wire(
  replayId: number,
  entityName = 'Lead',
  header: Record<string, unknown> = {},
  fields: Record<string, unknown> = { Title: `T${replayId}` },
) {
  return {
    event: { replayId },
    payload: {
      ChangeEventHeader: {
        entityName,
        changeType: 'UPDATE',
        recordIds: [`00Q00000000000${replayId}AA`],
        commitTimestamp: 1_000,
        changedFields: Object.keys(fields),
        ...header,
      },
      ...fields,
    },
  };
}

function sink() {
  const batches: FeedEvent[][] = [];
  const conflicts: HeldChange[] = [];
  const statuses: SessionSnapshot[] = [];
  return {
    batches,
    conflicts,
    statuses,
    sink: {
      events: (batch: FeedEvent[]) => batches.push(batch),
      conflict: (change: HeldChange) => conflicts.push(change),
      status: (snapshot: SessionSnapshot) => statuses.push(snapshot),
    },
  };
}

function replayStore() {
  const saved: Array<Map<string, number>> = [];
  return {
    saved,
    get: vi.fn(() => undefined),
    save: (positions: Map<string, number>) => saved.push(new Map(positions)),
  };
}

function applying(
  results: (events: readonly ChangeEvent[]) => ReturnType<ChangeApplier['apply']>,
): ChangeApplier {
  return { apply: vi.fn(results), resolve: vi.fn() };
}

const heldLead: HeldChange = {
  conflictId: 'Lead:00Q000000000001AA:3',
  objectApiName: 'Lead',
  recordId: '00Q000000000001AA',
  replayId: 3,
  changeType: 'UPDATE',
  kind: 'upsert',
  record: { Title: 'Buyer', Ext__c: 'K1' },
  targetId: '00QTARGET0000001AA',
  targetValues: { Title: 'Old' },
  targetLastModified: '2026-09-23T11:00:00.000Z',
};

describe('RealtimeSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function session(
    options: {
      transport?: ReturnType<typeof fakeTransport>;
      appliers?: Map<string, ChangeApplier>;
      watched?: string[];
      maxBatchSize?: number;
    } = {},
  ) {
    const transport = options.transport ?? fakeTransport();
    const out = sink();
    const store = replayStore();
    const openTransport = vi.fn(async () => transport.transport);
    const subject = new RealtimeSession(
      {
        sessionId: 'session-1',
        watchedObjects: options.watched ?? ['Lead'],
        appliers: options.appliers ?? new Map(),
        flushIntervalMs: 150,
        maxBatchSize: options.maxBatchSize ?? 100,
      },
      { openTransport, replayStore: store, sink: out.sink, log: vi.fn() },
    );
    return { subject, transport, out, store, openTransport };
  }

  it('subscribes to the watched objects and says what the org refused', async () => {
    const transport = fakeTransport({
      '/data/AccountChangeEvent':
        '403::User not allowed to subscribe CDC without required permissions',
    });
    const { subject } = session({ transport, watched: ['Lead', 'Account'] });

    const outcome = await subject.start();

    expect(outcome.subscribed).toEqual(['Lead']);
    expect(subject.snapshot()).toEqual({
      status: 'syncing',
      sessionId: 'session-1',
      watchedObjects: ['Lead'],
      refused: [
        {
          objectApiName: 'Account',
          reason: '403::User not allowed to subscribe CDC without required permissions',
        },
      ],
      notes: [],
    });
  });

  it('ends in error, disconnected, when the org refuses every watched object', async () => {
    const transport = fakeTransport({ '/data/CaseChangeEvent': '403::refused' });
    const { subject } = session({ transport, watched: ['Case'] });

    await subject.start();

    expect(subject.snapshot().status).toBe('error');
    expect(subject.snapshot().error).toContain('refused a subscription to every watched object');
    expect(transport.transport.disconnect).toHaveBeenCalledTimes(1);
    expect(subject.running).toBe(false);
  });

  it('shows a change of an object it only watches, and applies nothing', async () => {
    const { subject, transport, out, store } = session();
    await subject.start();

    transport.send('/data/LeadChangeEvent', wire(1));
    expect(out.batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);

    expect(out.batches).toHaveLength(1);
    expect(out.batches[0][0]).toMatchObject({
      replayId: 1,
      objectApiName: 'Lead',
      changeType: 'UPDATE',
      changedFields: { Title: 'T1' },
      applied: false,
      outcome: 'watched',
    });
    expect(store.saved).toEqual([new Map([['/data/LeadChangeEvent', 1]])]);
  });

  it('applies the changes of an applied object, in one batch, and stores where it got to', async () => {
    const applier = applying(async (events) => ({
      results: events.map((e) =>
        e.replayId === 2
          ? { outcome: 'failed' as const, error: 'refused' }
          : { outcome: 'applied' as const },
      ),
      held: [],
    }));
    const { subject, transport, out, store } = session({ appliers: new Map([['Lead', applier]]) });
    await subject.start();

    transport.send('/data/LeadChangeEvent', wire(1));
    transport.send('/data/LeadChangeEvent', wire(2));
    await vi.advanceTimersByTimeAsync(150);

    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applier.apply).mock.calls[0][0].map((e) => e.replayId)).toEqual([1, 2]);
    expect(out.batches[0].map((e) => [e.replayId, e.outcome, e.applied, e.error])).toEqual([
      [1, 'applied', true, undefined],
      [2, 'failed', false, 'refused'],
    ]);
    expect(store.saved).toEqual([new Map([['/data/LeadChangeEvent', 2]])]);
    expect(subject.metrics()).toMatchObject({
      eventsReceived: 2,
      eventsApplied: 1,
      eventsFailed: 1,
      eventsPerMinute: 2,
      errorRate: 50,
    });
  });

  it('never applies a change its own write caused', async () => {
    const applier = applying(async (events) => ({
      results: events.map(() => ({ outcome: 'applied' as const })),
      held: [],
    }));
    const { subject, transport, out } = session({ appliers: new Map([['Lead', applier]]) });
    await subject.start();

    transport.send(
      '/data/LeadChangeEvent',
      wire(1, 'Lead', {
        changeOrigin: `com/salesforce/api/rest/66.0;client=${REALTIME_CLIENT_ID}`,
      }),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(applier.apply).not.toHaveBeenCalled();
    expect(out.batches[0][0].outcome).toBe('own-write');
  });

  it('processes a full batch without waiting for the interval', async () => {
    const { subject, transport, out } = session({ maxBatchSize: 2 });
    await subject.start();

    transport.send('/data/LeadChangeEvent', wire(1));
    transport.send('/data/LeadChangeEvent', wire(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(out.batches).toHaveLength(1);
    expect(out.batches[0]).toHaveLength(2);
  });

  it('reports every change of a batch the applier could not write at all', async () => {
    const applier = applying(async () => {
      throw new Error('INVALID_SESSION_ID: Session expired or invalid');
    });
    const { subject, transport, out } = session({ appliers: new Map([['Lead', applier]]) });
    await subject.start();

    transport.send('/data/LeadChangeEvent', wire(1));
    await vi.advanceTimersByTimeAsync(150);

    expect(out.batches[0][0]).toMatchObject({
      outcome: 'failed',
      error: 'INVALID_SESSION_ID: Session expired or invalid',
    });
  });

  it('pushes a held change and decides it through the applier that held it', async () => {
    const applier: ChangeApplier = {
      apply: vi.fn(async () => ({ results: [{ outcome: 'held' as const }], held: [heldLead] })),
      resolve: vi.fn(async () => ({
        success: true,
        resolvedValues: { Title: 'Buyer', Ext__c: 'K1' },
      })),
    };
    const { subject, transport, out } = session({ appliers: new Map([['Lead', applier]]) });
    await subject.start();
    transport.send('/data/LeadChangeEvent', wire(3));
    await vi.advanceTimersByTimeAsync(150);

    expect(out.conflicts).toEqual([heldLead]);
    const decided = await subject.resolveConflict(heldLead.conflictId, 'source_wins');
    expect(decided.success).toBe(true);
    expect(applier.resolve).toHaveBeenCalledWith(heldLead, 'source_wins', undefined);

    const again = await subject.resolveConflict(heldLead.conflictId, 'source_wins');
    expect(again.success).toBe(false);
    expect(again.error).toContain('no longer held');
  });

  it('stops without processing what it had not got to, so the next session replays it', async () => {
    const applier: ChangeApplier = {
      apply: vi.fn(async () => ({ results: [{ outcome: 'held' as const }], held: [heldLead] })),
      resolve: vi.fn(),
    };
    const { subject, transport, out, store } = session({ appliers: new Map([['Lead', applier]]) });
    await subject.start();
    transport.send('/data/LeadChangeEvent', wire(3));
    await vi.advanceTimersByTimeAsync(150);
    transport.send('/data/LeadChangeEvent', wire(4));

    const dropped = await subject.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(dropped).toBe(1);
    expect(out.batches).toHaveLength(1);
    expect(store.saved).toEqual([new Map([['/data/LeadChangeEvent', 3]])]);
    expect(transport.transport.disconnect).toHaveBeenCalledTimes(1);
    expect(subject.snapshot().status).toBe('disconnected');
  });

  it('reconnects a connection the org closed, from the stored points, and says so', async () => {
    const { subject, transport, out, openTransport } = session();
    await subject.start();

    transport.goDown('401::Authentication invalid');
    await vi.advanceTimersByTimeAsync(0);
    expect(out.statuses[0]).toMatchObject({ status: 'connecting' });
    expect(out.statuses[0].error).toContain('401::Authentication invalid');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(openTransport).toHaveBeenCalledTimes(2);
    expect(out.statuses[1]).toMatchObject({ status: 'syncing', watchedObjects: ['Lead'] });
    expect(out.statuses[1].error).toBeUndefined();
  });

  it('gives up after its reconnection attempts, in error, saying why', async () => {
    const { subject, transport, out, openTransport } = session();
    await subject.start();
    openTransport.mockRejectedValue(new Error('No credentials for org'));

    transport.goDown('401::Authentication invalid');
    await vi.advanceTimersByTimeAsync(60_000);

    const last = out.statuses[out.statuses.length - 1];
    expect(last.status).toBe('error');
    expect(last.error).toContain('could not be reopened');
  });
});
