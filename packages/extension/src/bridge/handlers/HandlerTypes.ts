import type { BaseMessage, NotificationMessage } from '@sandforge/shared';
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
  /** Generates sequential message IDs. */
  nextId: () => string;
}

/**
 * Interface that all domain handlers must implement.
 *
 * Each handler is responsible for a specific domain of message types
 * and routes incoming messages to the appropriate internal method.
 */
export interface DomainHandler {
  /** Handle an incoming bridge message.
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  handle(msg: BaseMessage): Promise<boolean>;
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
  const msg: BaseMessage & { payload: { operationId: string; module: string; description: string } } = {
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
  const msg: BaseMessage & { payload: { operationId: string; percentage: number; processedRecords: number; totalRecords: number; currentStep: string } } = {
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

/**
 * Log an error and send an error response message to the webview.
 *
 * Consolidates the repeated catch-block pattern found across domain handlers:
 * extract message, log `[ERR]`, post typed error message, log `[TX]`.
 *
 * @param deps - Handler dependencies containing log, broker, and nextId.
 * @param context - Short label for the log prefix (e.g. `"sync:describe-global"`).
 * @param messageType - The outgoing message type (e.g. `"sync:error"`).
 * @param err - The caught unknown error value.
 */
export function sendHandlerError(
  deps: Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>,
  context: string,
  messageType: string,
  err: unknown,
): void {
  const message = extractErrorMessage(err);
  deps.log(`[ERR] ${context}: ${message}`);
  const errMsg: BaseMessage & { payload: { message: string } } = {
    id: deps.nextId(),
    type: messageType,
    timestamp: Date.now(),
    payload: { message },
  };
  deps.broker.postToWebview(errMsg);
  deps.log(`[TX] ${messageType}: ${message}`);
}

/** Send operation:failed lifecycle message. */
export function sendOperationFailed(
  deps: Pick<HandlerDeps, 'broker' | 'nextId'>,
  operationId: string,
  error: string,
  retryable: boolean,
): void {
  const msg: BaseMessage & { payload: { operationId: string; error: string; retryable: boolean } } = {
    id: deps.nextId(),
    type: 'operation:failed',
    timestamp: Date.now(),
    payload: { operationId, error, retryable },
  };
  deps.broker.postToWebview(msg);
}
