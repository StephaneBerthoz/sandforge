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
 * Infrastructure services + the background operation registry.
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
 * queued on transport failure, restarted on drain, or dropped after a failed
 * replay. Side-effecting by design — call from `activate()`.
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
          vscode.l10n.t(
            'SandForge: org unreachable — {0} operation queued, it will replay automatically when connectivity returns.',
            operation.type,
          ),
        );
        break;
      case 'operationExecuted':
        // The drain only proves the queued operation was handed back to its
        // handler (startExecution returns right after registry registration) —
        // NOT that the replay succeeded. The outcome surfaces separately via
        // the operation:failed / registry lifecycle notifications.
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'SandForge: queued {0} operation restarted — it is running again in the background.',
            operation.type,
          ),
        );
        break;
      case 'operationFailed':
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'SandForge: queued {0} operation could not be replayed and was dropped from the offline queue.',
            operation.type,
          ),
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
      // The action label doubles as the equality check, so it MUST be the same
      // value on both sides — comparing against a hardcoded 'Execute' would
      // make the guard always-false (i.e. silently deny every prod write) as
      // soon as the UI runs in a translated locale.
      const execute = vscode.l10n.t('Execute');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('SandForge: production operation'),
        {
          modal: true,
          detail: vscode.l10n.t(
            '{0}\n\nThis operation writes data to a PRODUCTION org.',
            impactSummary,
          ),
        },
        execute,
      );
      return choice === execute;
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
        // Four variants rather than one string plus a glued-on suffix: the
        // summary separator and word order are not the translator's to guess.
        const summary = operation.resultSummary;
        const label =
          type === 'completed'
            ? summary
              ? vscode.l10n.t('SandForge: {0} completed — {1}', operation.module, summary)
              : vscode.l10n.t('SandForge: {0} completed', operation.module)
            : summary
              ? vscode.l10n.t('SandForge: {0} failed — {1}', operation.module, summary)
              : vscode.l10n.t('SandForge: {0} failed', operation.module);
        // Same label/equality coupling as the production modal above.
        const showDetails = vscode.l10n.t('Show Details');
        void vscode.window.showInformationMessage(label, showDetails).then((action) => {
          if (action === showDetails) {
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
