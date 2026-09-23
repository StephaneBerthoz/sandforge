import { describe, it, expect, vi } from 'vitest';
import {
  fayeTransport,
  SubscriptionRefused,
  type BayeuxExtension,
  type BayeuxMessage,
  type StreamingClientFactory,
} from './cometdTransport';

/**
 * A Faye client that runs its extension the way Faye does: every message out
 * goes through `outgoing`, every answer in through `incoming`.
 */
function fakeStreaming(answer: (subscribe: BayeuxMessage) => BayeuxMessage) {
  let extension: BayeuxExtension | undefined;
  const sent: BayeuxMessage[] = [];
  const listeners = new Map<string, (message: unknown) => void>();
  const disconnect = vi.fn();
  const streaming: StreamingClientFactory = {
    createClient(extensions) {
      extension = extensions[0];
      return {
        subscribe(channel, onMessage) {
          listeners.set(channel, onMessage);
          return {
            then(onAccepted, onRefused) {
              extension?.outgoing(
                { channel: '/meta/subscribe', subscription: channel },
                (outgoing) => {
                  sent.push(outgoing);
                  extension?.incoming(answer(outgoing), (incoming) => {
                    if (incoming.successful) onAccepted();
                    else onRefused({ message: 'Faye trims the answer' });
                  });
                },
              );
              return undefined;
            },
          };
        },
        disconnect,
      };
    },
  };
  /** Deliver a message from the server, through the extension. */
  const deliver = (message: BayeuxMessage): void => {
    extension?.incoming(message, (incoming) => {
      listeners.get(incoming.channel)?.(incoming.data);
    });
  };
  return { streaming, sent, deliver, disconnect };
}

const accept = (subscribe: BayeuxMessage): BayeuxMessage => ({
  channel: '/meta/subscribe',
  subscription: subscribe.subscription,
  successful: true,
});

describe('fayeTransport', () => {
  it('asks the org to replay each channel from its own point', async () => {
    const { streaming, sent } = fakeStreaming(accept);
    const transport = fayeTransport(streaming);

    await transport.subscribe('/data/LeadChangeEvent', 30_071_889, () => {});
    await transport.subscribe('/data/ContactChangeEvent', -1, () => {});

    expect(sent.map((m) => m.ext)).toEqual([
      { replay: { '/data/LeadChangeEvent': 30_071_889 } },
      { replay: { '/data/ContactChangeEvent': -1 } },
    ]);
  });

  it('refuses with the org’s own answer, code included', async () => {
    const { streaming } = fakeStreaming((subscribe) => ({
      channel: '/meta/subscribe',
      subscription: subscribe.subscription,
      successful: false,
      error: '403::User not allowed to subscribe CDC without required permissions',
    }));
    const transport = fayeTransport(streaming);

    const refusal = await transport
      .subscribe('/data/AccountChangeEvent', -1, () => {})
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SubscriptionRefused);
    expect((refusal as SubscriptionRefused).answer).toBe(
      '403::User not allowed to subscribe CDC without required permissions',
    );
    expect((refusal as SubscriptionRefused).replayIdRefused).toBe(false);
  });

  it('tells a refused replay id from a refused channel', () => {
    const refusal = new SubscriptionRefused(
      '/data/LeadChangeEvent',
      '400::The replayId {12} you provided was invalid. Please provide a valid ID, -2 to replay all events, or -1 to replay only new events.',
    );
    expect(refusal.replayIdRefused).toBe(true);
  });

  it('hands every change on, and resumes a re-subscription after the last one received', async () => {
    const { streaming, sent, deliver } = fakeStreaming(accept);
    const transport = fayeTransport(streaming);
    const received: unknown[] = [];
    await transport.subscribe('/data/LeadChangeEvent', -1, (m) => received.push(m));

    const data = { event: { replayId: 77 }, payload: {} };
    deliver({ channel: '/data/LeadChangeEvent', data });
    expect(received).toEqual([data]);

    // Faye re-subscribes by itself after a re-handshake; the replay map is
    // what that subscribe carries.
    await transport.subscribe('/data/LeadChangeEvent', 77, () => {});
    expect(sent[sent.length - 1].ext).toEqual({ replay: { '/data/LeadChangeEvent': 77 } });
  });

  it('reports a connection the org closed for good, once', async () => {
    const { streaming, deliver } = fakeStreaming(accept);
    const transport = fayeTransport(streaming);
    const down = vi.fn();
    transport.onDown(down);
    await transport.subscribe('/data/LeadChangeEvent', -1, () => {});

    // A transient failure is Faye's to retry.
    deliver({ channel: '/meta/connect', successful: false, advice: { reconnect: 'retry' } });
    expect(down).not.toHaveBeenCalled();

    deliver({
      channel: '/meta/handshake',
      successful: false,
      error: '403::Handshake denied',
      advice: { reconnect: 'none' },
    });
    deliver({ channel: '/meta/connect', successful: false, advice: { reconnect: 'none' } });
    expect(down).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledWith('403::Handshake denied');
  });

  it('disconnects the client it opened', () => {
    const { streaming, disconnect } = fakeStreaming(accept);
    fayeTransport(streaming).disconnect();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
