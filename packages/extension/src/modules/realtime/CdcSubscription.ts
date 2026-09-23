import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { changeEventChannel, parseChangeEvent, type ChangeEvent } from './changeEvent.js';
import {
  REPLAY_ALL_RETAINED,
  REPLAY_NEW_EVENTS,
  SubscriptionRefused,
  type CometdTransport,
} from './cometdTransport.js';
import type { ReplayStore } from './ReplayStore.js';

/** What opening the subscriptions of a session came to. */
export interface SubscribeOutcome {
  /** Objects whose change events now arrive. */
  subscribed: string[];
  /** Objects the org refused, with its answer. */
  refused: Array<{ objectApiName: string; reason: string }>;
  /** What the subscription had to settle for. */
  notes: string[];
}

/** Dependencies of a {@link CdcSubscription}. */
export interface CdcSubscriptionDeps {
  /** The CometD connection to the source org. */
  transport: CometdTransport;
  /** Where each channel was last read to. */
  replayStore: Pick<ReplayStore, 'get'>;
  /** Receives every change event, in the order the org sends them. */
  onEvent: (event: ChangeEvent) => void;
  /** Receives a message on a watched channel that is not a change event. */
  onUnreadable: (channel: string, reason: string) => void;
}

/**
 * The change event channels of one session, one per watched object.
 *
 * Each channel starts where the last session on the same org stopped reading
 * it, or from the next event the first time. An object the org does not
 * publish is refused by the org itself — on a sandbox with Account unselected,
 * `403::User not allowed to subscribe CDC without required permissions` — and
 * that answer is kept, word for word, for the page to show.
 */
export class CdcSubscription {
  /** @param deps - Transport, resume points and event sinks. */
  constructor(private readonly deps: CdcSubscriptionDeps) {}

  /**
   * Subscribe to the change events of every object in `objects`.
   *
   * @param objects - API names of the watched objects.
   * @returns Which objects were subscribed, which were refused and why.
   */
  async open(objects: readonly string[]): Promise<SubscribeOutcome> {
    const outcome: SubscribeOutcome = { subscribed: [], refused: [], notes: [] };
    for (const objectApiName of objects) {
      const channel = changeEventChannel(objectApiName);
      const onMessage = (message: unknown): void => {
        let event: ChangeEvent;
        try {
          event = parseChangeEvent(channel, message);
        } catch (err: unknown) {
          this.deps.onUnreadable(channel, extractErrorMessage(err));
          return;
        }
        this.deps.onEvent(event);
      };

      const stored = this.deps.replayStore.get(channel);
      try {
        await this.deps.transport.subscribe(channel, stored ?? REPLAY_NEW_EVENTS, onMessage);
        outcome.subscribed.push(objectApiName);
      } catch (err: unknown) {
        if (stored !== undefined && err instanceof SubscriptionRefused && err.replayIdRefused) {
          // The org no longer holds the point to resume from: it keeps three
          // days of events, and a sandbox refresh starts the count again.
          // Replaying what it still holds loses the least.
          try {
            await this.deps.transport.subscribe(channel, REPLAY_ALL_RETAINED, onMessage);
            outcome.subscribed.push(objectApiName);
            outcome.notes.push(
              `${objectApiName}: the org no longer holds the point the last session stopped at ` +
                `(replay id ${stored}), so every change it still holds — up to three days — is ` +
                `replayed instead. Changes older than that were not received; a Sync run brings ` +
                `the target up to date.`,
            );
          } catch (retryErr: unknown) {
            outcome.refused.push({ objectApiName, reason: refusalText(retryErr) });
          }
        } else {
          outcome.refused.push({ objectApiName, reason: refusalText(err) });
        }
      }
    }
    return outcome;
  }

  /** Close every subscription and the connection under them. */
  close(): void {
    this.deps.transport.disconnect();
  }
}

/** The org's own answer when it refused, the error text otherwise. */
function refusalText(err: unknown): string {
  return err instanceof SubscriptionRefused ? err.answer : extractErrorMessage(err);
}
