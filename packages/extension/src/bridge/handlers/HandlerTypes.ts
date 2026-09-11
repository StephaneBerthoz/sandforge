import type { BaseMessage, NotificationMessage, GrappeConfig } from '@sandforge/shared';
import { DEFAULT_GRAPPE_CONFIG } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { MessageBroker } from '../MessageBroker.js';
import type { OrgManager } from '../../core/connection/OrgManager.js';
import type { OrgRegistry } from '../../core/connection/OrgRegistry.js';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SecretVault } from '../../core/storage/SecretVault.js';
import type { AuthProvider } from '../../core/connection/AuthProvider.js';
import type { SfdxBridge } from '../../core/connection/SfdxBridge.js';
import type { WebviewStateSync } from '../WebviewStateSync.js';
import type { PerformanceTracker } from '../../core/engine/PerformanceTracker.js';
import type { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { OfflineManager } from '../../core/connection/OfflineManager.js';
import type { PIIDetector } from '../../core/precheck/PIIDetector.js';
import type { Services } from '../../services.js';

/** Infrastructure services bundle shared across handlers. */
export interface InfraServices {
  performanceTracker: PerformanceTracker;
  productionGuard: ProductionGuard;
  offlineManager: OfflineManager;
  piiDetector: PIIDetector;
}

/** Core dependencies available to all domain handlers. */
export interface HandlerDeps {
  /** Log function for debug/info output. */
  log: (msg: string) => void;
  /** Central message broker for webview communication. */
  broker: MessageBroker;
  /** Webview state synchronization service. */
  stateSync: WebviewStateSync;
  /** Manages Salesforce org instances. */
  orgManager: OrgManager;
  /** Persists org credentials and configurations. */
  orgRegistry: OrgRegistry;
  /** Key-value configuration store. */
  configStore: ConfigStore;
  /** Secure secrets storage. */
  secretVault: SecretVault;
  /** Authentication provider for Salesforce connections. */
  authProvider: AuthProvider;
  /** Bridge to the Salesforce CLI (sf/sfdx). */
  sfdxBridge: SfdxBridge;
  /** Optional infrastructure services (Tier 1). */
  infraServices?: InfraServices;
  /**
   * Optional composition-root Services bundle (adapters + orchestrator factories).
   * When present, handlers should use the factory functions exposed here
   * (e.g. services.seedOrchestrator(deps)) rather than constructing
   * orchestrators inline — see services.ts for the single source of truth.
   */
  services?: Services;
  /** Generates sequential message IDs. */
  nextId: () => string;
  /**
   * Optional org-selection callback (status bar + `org:selected` broadcast).
   * Late-injected from extension.ts — the selection closure is defined after
   * the handlers are constructed (same pattern as setOnboardingServices).
   */
  onOrgSelected?: (orgId: string) => void;
}

/**
 * Interface that all domain handlers must implement.
 *
 * Each handler is responsible for a specific domain of message types
 * and routes incoming messages to the appropriate internal method.
 */
export interface DomainHandler {
  /** Handle an incoming bridge message.
   * @param msg - A request the MessageRouter admitted (or a listed synthetic run).
   * @returns `true` if the message was handled, `false` otherwise.
   */
  handle(msg: InboundRequest): Promise<boolean>;
}

// ── Correlation ─────────────────────────────────────────────────────────────
//
// The webview matches an answer to its request by `correlationId`, and reads a
// falsy one as "no correlation" (useMessageResponse). The only correlation worth
// stamping is therefore the id of a message something is waiting on — which a
// plain `BaseMessage` cannot prove: `{ id: '', type, timestamp }` and a fresh
// UUID both type-check as one. These brands turn that proof into a type; the
// gate in `handlerErrorChannels.test.ts` rejects the unsound ways around it.

/** Phantom brand of {@link RequestId}: a type only, no value exists at runtime. */
declare const requestIdBrand: unique symbol;

/**
 * The id of a request something is waiting on.
 *
 * Minted in exactly two places: `MessageRouter.route` (a message a webview
 * posted, schema-validated with `id: min(1)`) and {@link syntheticRequest}.
 * A literal, a spread that rewrites the id (`{ ...msg, id: '' }`) or a fresh
 * UUID is not a `RequestId` without a cast, and the gate rejects that cast.
 */
export type RequestId = string & { readonly [requestIdBrand]: true };

/** A request the extension answers: the only valid origin of a response or an error. */
export type InboundRequest = BaseMessage & { readonly id: RequestId };

/** Id prefix of each extension-initiated run. Its keys are the closed list. */
const SYNTHETIC_ID_PREFIX = {
  /** A due sync schedule (`SyncOpsHandler.executeScheduled`); the id is also its operationId. */
  'sync:schedule': 'sync:schedule:',
  /** An operation queued while offline (`ExtensionHandlers.replayQueuedOperation`). */
  'offline-replay': 'offline-replay-',
} as const;

/** The extension-initiated runs allowed to stand in for a request. */
export type SyntheticRequestKind = keyof typeof SYNTHETIC_ID_PREFIX;

/**
 * Mint the request of an extension-initiated run.
 *
 * No webview hook waits on this id, so the run's errors match no request and
 * the webview leaves request state alone (they still surface through
 * `operation:failed`). What such an error must never do is look uncorrelated —
 * claimed by whatever request is in flight — or reuse a real request's id. The
 * kind prefix keeps the id non-empty and disjoint from webview ids, and every
 * call site is pinned by the gate.
 *
 * @param kind - Which listed run this is.
 * @param key - Unique per run (a UUID, the queued operation id).
 * @param type - The request type the run stands for (e.g. `"sync:execute"`).
 */
export function syntheticRequest(
  kind: SyntheticRequestKind,
  key: string,
  type: string,
): InboundRequest {
  return { id: `${SYNTHETIC_ID_PREFIX[kind]}${key}` as RequestId, type, timestamp: Date.now() };
}

/**
 * Build a response message that propagates the request's `id` as `correlationId`.
 *
 * All handlers should use this helper instead of manually constructing response
 * objects so that `useMessageResponse` on the webview side can match responses
 * to the exact request that triggered them.
 *
 * @param deps - Handler dependencies (needs `nextId`).
 * @param request - The incoming request message.
 * @param type - The response message type (e.g. `"seed:describe-global:response"`).
 * @param payload - The response payload.
 */
export function buildResponse<P extends Record<string, unknown>>(
  deps: Pick<HandlerDeps, 'nextId'>,
  request: InboundRequest,
  type: string,
  payload: P,
): BaseMessage & { payload: P } {
  return {
    id: deps.nextId(),
    type,
    timestamp: Date.now(),
    correlationId: request.id,
    payload,
  };
}

/**
 * Send a notification message to the webview.
 *
 * @param deps - Handler dependencies containing broker and nextId.
 * @param level - Notification severity level.
 * @param title - Short notification title.
 * @param message - Notification body text.
 */
export function sendNotification(
  deps: Pick<HandlerDeps, 'broker' | 'nextId' | 'log'>,
  level: 'info' | 'success' | 'warning' | 'error',
  title: string,
  message: string,
): void {
  const notification: NotificationMessage = {
    id: deps.nextId(),
    type: 'notification',
    timestamp: Date.now(),
    payload: { level, title, message, autoDismissMs: 5000 },
  };
  deps.broker.postToWebview(notification);
  deps.log(`[TX] notification: ${title}`);
}

/** Send operation:started lifecycle message. */
export function sendOperationStarted(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  operationId: string,
  module: string,
  description: string,
): void {
  const msg: BaseMessage & {
    payload: { operationId: string; module: string; description: string };
  } = {
    id: deps.nextId(),
    type: 'operation:started',
    timestamp: Date.now(),
    payload: { operationId, module, description },
  };
  deps.broker.postToWebview(msg);
}

/** Send operation:progress lifecycle message. */
export function sendOperationProgress(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  operationId: string,
  percentage: number,
  processedRecords: number,
  totalRecords: number,
  currentStep: string,
): void {
  const msg: BaseMessage & {
    payload: {
      operationId: string;
      percentage: number;
      processedRecords: number;
      totalRecords: number;
      currentStep: string;
    };
  } = {
    id: deps.nextId(),
    type: 'operation:progress',
    timestamp: Date.now(),
    payload: { operationId, percentage, processedRecords, totalRecords, currentStep },
  };
  deps.broker.postToWebview(msg);
}

/** Send operation:completed lifecycle message. */
export function sendOperationCompleted(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  operationId: string,
  result: Record<string, unknown>,
): void {
  const msg: BaseMessage & { payload: { operationId: string; result: Record<string, unknown> } } = {
    id: deps.nextId(),
    type: 'operation:completed',
    timestamp: Date.now(),
    payload: { operationId, result },
  };
  deps.broker.postToWebview(msg);
}

/** Runtime brand of {@link UncorrelatedOrigin}. Module-private: no other file can build one. */
const UNCORRELATED = Symbol('sandforge.uncorrelated');

/**
 * Why an error may answer no request: a closed list, empty today.
 *
 * `never` makes {@link uncorrelated} uncallable. A reason is added here, in a
 * reviewed edit that also updates the pin in `HandlerTypes.test.ts` — never at
 * a call site, where backticks, a variable or an import alias used to slip
 * past a source-text allowlist. None of them slips past a type.
 */
export type UncorrelatedReason = never;

/** An error that answers no request, with its reason on record. Built only by {@link uncorrelated}. */
export interface UncorrelatedOrigin {
  readonly [UNCORRELATED]: true;
  /** Why this error answers no request (surfaced in the `[ERR]` log line). */
  readonly reason: UncorrelatedReason;
}

/**
 * What an error answers: a request, or an explicit and listed admission that
 * there is none. Never `undefined`, never a hand-built message.
 */
export type ErrorOrigin = InboundRequest | UncorrelatedOrigin;

/**
 * Declare that an error answers no request.
 *
 * The webview's `useMessageResponse` attributes an error with no
 * `correlationId` to whatever request of that domain is in flight, so this is
 * the documented exception, never a default. Every call site is pinned by the
 * gate in `handlerErrorChannels.test.ts`.
 *
 * @param reason - One of the listed {@link UncorrelatedReason}s.
 */
export function uncorrelated(reason: UncorrelatedReason): UncorrelatedOrigin {
  return { [UNCORRELATED]: true, reason };
}

/** Optional error metadata. Named, so no call site pads with `undefined`. */
export interface HandlerErrorOptions {
  /** Structured error code for classification (default: `'UNKNOWN'`). */
  code?: string;
  /** Whether the operation can be retried (default: `false`). */
  retryable?: boolean;
  /**
   * Extra fields merged into the error payload (e.g. the offline `retryHint`
   * for transport-level seed failures).
   */
  extraPayload?: Record<string, unknown>;
}

/**
 * Log an error and send an error response message to the webview.
 *
 * Consolidates the repeated catch-block pattern found across domain handlers:
 * extract message, log `[ERR]`, post typed error message, log `[TX]`.
 *
 * `origin` is required, positional and branded: an error can name only a
 * request the router admitted, a listed synthetic run, or a listed reason for
 * naming none. It used to be the 8th parameter and optional, which
 * meant seven arguments — three of them `undefined` padding — stood between a
 * handler and the correct call; 85 of 121 call sites took the shortcut and
 * shipped errors the webview could only misattribute. Everything genuinely
 * optional now lives in `options`, so nothing can ever push `origin` out of
 * reach again.
 *
 * @param deps - Handler dependencies containing log, broker, and nextId.
 * @param context - Short label for the log prefix (e.g. `"sync:describe-global"`).
 * @param messageType - The outgoing message type (e.g. `"sync:error"`).
 * @param origin - The request this error answers (an {@link InboundRequest}), or `uncorrelated(reason)`.
 * @param err - The caught unknown error value.
 * @param options - Optional `code`, `retryable` and `extraPayload`.
 */
export function sendHandlerError(
  deps: Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>,
  context: string,
  messageType: string,
  origin: ErrorOrigin,
  err: unknown,
  options: HandlerErrorOptions = {},
): void {
  const message = extractErrorMessage(err);
  const orphan = UNCORRELATED in origin;
  deps.log(
    `[ERR] ${context}: ${message}${orphan ? ` (uncorrelated: ${String(origin.reason)})` : ''}`,
  );
  const errMsg: BaseMessage & {
    payload: { message: string; code: string; retryable: boolean } & Record<string, unknown>;
  } = {
    id: deps.nextId(),
    type: messageType,
    timestamp: Date.now(),
    // Correlating the error to its request lets the webview drop stale error
    // responses (same contract as buildResponse: correlationId = request.id).
    ...(orphan ? {} : { correlationId: origin.id }),
    payload: {
      message,
      code: options.code ?? 'UNKNOWN',
      retryable: options.retryable ?? false,
      ...options.extraPayload,
    },
  };
  deps.broker.postToWebview(errMsg);
  deps.log(`[TX] ${messageType}: ${message}`);
}

/** The shape every orchestrator's optional `onGrappeEvent` callback receives. */
export interface GrappeEventEnvelope {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Forward an orchestrator grappe event onto the bridge.
 *
 * The three orchestrators (seed, sync, autopilot) emit `grappe:started`,
 * `grappe:partitionProgress` and `grappe:completed` through an OPTIONAL
 * injected callback. Nothing assigned it, so BridgeProvider's three listeners
 * and the whole Grappe page were fed by no one. Every construction site must
 * pass this — see the guard in shared's `emittedChannels.test.ts`.
 */
export function postGrappeEvent(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  event: GrappeEventEnvelope,
): void {
  const msg: BaseMessage & { payload: Record<string, unknown> } = {
    id: deps.nextId(),
    type: event.type,
    timestamp: Date.now(),
    payload: event.payload,
  };
  deps.broker.postToWebview(msg);
}

/**
 * Build the grappe configuration from the `sandforge.grappe.*` settings
 * (contributed in package.json).
 *
 * Returns `undefined` when the settings bundle is unavailable or grappe is
 * off, which is what every `isGrappeActive()` reads as "stay sequential" —
 * partitioned execution is opt-in and must never turn itself on.
 */
export function readGrappeConfig(services: Services | undefined): GrappeConfig | undefined {
  const get = services?.getSandforgeSetting;
  if (!get || !get<boolean>('grappe.enabled', false)) {
    return undefined;
  }
  return {
    enabled: true,
    autoActivateThreshold: get<number>('grappe.autoActivateThreshold', 10_000),
    // Not a contributed setting: every grappe path is a sequential for-await
    // loop, so there is nothing to size. It was published as
    // `sandforge.grappe.maxWorkers` — "partitions processed concurrently" — for
    // one release, promising a concurrency that does not exist anywhere.
    maxWorkers: DEFAULT_GRAPPE_CONFIG.maxWorkers,
    grappeSize: get<number>('grappe.grappeSize', 5000),
    strategy: 'round_robin',
    backPressure: {
      enabled: false,
      maxQueueDepth: 3,
      highWaterMark: 80,
      lowWaterMark: 60,
      strategy: 'pause',
      monitoringInterval: 5000,
    },
    checkpointing: true,
    isolationLevel: 'per_grappe',
  };
}

/** Send operation:failed lifecycle message. */
export function sendOperationFailed(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  operationId: string,
  error: string,
  retryable: boolean,
  extraPayload?: Record<string, unknown>,
): void {
  const msg: BaseMessage & {
    payload: { operationId: string; error: string; retryable: boolean } & Record<string, unknown>;
  } = {
    id: deps.nextId(),
    type: 'operation:failed',
    timestamp: Date.now(),
    payload: { operationId, error, retryable, ...extraPayload },
  };
  deps.broker.postToWebview(msg);
}
