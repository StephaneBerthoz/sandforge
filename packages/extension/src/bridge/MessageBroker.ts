import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { EnvelopedMessageSchema, PROTOCOL_VERSION, isVersionCompatible } from '@sandforge/shared';
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
/**
 * Requests whose sender is remembered, the oldest forgotten first: far more
 * than are ever in flight, and a bound on what a sender that is never
 * answered through {@link MessageBroker.replyToRequester} leaves behind.
 */
const MAX_REMEMBERED_SENDERS = 1_000;

/** A suggested fix for a failed operation, and where it came from. */
export interface FixSuggestion {
  /** `knowledge-base`: the table of known Salesforce error codes; `model`: the AI model. */
  source: 'knowledge-base' | 'model';
  /** The suggestion itself, as the table or the model wrote it. */
  text: string;
  /**
   * The Salesforce error code the table answered, when it is the one that
   * answered. The host keys its translation on it: the table is written in
   * English, and `text` is the English line it holds.
   */
  code?: string;
}

/** Options for configuring the MessageBroker */
export interface MessageBrokerOptions {
  /** Maximum number of inbound messages per window (default: 100) */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds (default: 1000) */
  rateLimitWindowMs?: number;
  /** Telemetry adapter for breadcrumb / log emission on invalid payloads. */
  telemetry?: BrokerTelemetry;
  /**
   * Shows a fix suggestion outside the webviews (a VS Code notification in
   * extension.ts). Absent in tests: {@link MessageBroker.showFixSuggestion}
   * is then a no-op.
   */
  showFixSuggestion?: (suggestion: FixSuggestion) => void;
}

/**
 * Envelope-carrying shape every message from the webview is expected to use.
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
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  const joined = issues
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
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
 * Envelope hardening:
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
  private readonly fixSuggestionNotifier: ((suggestion: FixSuggestion) => void) | undefined;
  private mismatchCount = 0;
  /** Whether a webview has registered yet, in this broker's life. */
  private webviewSeen = false;
  /** What waits for the first webview, emptied when it registers. */
  private firstWebviewCallbacks: Array<() => void> = [];
  /** The webview each recent request came from, by request id. */
  private readonly senders = new Map<string, vscode.WebviewPanel | vscode.WebviewView>();

  /**
   * @param options - Optional configuration for rate limiting, telemetry and the host notifier.
   */
  constructor(options?: MessageBrokerOptions) {
    this.rateLimiter = new RateLimiter(
      options?.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
      options?.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    );
    this.telemetry = options?.telemetry;
    this.fixSuggestionNotifier = options?.showFixSuggestion;
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
          this.dispatch(msg, panel);
        })
      : undefined;
    if (!this.webviewSeen) {
      this.webviewSeen = true;
      for (const callback of this.firstWebviewCallbacks.splice(0)) this.runFirstWebview(callback);
    }
    return {
      dispose: () => {
        this.panels.delete(panel);
        subscription?.dispose();
        for (const [id, sender] of this.senders) {
          if (sender === panel) this.senders.delete(id);
        }
      },
    };
  }

  /**
   * Run `callback` once, when the first webview registers: the sidebar or a
   * panel, whichever the user opens first. At once if one already has.
   *
   * What only a SandForge view needs starts here rather than at activation,
   * which happens in every VS Code window after startup, most of which never
   * show SandForge at all.
   */
  onFirstWebview(callback: () => void): void {
    if (this.webviewSeen) {
      this.runFirstWebview(callback);
      return;
    }
    this.firstWebviewCallbacks.push(callback);
  }

  /** A callback that throws must not stop the others, nor the registration under way. */
  private runFirstWebview(callback: () => void): void {
    try {
      callback();
    } catch (err: unknown) {
      this.logError('first webview', err);
    }
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

  /**
   * Send a response to the webview whose request it answers, and to no other:
   * to every webview when that one is not known or is gone.
   *
   * For an answer no other webview reads. `postToWebview` copies a message to
   * every open panel and the sidebar, each of which deserializes it: a panel
   * opened in French had the whole French catalogue, about 320 kB, sent to
   * every panel already open, and a Forge discovery its whole graph. Not for
   * an answer the other webviews act on too, such as `org:selected` or
   * `settings:response`, which each panel takes by its type.
   */
  replyToRequester(message: BaseMessage): void {
    const sender =
      typeof message.correlationId === 'string'
        ? this.senders.get(message.correlationId)
        : undefined;
    if (sender && this.panels.has(sender)) {
      sender.webview.postMessage(message);
      return;
    }
    this.postToWebview(message);
  }

  /** Get the number of currently registered panels. */
  get panelCount(): number {
    return this.panels.size;
  }

  /**
   * Show a fix suggestion once, through the host.
   *
   * Not a broadcast: every open panel mounts its own listener, so a suggestion
   * posted to the webviews was shown once per open panel.
   */
  showFixSuggestion(suggestion: FixSuggestion): void {
    this.fixSuggestionNotifier?.(suggestion);
  }

  /** Remove all handlers and panel registrations. */
  dispose(): void {
    this.handlers.clear();
    this.panels.clear();
    this.firstWebviewCallbacks = [];
    this.senders.clear();
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
  private dispatch(raw: unknown, sender?: vscode.WebviewPanel | vscode.WebviewView): void {
    if (!isEnvelopeShape(raw)) {
      this.logFn?.('[MessageBroker] Received malformed message: not an envelope');
      return;
    }

    const result = EnvelopedMessageSchema.safeParse(raw);
    if (!result.success) {
      const issues = formatIssues(result.error.issues);
      this.logFn?.(`[MessageBroker] Invalid enveloped payload: ${issues}`);
      this.warn('bridge invalid payload', { issues });
      // The envelope shape check above guarantees `payload` is an object; its
      // `id` is what the sender is waiting on. Read defensively — an id of the
      // wrong type is exactly the kind of thing that just failed validation.
      const inner = (raw as { payload?: unknown }).payload as { id?: unknown } | undefined;
      const correlationId = typeof inner?.id === 'string' ? inner.id : undefined;
      this.postBridgeError('invalid-payload', issues, correlationId);
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

    if (sender) this.rememberSender(envelope.payload.id, sender);
    this.continueDispatch(envelope.payload);
  }

  /** Remember which webview sent request `id`, forgetting the oldest past the bound. */
  private rememberSender(id: string, sender: vscode.WebviewPanel | vscode.WebviewView): void {
    this.senders.delete(id);
    this.senders.set(id, sender);
    if (this.senders.size > MAX_REMEMBERED_SENDERS) {
      const oldest = this.senders.keys().next().value;
      if (oldest !== undefined) this.senders.delete(oldest);
    }
  }

  /**
   * Rate-limit + handler dispatch for a message that already passed schema
   * validation. Extracted from {@link dispatch} to keep it readable.
   */
  private continueDispatch(message: BaseMessage): void {
    // Both drops below answer the sender, correlated to its message: a drop
    // with no reply leaves the hook that sent it waiting out its timeout.
    if (!this.rateLimiter.tryAcquire()) {
      this.logFn?.(`[MessageBroker] Rate limited: dropping message of type "${message.type}"`);
      this.postBridgeError('rate-limited', `"${message.type}" was dropped`, message.id);
      return;
    }

    const handlerSet = this.handlers.get(message.type);
    if (!handlerSet) {
      this.logFn?.(`[MessageBroker] Unhandled message type: "${message.type}"`);
      this.postBridgeError('unhandled-type', `no handler for "${message.type}"`, message.id);
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

  /**
   * @param correlationId - Id of the message that failed, when it could be
   *   read. A rejection nobody can attribute is worse than useless: the hook
   *   that sent the dropped message waits out its whole timeout, while every
   *   other in-flight hook has to decide whether the broadcast was meant for
   *   it — and any rule based on timing gets that wrong.
   */
  private postBridgeError(reason: string, details: string, correlationId?: string): void {
    this.postToWebview({
      id: this.nextControlId(),
      type: 'bridge:error',
      timestamp: Date.now(),
      ...(correlationId ? { correlationId } : {}),
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
