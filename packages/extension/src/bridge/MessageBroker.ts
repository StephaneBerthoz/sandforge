import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import {
  EnvelopedMessageSchema,
  PROTOCOL_VERSION,
  isVersionCompatible,
} from '@sandforge/shared';
import { extractErrorMessage } from '../core/common/extractErrorMessage.js';
import { RateLimiter } from '../core/common/RateLimiter.js';

/** Handler function for a specific message type */
export type MessageHandler = (message: BaseMessage) => void | Promise<void>;

/**
 * Minimal telemetry surface the broker expects. Matches `TelemetryAdapter`'s
 * public API without importing the adapter class directly (avoids a cycle).
 * Tests can pass a simple `{ addBreadcrumb, getLogger: () => ({ warn }) }`.
 */
export interface BrokerTelemetry {
  addBreadcrumb(message: string, category?: string, level?: string): void;
  getLogger?: () => { warn: (obj: unknown, msg?: string) => void };
}

/** Default rate limit: 100 messages per second */
const DEFAULT_RATE_LIMIT_MAX = 100;
/** Default rate limit window: 1 second */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
/** Number of consecutive protocol mismatches before we show the reload banner. */
const MISMATCH_BANNER_THRESHOLD = 3;

/** Options for configuring the MessageBroker */
export interface MessageBrokerOptions {
  /** Maximum number of inbound messages per window (default: 100) */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds (default: 1000) */
  rateLimitWindowMs?: number;
  /** Telemetry adapter for breadcrumb / log emission on invalid payloads. */
  telemetry?: BrokerTelemetry;
}

/**
 * Envelope-carrying shape the webview is expected to send after Plan 01-04.
 * Kept loose here (type-only) since the broker validates via Zod at runtime.
 */
interface RawEnvelope {
  protocolVersion: number;
  correlationId?: string;
  payload: BaseMessage;
}

function isEnvelopeShape(raw: unknown): raw is RawEnvelope {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'protocolVersion' in raw &&
    'payload' in raw &&
    typeof (raw as Record<string, unknown>).payload === 'object'
  );
}

/**
 * Max length of the joined Zod issue string posted to the webview and logged
 * to telemetry. An unknown `type` literal enumerates every known literal
 * (~300 values ≈ 6.5 kB) — that must never hit the wire.
 */
const MAX_ISSUES_LENGTH = 500;

/**
 * Joins Zod issues into a single `; `-separated string, truncating to
 * {@link MAX_ISSUES_LENGTH} chars and appending the total issue count.
 */
function formatIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>,
): string {
  const joined = issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  if (joined.length <= MAX_ISSUES_LENGTH) return joined;
  return `${joined.slice(0, MAX_ISSUES_LENGTH)}…(+${issues.length} issues)`;
}

/** Options for {@link MessageBroker.registerPanel}. */
export interface RegisterPanelOptions {
  /**
   * Subscribe to the view's inbound messages (default: `true`).
   *
   * Pass `false` for outbound-only views such as the sidebar: their outgoing
   * messages are raw shapes without id/timestamp that would fail envelope
   * validation and trip the rate limiter, while inbound traffic is already
   * handled by the provider's own `onDidReceiveMessage` subscription. With
   * `inbound: false` the view still receives every `postToWebview` broadcast.
   */
  inbound?: boolean;
}

/**
 * Central typed message hub for bidirectional communication
 * between the extension host and webview panels/views.
 *
 * Panels register themselves and receive outbound messages.
 * Handlers subscribe to inbound messages by type.
 * Inbound messages are rate-limited to prevent flooding.
 *
 * Plan 01-04 hardening:
 *  - Every inbound message must be enveloped and is parsed via
 *    `EnvelopedMessageSchema`; raw non-enveloped messages are dropped — the
 *    webview always envelops (same VSIX), so a pre-envelope client cannot exist.
 *  - Invalid payloads → `bridge:error` posted back + telemetry warn.
 *  - Version mismatch → `bridge:protocol-mismatch` (every time) and, after
 *    {@link MISMATCH_BANNER_THRESHOLD} consecutive mismatches, a sticky
 *    `bridge:reload-banner` asking the user to reload the window.
 */
export class MessageBroker {
  private handlers = new Map<string, Set<MessageHandler>>();
  private panels = new Set<vscode.WebviewPanel | vscode.WebviewView>();
  private readonly rateLimiter: RateLimiter;
  private readonly telemetry: BrokerTelemetry | undefined;
  private mismatchCount = 0;

  /**
   * @param options - Optional configuration for rate limiting and telemetry.
   */
  constructor(options?: MessageBrokerOptions) {
    this.rateLimiter = new RateLimiter(
      options?.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
      options?.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    );
    this.telemetry = options?.telemetry;
  }

  /**
   * Register a webview panel or view for message routing.
   * Incoming messages from the panel's webview are dispatched to handlers,
   * unless `options.inbound` is `false` (outbound-only registration — the
   * view then only receives `postToWebview` broadcasts).
   * @returns A disposable that unregisters the panel on dispose.
   */
  registerPanel(
    panel: vscode.WebviewPanel | vscode.WebviewView,
    { inbound = true }: RegisterPanelOptions = {},
  ): vscode.Disposable {
    this.panels.add(panel);
    // SECURITY: No event.origin validation is needed here.
    // VSCode's `webview.onDidReceiveMessage` is a trusted channel that only
    // receives messages from the specific webview instance owned by this
    // extension. The VSCode API guarantees message isolation — no other
    // extension or external page can inject messages into this handler.
    const subscription = inbound
      ? panel.webview.onDidReceiveMessage((msg: unknown) => {
          this.dispatch(msg);
        })
      : undefined;
    return {
      dispose: () => {
        this.panels.delete(panel);
        subscription?.dispose();
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

  /** Warn via injected telemetry (if available). */
  private warn(message: string, context?: Record<string, unknown>): void {
    try {
      this.telemetry?.addBreadcrumb(message, 'bridge', 'warning');
      const logger = this.telemetry?.getLogger?.();
      logger?.warn?.(context ?? {}, message);
    } catch {
      // telemetry failures must never affect dispatch
    }
  }

  /**
   * Validate and dispatch an incoming message to registered handlers.
   *
   * Decision tree:
   *  1. If the raw payload does not look like an envelope
   *     (`{ protocolVersion, payload }`), drop it — the webview always
   *     envelops, so a pre-envelope client cannot exist.
   *  2. Otherwise parse via {@link EnvelopedMessageSchema}:
   *      - parse fail → post `bridge:error`, warn, drop.
   *      - version mismatch → post `bridge:protocol-mismatch`, increment
   *        `mismatchCount`, after {@link MISMATCH_BANNER_THRESHOLD} also post
   *        `bridge:reload-banner`. The inner payload is still dispatched so
   *        best-effort functionality survives during hot-reload dev loops.
   *      - success → reset `mismatchCount`, dispatch payload.
   */
  private dispatch(raw: unknown): void {
    if (!isEnvelopeShape(raw)) {
      this.logFn?.('[MessageBroker] Received malformed message: not an envelope');
      return;
    }

    const result = EnvelopedMessageSchema.safeParse(raw);
    if (!result.success) {
      const issues = formatIssues(result.error.issues);
      this.logFn?.(`[MessageBroker] Invalid enveloped payload: ${issues}`);
      this.warn('bridge invalid payload', { issues });
      this.postBridgeError('invalid-payload', issues);
      return;
    }

    const envelope = result.data;
    if (!isVersionCompatible(envelope.protocolVersion)) {
      this.mismatchCount++;
      this.warn('bridge protocol mismatch', {
        serverVersion: PROTOCOL_VERSION,
        clientVersion: envelope.protocolVersion,
        count: this.mismatchCount,
      });
      this.postBridgeMismatch(envelope.protocolVersion);
      if (this.mismatchCount >= MISMATCH_BANNER_THRESHOLD) {
        this.postBridgeReloadBanner();
      }
      // Dispatch anyway so UIs using stable message shapes still work
      // during dev/hot-reload windows.
    } else {
      this.mismatchCount = 0;
    }

    this.continueDispatch(envelope.payload);
  }

  /**
   * Rate-limit + handler dispatch for a message that already passed schema
   * validation. Extracted from {@link dispatch} to keep it readable.
   */
  private continueDispatch(message: BaseMessage): void {
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

  // ── Bridge control messages ──────────────────────────────────────────────

  private nextControlId(): string {
    // Node 20+ and the VS Code webview both expose globalThis.crypto.randomUUID.
    // Engines block declares node>=20 so the fallback is unreachable — dropped.
    return `bridge-${globalThis.crypto.randomUUID()}`;
  }

  private postBridgeError(reason: string, details: string): void {
    this.postToWebview({
      id: this.nextControlId(),
      type: 'bridge:error',
      timestamp: Date.now(),
      ...({ payload: { reason, details } } as Record<string, unknown>),
    } as BaseMessage);
  }

  private postBridgeMismatch(clientVersion: number): void {
    this.postToWebview({
      id: this.nextControlId(),
      type: 'bridge:protocol-mismatch',
      timestamp: Date.now(),
      ...({
        payload: { serverVersion: PROTOCOL_VERSION, clientVersion },
      } as Record<string, unknown>),
    } as BaseMessage);
  }

  private postBridgeReloadBanner(): void {
    this.postToWebview({
      id: this.nextControlId(),
      type: 'bridge:reload-banner',
      timestamp: Date.now(),
      ...({ payload: { reason: 'protocol-mismatch' } } as Record<string, unknown>),
    } as BaseMessage);
  }
}
