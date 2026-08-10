import * as vscode from 'vscode';
import { PerformanceTracker } from '../core/engine/PerformanceTracker';
import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import { OfflineManager } from '../core/connection/OfflineManager';
import { ProductionGuard } from '../core/precheck/ProductionGuard';
import { PIIDetector } from '../core/precheck/PIIDetector';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { Services } from '../services.js';

/** Inputs required to build the infrastructure/background service layer. */
export interface BackgroundCompositionDeps {
  services: Services;
  configStore: ConfigStore;
}

/**
 * Infrastructure services (Tier 1) + the background operation registry.
 * All constructors are cheap and side-effect free.
 */
export interface BackgroundComposition {
  performanceTracker: PerformanceTracker;
  productionGuard: ProductionGuard;
  offlineManager: OfflineManager;
  piiDetector: PIIDetector;
  backgroundRegistry: BackgroundOperationRegistry;
}

/**
 * Connectivity probe for the {@link OfflineManager}: a HEAD request against
 * the Salesforce login endpoint. Any HTTP response (even an error status)
 * proves network reachability, so only transport-level failures (DNS, TCP,
 * TLS, 5 s timeout) report offline.
 */
export async function probeSalesforceConnectivity(): Promise<boolean> {
  try {
    await fetch('https://login.salesforce.com', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire and start OfflineManager connectivity probing (30 s tick).
 *
 * Side-effecting by design — call from `activate()`, never from
 * `createBackgroundComposition` (whose constructors stay side-effect free).
 * Probing stops via `offlineManager.dispose()` on deactivate.
 */
export function startOfflineProbing(offlineManager: OfflineManager): void {
  offlineManager.setProbeExecutor(probeSalesforceConnectivity);
  offlineManager.startProbing();
}

/**
 * Wire the OfflineManager replay executor: operations queued on transport
 * failure (see the `isNetworkError` enqueue in SyncOpsHandler — seeds are no
 * longer queued, their inserts are not idempotent; only `seed` entries
 * persisted by earlier versions can still surface here) are replayed through
 * the bridge handlers when connectivity returns and the queue drains.
 * Side-effecting by design — call from `activate()` once the handlers exist
 * (after `applyLateServices`).
 */
export function wireOfflineReplay(
  offlineManager: OfflineManager,
  handlers: ExtensionHandlers,
): void {
  offlineManager.setOperationExecutor((operation) => handlers.replayQueuedOperation(operation));
}

/**
 * Surface offline-queue lifecycle events to the user. `OfflineManager.onEvent`
 * has no other production listener and `WebviewState` has no offline channel,
 * so native VS Code notifications are the only signal that an operation was
 * queued on transport failure, replayed, or dropped after a failed replay.
 * Side-effecting by design — call from `activate()`.
 */
export function wireOfflineNotifications(offlineManager: OfflineManager): void {
  offlineManager.onEvent((event) => {
    const operation = event.operation;
    if (!operation) {
      return;
    }
    switch (event.type) {
      case 'operationQueued':
        void vscode.window.showInformationMessage(
          `SandForge: org unreachable — ${operation.type} operation queued, it will replay automatically when connectivity returns.`,
        );
        break;
      case 'operationExecuted':
        void vscode.window.showInformationMessage(
          `SandForge: queued ${operation.type} operation replayed.`,
        );
        break;
      case 'operationFailed':
        void vscode.window.showWarningMessage(
          `SandForge: queued ${operation.type} operation could not be replayed and was dropped from the offline queue.`,
        );
        break;
      default:
        break;
    }
  });
}

/**
 * Build the infrastructure layer: perf tracker, production guard, offline
 * manager, PII detector, and the background operation registry.
 * Extracted from `activate()` — behaviour unchanged.
 */
export function createBackgroundComposition(
  deps: BackgroundCompositionDeps,
): BackgroundComposition {
  const { services, configStore } = deps;

  const performanceTracker = new PerformanceTracker();
  // Safety settings are read live so toggling them takes effect without reload:
  // - `safety.requireProdConfirmation` gates the modal confirmation shown
  //   before any write to a production org;
  // - `safety.auditLogging` gates ProductionGuard audit-log writes.
  const productionGuard = new ProductionGuard({
    isProdConfirmationRequired: () =>
      services.getSandforgeSetting('safety.requireProdConfirmation', true),
    isAuditLoggingEnabled: () => services.getSandforgeSetting('safety.auditLogging', true),
    requestConfirmation: async (impactSummary) => {
      const choice = await vscode.window.showWarningMessage(
        'SandForge: production operation',
        {
          modal: true,
          detail: `${impactSummary}\n\nThis operation writes data to a PRODUCTION org.`,
        },
        'Execute',
      );
      return choice === 'Execute';
    },
  });
  const offlineManager = new OfflineManager(configStore);
  const piiDetector = new PIIDetector();
  const backgroundRegistry = new BackgroundOperationRegistry();

  return { performanceTracker, productionGuard, offlineManager, piiDetector, backgroundRegistry };
}

/** Inputs for wiring background-operation lifecycle notifications. */
export interface BackgroundNotificationDeps {
  backgroundRegistry: BackgroundOperationRegistry;
  stateSync: WebviewStateSync;
  panelManager: WebviewPanelManager;
}

/**
 * Wire BackgroundOperationRegistry events to stateSync + native notifications.
 * Must be called after the panel manager exists (notifications deep-link into
 * the Monitor panel). Extracted from `activate()` — behaviour unchanged.
 */
export function wireBackgroundNotifications(deps: BackgroundNotificationDeps): void {
  const { backgroundRegistry, stateSync, panelManager } = deps;

  backgroundRegistry.onEvent((operationId, type, operation) => {
    if (type === 'completed' || type === 'failed') {
      stateSync.setActiveOperations(backgroundRegistry.getActiveOperations());

      // Native VSCode notification if no SandForge panel is visible
      if (!panelManager.isAnyPanelVisible() && !operation.notifiedNatively) {
        backgroundRegistry.markNotifiedNatively(operationId);
        const label =
          type === 'completed'
            ? `SandForge: ${operation.module} completed${operation.resultSummary ? ' — ' + operation.resultSummary : ''}`
            : `SandForge: ${operation.module} failed${operation.resultSummary ? ' — ' + operation.resultSummary : ''}`;
        vscode.window.showInformationMessage(label, 'Show Details').then((action) => {
          if (action === 'Show Details') {
            // Open the Monitor module — openPanel only assigns webview.html
            // when a moduleId is provided (same id as sandforge.openMonitor).
            panelManager.openPanel({
              viewType: 'sandforge.monitor',
              title: 'SandForge: Monitor',
              moduleId: 'monitor',
              column: 1,
            });
          }
        });
      }
    }
    if (type === 'started' || type === 'progress') {
      stateSync.setActiveOperations(backgroundRegistry.getActiveOperations());
    }
  });
}
