import type { MessageBroker, MessageHandler } from './MessageBroker';

/**
 * Routes incoming webview messages to the correct module handler
 * by registering subscriptions on the underlying MessageBroker.
 *
 * Provides convenience methods for single-type, multi-type, and
 * batch route registration with automatic cleanup on dispose.
 */
export class MessageRouter {
  private disposers: (() => void)[] = [];

  constructor(private broker: MessageBroker) {}

  /** Register a handler for a single message type. */
  route(type: string, handler: MessageHandler): void {
    const dispose = this.broker.on(type, handler);
    this.disposers.push(dispose);
  }

  /**
   * Register a handler for every message type in the given list
   * whose type string starts with the specified prefix.
   */
  routePrefix(prefix: string, types: string[], handler: MessageHandler): void {
    for (const type of types) {
      if (type.startsWith(prefix)) {
        this.route(type, handler);
      }
    }
  }

  /** Register multiple routes at once from a type-to-handler map. */
  routeAll(routes: Record<string, MessageHandler>): void {
    for (const [type, handler] of Object.entries(routes)) {
      this.route(type, handler);
    }
  }

  /** Get the number of active route subscriptions. */
  get routeCount(): number {
    return this.disposers.length;
  }

  /** Remove all route subscriptions. */
  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
  }
}
