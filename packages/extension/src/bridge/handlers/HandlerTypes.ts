import type {
  BaseMessage,
  NotificationAction,
  NotificationMessage,
  GrappeConfig,
} from '@sandforge/shared';
import { DEFAULT_GRAPPE_CONFIG } from '@sandforge/shared';
import { extractErrorMessage, extractErrorCode } from '../../core/common/extractErrorMessage.js';
import { hasKnownResolution, resolveKnownError } from '../../core/common/errorKnowledgeBase.js';
import type { ErrorResolver, OperationContext } from '../../modules/ai/ErrorResolver.js';
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
  /** Optional infrastructure services. */
  infraServices?: InfraServices;
  /**
   * Optional model-backed error resolver (injected with the AI modules by
   * `ExtensionHandlers.setAIModules`). Absent whenever the AI stack is not
   * configured — `aiComposition` only builds it with AI enabled and a stored
   * key — which is exactly when a failed operation must not reach the model.
   * The table of known error codes answers either way. See {@link sendOperationFailed}.
   */
  errorResolver?: ErrorResolver;
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
   * the handlers are constructed (same pattern as setOnboardingService).
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

/** What a caller may change about a notification it sends. */
export interface NotificationOptions {
  /**
   * How long the toast stays up, in milliseconds. `null` keeps it until the
   * user dismisses it: the five-second default is too short for a toast that
   * asks the reader to go and install something.
   */
  autoDismissMs?: number | null;
  /** Buttons rendered under the message. */
  actions?: NotificationAction[];
}

/**
 * Send a notification message to the webview.
 *
 * @param deps - Handler dependencies containing broker and nextId.
 * @param level - Notification severity level.
 * @param title - Short notification title.
 * @param message - Notification body text.
 * @param options - Dismissal delay and action buttons; both default to the
 *   five-second toast with no buttons.
 */
export function sendNotification(
  deps: Pick<HandlerDeps, 'broker' | 'nextId' | 'log'>,
  level: 'info' | 'success' | 'warning' | 'error',
  title: string,
  message: string,
  options: NotificationOptions = {},
): void {
  const autoDismissMs = options.autoDismissMs === undefined ? 5000 : options.autoDismissMs;
  const notification: NotificationMessage = {
    id: deps.nextId(),
    type: 'notification',
    timestamp: Date.now(),
    payload: {
      level,
      title,
      message,
      ...(autoDismissMs === null ? {} : { autoDismissMs }),
      ...(options.actions ? { actions: options.actions } : {}),
    },
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

/** Deps {@link sendOperationFailed} needs; the resolution ones are optional. */
type OperationFailedDeps = Pick<HandlerDeps, 'broker' | 'nextId'> &
  Partial<Pick<HandlerDeps, 'errorResolver' | 'log'>>;

/**
 * What the handler knows about the operation that failed.
 *
 * It goes into the model's prompt only: the lifecycle message does not carry
 * it, and the resolver remembers an answer under the code and the message, so
 * one failure raised by two runs is still asked about once.
 *
 * A failure SandForge wrote itself (see {@link SANDFORGE_AUTHORED_FAILURES})
 * is never asked about, so the context several call sites hand over with one
 * is carried for uniformity and never read.
 */
export interface OperationFailureContext {
  module: 'seed' | 'sync' | 'dataops' | 'automation';
  /** The request that started the operation (e.g. `"dataops:rollback"`). */
  operation?: string;
  /** The object in progress, or every object of the run, comma-separated. */
  objectName?: string;
  /** The batch size the objects were written with. */
  batchSize?: number;
}

/** Optional `operation:failed` metadata. Named, so no call site pads with `undefined`. */
export interface OperationFailedOptions {
  /** Extra fields merged into the lifecycle payload (e.g. the offline `retryHint`). */
  extraPayload?: Record<string, unknown>;
  /** What is known about the operation, for the fix suggestion. */
  context?: OperationFailureContext;
}

/**
 * The object and batch size of a failure's context, from a run's object list.
 *
 * A handler's `catch` does not see which object a multi-object run was on, so
 * every name is given, and the batch size only when the objects share one.
 */
export function objectsFailureContext(
  objects: ReadonlyArray<{ objectApiName: string; batchSize?: number }>,
): Pick<OperationFailureContext, 'objectName' | 'batchSize'> {
  const sizes = new Set(objects.map((o) => o.batchSize));
  const [batchSize] = sizes;
  return {
    ...(objects.length > 0 ? { objectName: objects.map((o) => o.objectApiName).join(', ') } : {}),
    ...(sizes.size === 1 && batchSize !== undefined ? { batchSize } : {}),
  };
}

/**
 * Send the `operation:failed` lifecycle message and resolve the failure once.
 *
 * This is the only emitter of `operation:failed`, which is why the resolution
 * belongs here: the broker fans the message out to every open panel, so a
 * panel that answers what it receives turns one failed operation into one
 * resolution *per panel* — and a panel cannot do it well anyway, since all it
 * gets is the rendered message. The answer is shown by the host, once, for
 * the same reason.
 */
export function sendOperationFailed(
  deps: OperationFailedDeps,
  operationId: string,
  error: string,
  retryable: boolean,
  options: OperationFailedOptions = {},
): void {
  const msg: BaseMessage & {
    payload: { operationId: string; error: string; retryable: boolean } & Record<string, unknown>;
  } = {
    id: deps.nextId(),
    type: 'operation:failed',
    timestamp: Date.now(),
    payload: { operationId, error, retryable, ...options.extraPayload },
  };
  deps.broker.postToWebview(msg);
  resolveFailedOperation(deps, error, options.context);
}

/**
 * Failure messages SandForge writes itself.
 *
 * None of them is a Salesforce error: the table of known codes cannot answer
 * them, and the model can only paraphrase what they already say — at the cost
 * of a call, and of the org ids several of them name. Matched here, on the
 * message, because a handler that throws one of them reaches
 * `sendOperationFailed` through a generic `catch` that no call-site flag sees.
 */
const SANDFORGE_AUTHORED_FAILURES: readonly RegExp[] = [
  // A declined production confirmation (every write path).
  /^Operation cancelled by user\b/,
  // ProductionGuard refusals, rethrown by the write paths.
  /^Operation blocked by Production Guard: /,
  // The duplicate-operation and per-org lock guards.
  /^Duplicate operation: /,
  /^A backup or rollback operation is already running for org /,
  // CrudFlsGuard refusals.
  /^Object describe not available for '/,
  /^User lacks '[^']*' permission on '/,
  /^FLS violation on '/,
  // Rollback preconditions.
  /^No backup found for operation /,
  /^Backup \S+ was taken from org /,
  // The pipeline runner's fallback when a failed run carries no error.
  /^Pipeline failed$/,
  // ConnectionHelper, before any call reaches the org: an unknown org, a
  // missing session, a malformed CLI username. The first two carry the org Id.
  /^Org not found: /,
  /^No credentials for org /,
  /^Invalid username format: /,
];

/** Whether a failure message is one SandForge wrote, rather than one the org returned. */
function isSandForgeAuthoredFailure(message: string): boolean {
  return SANDFORGE_AUTHORED_FAILURES.some((pattern) => pattern.test(message));
}

/**
 * Find a fix suggestion for a failure and have the host show it once.
 *
 * The table of known Salesforce error codes answers first, AI on or off: it is
 * keyed on the code, so the code has to be recovered from the message with
 * {@link extractErrorCode}, the inverse of the `CODE: text` shape
 * `extractErrorMessage` produces. Only what the table cannot answer goes to
 * the model, and only while the AI stack is wired.
 *
 * Nothing is asked when no SandForge view is open — a scheduled run failing
 * with every panel closed has nobody to show an answer to — nor about a
 * message SandForge wrote itself.
 *
 * Fire-and-forget: the caller is on an error path and must not wait, and a
 * resolution that fails is an extra the user never asked for — it is logged,
 * not surfaced.
 */
function resolveFailedOperation(
  deps: OperationFailedDeps,
  error: string,
  context: OperationContext = {},
): void {
  const watched = deps.broker.panelCount > 0;
  if (!watched || isSandForgeAuthoredFailure(error)) return;

  const errorCode = extractErrorCode(error, hasKnownResolution) ?? 'UNKNOWN';
  const known = resolveKnownError({ errorCode, message: error });
  if (known) {
    deps.broker.showFixSuggestion({ source: 'knowledge-base', text: suggestedFix(known) });
    return;
  }

  const resolver = deps.errorResolver;
  if (!resolver) return;

  resolver
    // A line the handler could not fill is left out of the prompt.
    .resolveError({ errorCode, message: error }, context)
    .then((resolution) => {
      deps.broker.showFixSuggestion({ source: 'model', text: suggestedFix(resolution) });
    })
    .catch((err: unknown) => {
      deps.log?.(`[ERR] operation:failed resolution: ${extractErrorMessage(err)}`);
    });
}

/** The line a notification has room for: the first suggestion, else the explanation. */
function suggestedFix(resolution: {
  explanation: string;
  suggestions: ReadonlyArray<{ description: string }>;
}): string {
  return resolution.suggestions[0]?.description || resolution.explanation;
}
