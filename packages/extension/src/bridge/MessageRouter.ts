import type { InboundRequest } from './handlers/HandlerTypes.js';
import type { MessageBroker } from './MessageBroker';

/** A route handler: it receives a request the router admitted (see {@link MessageRouter.route}). */
export type RouteHandler = (message: InboundRequest) => void | Promise<void>;

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

  /**
   * Register a handler for a single message type.
   *
   * This is where a `BaseMessage` becomes an {@link InboundRequest} — the one
   * mint besides `syntheticRequest`. It holds because the broker calls `on`
   * subscribers only from `dispatch()`: for a message a webview panel posted
   * and `EnvelopedMessageSchema` validated (`id: min(1)`), whose id a webview
   * hook is waiting on. The message is frozen before any handler sees it, so
   * no handler can rewrite that id through a wider type.
   */
  route(type: string, handler: RouteHandler): void {
    const dispose = this.broker.on(type, (message) =>
      handler(Object.freeze(message) as InboundRequest),
    );
    this.disposers.push(dispose);
  }

  /**
   * Register a handler for every message type in the given list
   * whose type string starts with the specified prefix.
   */
  routePrefix(prefix: string, types: string[], handler: RouteHandler): void {
    for (const type of types) {
      if (type.startsWith(prefix)) {
        this.route(type, handler);
      }
    }
  }

  /** Register multiple routes at once from a type-to-handler map. */
  routeAll(routes: Record<string, RouteHandler>): void {
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
