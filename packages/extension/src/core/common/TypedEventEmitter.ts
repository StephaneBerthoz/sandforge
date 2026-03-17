import { logger } from '../../logger.js';
import { extractErrorMessage } from './extractErrorMessage.js';

type Listener<T> = (event: T) => void;

/**
 * Type-safe event emitter with listener isolation.
 * Listeners that throw do not prevent subsequent listeners from executing.
 */
export class TypedEventEmitter<TEventMap extends Record<string, unknown>> {
  private readonly listenerMap = new Map<keyof TEventMap, Set<Listener<never>>>();

  /** Subscribe to an event type. Returns an unsubscribe function. */
  on<K extends keyof TEventMap>(type: K, listener: Listener<TEventMap[K]>): () => void {
    let listeners = this.listenerMap.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listenerMap.set(type, listeners);
    }
    listeners.add(listener as Listener<never>);
    return () => {
      listeners!.delete(listener as Listener<never>);
    };
  }

  /** Emit an event to all listeners of that type. Errors are isolated. */
  protected emit<K extends keyof TEventMap>(type: K, event: TEventMap[K]): void {
    const listeners = this.listenerMap.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        (listener as Listener<TEventMap[K]>)(event);
      } catch (err) {
        logger.warn('Event listener threw an error', {
          eventType: String(type),
          error: extractErrorMessage(err),
        });
      }
    }
  }

  /** Remove all listeners for all event types. */
  removeAllListeners(): void {
    this.listenerMap.clear();
  }
}
