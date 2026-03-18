import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { baseMessageSchema } from '@sandforge/shared';
import { extractErrorMessage } from '../core/common/extractErrorMessage.js';
import { RateLimiter } from '../core/common/RateLimiter.js';

/** Handler function for a specific message type */
export type MessageHandler = (message: BaseMessage) => void | Promise<void>;

/** Default rate limit: 100 messages per second */
const DEFAULT_RATE_LIMIT_MAX = 100;
/** Default rate limit window: 1 second */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

/** Options for configuring the MessageBroker */
export interface MessageBrokerOptions {
  /** Maximum number of inbound messages per window (default: 100) */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds (default: 1000) */
  rateLimitWindowMs?: number;
}

/**
 * Central typed message hub for bidirectional communication
 * between the extension host and webview panels/views.
 *
 * Panels register themselves and receive outbound messages.
 * Handlers subscribe to inbound messages by type.
 * Inbound messages are rate-limited to prevent flooding.
 */
export class MessageBroker {
  private handlers = new Map<string, Set<MessageHandler>>();
  private panels = new Set<vscode.WebviewPanel | vscode.WebviewView>();
  private readonly rateLimiter: RateLimiter;

  /**
   * @param options - Optional configuration for rate limiting
   */
  constructor(options?: MessageBrokerOptions) {
    this.rateLimiter = new RateLimiter(
      options?.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
      options?.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    );
  }

  /**
   * Register a webview panel or view for message routing.
   * Incoming messages from the panel's webview are dispatched to handlers.
   * @returns A disposable that unregisters the panel on dispose.
   */
  registerPanel(panel: vscode.WebviewPanel | vscode.WebviewView): vscode.Disposable {
    this.panels.add(panel);
    // SECURITY: No event.origin validation is needed here.
    // VSCode's `webview.onDidReceiveMessage` is a trusted channel that only
    // receives messages from the specific webview instance owned by this
    // extension. The VSCode API guarantees message isolation — no other
    // extension or external page can inject messages into this handler.
    const subscription = panel.webview.onDidReceiveMessage((msg: BaseMessage) => {
      this.dispatch(msg);
    });
    return {
      dispose: () => {
        this.panels.delete(panel);
        subscription.dispose();
      },
    };
  }

  /**
   * Subscribe to messages of a given type.
   * @returns A function that removes the subscription when called.
   */
  on(type: string, handler: MessageHandler): () => void {
    let handlerSet = this.handlers.get(type);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(type, handlerSet);
    }
    handlerSet.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Send a typed message to all registered webview panels/views.
   */
  postToWebview(message: BaseMessage): void {
    for (const panel of this.panels) {
      panel.webview.postMessage(message);
    }
  }

  /** Get the number of currently registered panels. */
  get panelCount(): number {
    return this.panels.size;
  }

  /** Remove all handlers and panel registrations. */
  dispose(): void {
    this.handlers.clear();
    this.panels.clear();
  }

  /** Log function for handler errors. Can be overridden for testing. */
  private logFn: ((msg: string) => void) | undefined;

  /** Set a log function for error reporting. */
  setLogFunction(fn: (msg: string) => void): void {
    this.logFn = fn;
  }

  private logError(messageType: string, err: unknown): void {
    const errMsg = extractErrorMessage(err);
    this.logFn?.(`[MessageBroker] Handler error for "${messageType}": ${errMsg}`);
  }

  /**
   * Validate and dispatch an incoming message to registered handlers.
   * Uses Zod to validate the base message structure (id, type, timestamp).
   * Invalid messages are logged and dropped without crashing.
   */
  private dispatch(message: BaseMessage): void {
    // Validate message structure with Zod before dispatching
    const result = baseMessageSchema.safeParse(message);
    if (!result.success) {
      const issues = result.error.issues.map((issue: { path: (string | number)[]; message: string }) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      this.logFn?.(`[MessageBroker] Received malformed message: ${issues}`);
      return;
    }

    // SC3: Rate-limit inbound messages to prevent flooding
    if (!this.rateLimiter.tryAcquire()) {
      this.logFn?.(`[MessageBroker] Rate limited: dropping message of type "${message.type}"`);
      return;
    }

    const handlerSet = this.handlers.get(message.type);
    if (!handlerSet) {
      this.logFn?.(`[MessageBroker] Unhandled message type: "${message.type}"`);
      return;
    }
    for (const handler of handlerSet) {
      try {
        const result = handler(message);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            this.logError(message.type, err);
          });
        }
      } catch (err: unknown) {
        this.logError(message.type, err);
      }
    }
  }
}
