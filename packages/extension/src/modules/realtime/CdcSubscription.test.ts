import { describe, it, expect, vi } from 'vitest';
import { CdcSubscription } from './CdcSubscription';
import { SubscriptionRefused, type CometdTransport } from './cometdTransport';
import type { ChangeEvent } from './changeEvent';

/** A transport the test drives: what the org accepts, and what it sends. */
function mockTransport(
  refuse: (channel: string, from: number) => string | undefined = () => undefined,
) {
  const handlers = new Map<string, (message: unknown) => void>();
  const subscribe = vi.fn(
    async (channel: string, from: number, onMessage: (message: unknown) => void) => {
      const answer = refuse(channel, from);
      if (answer) throw new SubscriptionRefused(channel, answer);
      handlers.set(channel, onMessage);
    },
  );
  const transport: CometdTransport = {
    subscribe,
    onDown: vi.fn(),
    disconnect: vi.fn(),
  };
  const send = (channel: string, message: unknown): void => handlers.get(channel)?.(message);
  return { transport, subscribe, send };
}

function replayStore(stored: Record<string, number> = {}) {
  return { get: (channel: string) => stored[channel] };
}

const leadUpdate = {
  event: { replayId: 5 },
  payload: {
    ChangeEventHeader: {
      entityName: 'Lead',
      changeType: 'UPDATE',
      recordIds: ['00Q000000000001AAA'],
      commitTimestamp: 1_790_000_000_000,
      changedFields: ['Title'],
    },
    Title: 'Buyer',
  },
};

describe('CdcSubscription', () => {
  it('subscribes each object from where the last session stopped, new events otherwise', async () => {
    const { transport, subscribe } = mockTransport();
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore({ '/data/LeadChangeEvent': 30_071_891 }),
      onEvent: vi.fn(),
      onUnreadable: vi.fn(),
    });

    const outcome = await subscription.open(['Lead', 'Contact']);

    expect(outcome).toEqual({ subscribed: ['Lead', 'Contact'], refused: [], notes: [] });
    expect(subscribe.mock.calls.map(([channel, from]) => [channel, from])).toEqual([
      ['/data/LeadChangeEvent', 30_071_891],
      ['/data/ContactChangeEvent', -1],
    ]);
  });

  it('keeps the org’s answer for an object it does not publish, and subscribes the rest', async () => {
    const { transport } = mockTransport((channel) =>
      channel === '/data/AccountChangeEvent'
        ? '403::User not allowed to subscribe CDC without required permissions'
        : undefined,
    );
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore(),
      onEvent: vi.fn(),
      onUnreadable: vi.fn(),
    });

    const outcome = await subscription.open(['Account', 'Lead']);

    expect(outcome.subscribed).toEqual(['Lead']);
    expect(outcome.refused).toEqual([
      {
        objectApiName: 'Account',
        reason: '403::User not allowed to subscribe CDC without required permissions',
      },
    ]);
  });

  it('replays what the org still holds when the stored point is gone, and says so', async () => {
    const { transport, subscribe } = mockTransport((_channel, from) =>
      from === 12
        ? '400::The replayId {12} you provided was invalid. Please provide a valid ID, -2 to replay all events, or -1 to replay only new events.'
        : undefined,
    );
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore({ '/data/LeadChangeEvent': 12 }),
      onEvent: vi.fn(),
      onUnreadable: vi.fn(),
    });

    const outcome = await subscription.open(['Lead']);

    expect(subscribe.mock.calls.map(([, from]) => from)).toEqual([12, -2]);
    expect(outcome.subscribed).toEqual(['Lead']);
    expect(outcome.notes).toHaveLength(1);
    expect(outcome.notes[0]).toContain('replay id 12');
    expect(outcome.notes[0]).toContain('up to three days');
  });

  it('does not retry a refused channel as if its replay id were the problem', async () => {
    const { transport, subscribe } = mockTransport(
      () => '403::User not allowed to subscribe CDC without required permissions',
    );
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore({ '/data/CaseChangeEvent': 99 }),
      onEvent: vi.fn(),
      onUnreadable: vi.fn(),
    });

    const outcome = await subscription.open(['Case']);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(outcome.refused).toHaveLength(1);
  });

  it('hands every change on, parsed, and reports a message that is not one', async () => {
    const { transport, send } = mockTransport();
    const onEvent = vi.fn<(event: ChangeEvent) => void>();
    const onUnreadable = vi.fn();
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore(),
      onEvent,
      onUnreadable,
    });
    await subscription.open(['Lead']);

    send('/data/LeadChangeEvent', leadUpdate);
    send('/data/LeadChangeEvent', { event: { replayId: 6 } });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      replayId: 5,
      objectApiName: 'Lead',
      values: { Title: 'Buyer' },
    });
    expect(onUnreadable).toHaveBeenCalledWith(
      '/data/LeadChangeEvent',
      expect.stringContaining('not a change event'),
    );
  });

  it('closes the connection under its subscriptions', async () => {
    const { transport } = mockTransport();
    const subscription = new CdcSubscription({
      transport,
      replayStore: replayStore(),
      onEvent: vi.fn(),
      onUnreadable: vi.fn(),
    });
    await subscription.open(['Lead']);

    subscription.close();

    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });
});
