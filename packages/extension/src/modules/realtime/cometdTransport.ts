/**
 * The CometD connection change events arrive on.
 *
 * jsforce ships a Streaming API client (Faye, already inside the bundled
 * jsforce), so this needs no dependency of its own. Its replay extension
 * handles one channel; a session watches several, so the replay ids travel
 * through the small extension below instead, one per channel.
 */

/** A Bayeux message as the Faye extension hooks see it. */
export interface BayeuxMessage {
  channel: string;
  subscription?: string;
  successful?: boolean;
  error?: string;
  advice?: { reconnect?: string };
  ext?: Record<string, unknown>;
  data?: { event?: { replayId?: unknown } };
  [key: string]: unknown;
}

/** A Faye client extension: sees every message in and out. */
export interface BayeuxExtension {
  incoming(message: BayeuxMessage, callback: (message: BayeuxMessage) => void): void;
  outgoing(message: BayeuxMessage, callback: (message: BayeuxMessage) => void): void;
}

/** What a Faye subscription exposes: settles once the server answers the subscribe. */
interface FayeSubscriptionLike {
  then(onAccepted: () => void, onRefused: (error: unknown) => void): unknown;
}

/** The part of a Faye client a session uses. */
export interface FayeClientLike {
  subscribe(channel: string, onMessage: (message: unknown) => void): FayeSubscriptionLike;
  disconnect(): void;
}

/** What `conn.streaming` offers: a Faye client, authenticated, with extensions. */
export interface StreamingClientFactory {
  createClient(extensions: BayeuxExtension[]): FayeClientLike;
}

/**
 * Where a subscription starts: `-1` from the next event, `-2` from the oldest
 * event the org still holds (three days), or a replay id to resume after.
 */
export const REPLAY_NEW_EVENTS = -1;
export const REPLAY_ALL_RETAINED = -2;

/** A subscription the org refused, with its answer as it gave it. */
export class SubscriptionRefused extends Error {
  /**
   * @param channel - The channel refused.
   * @param answer - The org's answer, e.g. `403::User not allowed to subscribe CDC without required permissions`.
   */
  constructor(
    readonly channel: string,
    readonly answer: string,
  ) {
    super(`${channel}: ${answer}`);
    this.name = 'SubscriptionRefused';
  }

  /** Whether the org refused the replay id rather than the channel. */
  get replayIdRefused(): boolean {
    return /replay ?id/i.test(this.answer);
  }
}

/** The CometD connection of a session, as the subscription uses it. */
export interface CometdTransport {
  /**
   * Subscribe to `channel` from `replayFrom`. Resolves once the org accepts;
   * rejects with a {@link SubscriptionRefused} carrying its answer.
   */
  subscribe(
    channel: string,
    replayFrom: number,
    onMessage: (message: unknown) => void,
  ): Promise<void>;
  /**
   * Be told when the connection is lost for good: the org refused the
   * credentials, or said not to reconnect. Transient drops are retried by the
   * client and are not reported.
   */
  onDown(listener: (reason: string) => void): void;
  /** Close the connection and every subscription on it. */
  disconnect(): void;
}

/** The text of whatever a Faye errback hands over. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * A {@link CometdTransport} over jsforce's Streaming API client.
 *
 * @param streaming - `conn.streaming` of a connection to the source org.
 */
export function fayeTransport(streaming: StreamingClientFactory): CometdTransport {
  const replayFrom = new Map<string, number>();
  const refusals = new Map<string, string>();
  const downListeners: Array<(reason: string) => void> = [];
  let down = false;

  const extension: BayeuxExtension = {
    outgoing(message, callback) {
      if (message.channel === '/meta/subscribe' && message.subscription) {
        const from = replayFrom.get(message.subscription);
        if (from !== undefined) {
          message.ext = { ...(message.ext ?? {}), replay: { [message.subscription]: from } };
        }
      }
      callback(message);
    },
    incoming(message, callback) {
      if (message.channel === '/meta/subscribe' && message.successful === false) {
        // Faye trims the answer to its last part; the org's own words, code
        // included, are what the page shows.
        refusals.set(message.subscription ?? '', message.error ?? 'refused without a reason');
      } else if (
        (message.channel === '/meta/handshake' || message.channel === '/meta/connect') &&
        message.successful === false &&
        message.advice?.reconnect === 'none'
      ) {
        if (!down) {
          down = true;
          const reason = message.error ?? `${message.channel} refused`;
          for (const listener of downListeners) listener(reason);
        }
      } else if (!message.channel.startsWith('/meta/')) {
        // A re-handshake re-subscribes on its own: it must resume after the
        // last event received, not from where the session started.
        const replayId = message.data?.event?.replayId;
        if (typeof replayId === 'number' && replayFrom.has(message.channel)) {
          replayFrom.set(message.channel, replayId);
        }
      }
      callback(message);
    },
  };

  const client = streaming.createClient([extension]);

  return {
    subscribe(channel, from, onMessage) {
      replayFrom.set(channel, from);
      refusals.delete(channel);
      return new Promise<void>((resolve, reject) => {
        client.subscribe(channel, onMessage).then(
          () => resolve(),
          (error: unknown) => {
            replayFrom.delete(channel);
            reject(new SubscriptionRefused(channel, refusals.get(channel) ?? errorText(error)));
          },
        );
      });
    },
    onDown(listener) {
      downListeners.push(listener);
    },
    disconnect() {
      down = true;
      client.disconnect();
    },
  };
}
