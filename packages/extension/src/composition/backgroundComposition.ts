import * as vscode from 'vscode';
import { PerformanceTracker } from '../core/engine/PerformanceTracker';
import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import { OfflineManager } from '../core/connection/OfflineManager';
import { ProductionGuard } from '../core/precheck/ProductionGuard';
import type {
  AutomationConfirmation,
  RunConfirmation,
  WriteConfirmation,
} from '../core/precheck/ProductionGuard';
import { PIIDetector } from '../core/precheck/PIIDetector';
import { formatMB } from '../modules/forge/ForgeRunGate';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { ReplacedOrgRestoreQuestion } from '../bridge/handlers/HandlerTypes';
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
 * The confirmation a restore asks for before it writes into an org that now
 * answers with another org id than the one its backup was taken from.
 *
 * A modal, like the production confirmation: a sandbox refresh keeps the org
 * registered under the same id, and the restore would otherwise go ahead as
 * though the backed-up records were still there to be put back.
 *
 * @param question - The org, and the two org ids it answered with.
 * @returns Whether the user chose to restore anyway.
 */
export async function confirmRestoreIntoReplacedOrg(
  question: ReplacedOrgRestoreQuestion,
): Promise<boolean> {
  // Compared against the same localized value it is shown with (see the
  // production confirmation below).
  const restoreAnyway = vscode.l10n.t('Restore anyway');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('SandForge: restore into another org'),
    {
      modal: true,
      detail: vscode.l10n.t(
        '{0} answered as org {1} when this backup was taken, and answers as org {2} now: the org behind it changed, as it does when a sandbox is refreshed. The records the backup saved belonged to the org it was, and the restore cannot put them back. It writes their saved values into the org {0} is now, by record id.',
        question.alias,
        question.backedUpFrom,
        question.now,
      ),
    },
    restoreAnyway,
  );
  return choice === restoreAnyway;
}

/** The most entries a run's question lists before it says how many more there are. */
const LISTED_IN_A_QUESTION = 12;

/** What a run's question says of what fires in the target as the run inserts. */
function automationQuestion(question: AutomationConfirmation): string[] {
  const lines: string[] = [];
  if (question.fired.length > 0) {
    lines.push(
      vscode.l10n.t('{0} runs automation on the records this clone inserts:', question.org),
    );
    for (const fired of question.fired.slice(0, LISTED_IN_A_QUESTION)) {
      lines.push(
        fired.kind === 'flow'
          ? vscode.l10n.t('• {0}: Flow "{1}"', fired.objectApiName, fired.name)
          : vscode.l10n.t('• {0}: Apex trigger {1}', fired.objectApiName, fired.name),
      );
    }
    if (question.fired.length > LISTED_IN_A_QUESTION) {
      lines.push(vscode.l10n.t('• and {0} more', question.fired.length - LISTED_IN_A_QUESTION));
    }
    lines.push(
      vscode.l10n.t(
        'They run on every record the clone inserts, and what they send goes out as it would for a record created by hand.',
      ),
    );
    if (question.bypass.length > 0) {
      lines.push(
        vscode.l10n.t(
          'A user who holds {0} does not start some of these Flows: assign it to the user the clone writes as to keep them quiet.',
          question.bypass.join(', '),
        ),
      );
    }
  }
  for (const { part, reason } of question.unread) {
    lines.push(
      part === 'flows'
        ? vscode.l10n.t('The Flows of {0} could not be read ({1}).', question.org, reason)
        : part === 'triggers'
          ? vscode.l10n.t('The Apex triggers of {0} could not be read ({1}).', question.org, reason)
          : vscode.l10n.t('The automation of {0} could not be read ({1}).', question.org, reason),
    );
  }
  if (question.unread.length > 0) {
    lines.push(vscode.l10n.t('What fires as the clone inserts its records is not known.'));
  }
  lines.push(vscode.l10n.t('Nothing has been read or written yet.'));
  return lines;
}

/** What a run's question says of the rows it is about to write, and their storage. */
function writeQuestion(question: WriteConfirmation): string[] {
  const lines = [
    vscode.l10n.t('This clone is about to write {0} records to {1}:', question.total, question.org),
  ];
  // Names and counts alone: nothing in them to translate.
  for (const { objectApiName, rows } of question.objects.slice(0, LISTED_IN_A_QUESTION)) {
    lines.push(`• ${objectApiName}: ${rows}`);
  }
  const rest = question.objects.slice(LISTED_IN_A_QUESTION);
  if (rest.length > 0) {
    lines.push(
      vscode.l10n.t(
        '• and {0} more objects, {1} records',
        rest.length,
        rest.reduce((sum, object) => sum + object.rows, 0),
      ),
    );
  }
  if (question.aboveRecords !== undefined) {
    lines.push(
      vscode.l10n.t(
        'That is more than {0} records, past which the sandforge.safety.confirmAboveRecords setting asks.',
        question.aboveRecords,
      ),
    );
  }
  if (question.largeVolume !== undefined) {
    lines.push(
      vscode.l10n.t('More than {0} records is a large volume for this org.', question.largeVolume),
    );
  }
  const { storage } = question;
  if ('unread' in storage) {
    lines.push(
      vscode.l10n.t(
        'They take about {0} MB of data storage. What {1} has left could not be read ({2}), so whether they fit is not known.',
        formatMB(storage.estimateMB),
        question.org,
        storage.unread,
      ),
    );
  } else {
    lines.push(
      vscode.l10n.t(
        'They take about {0} MB of data storage; {1} has {2} MB left of {3} MB.',
        formatMB(storage.estimateMB),
        question.org,
        storage.remainingMB,
        storage.maxMB,
      ),
    );
    if (storage.near) {
      lines.push(
        vscode.l10n.t(
          'That is more than 80% of what is left. Salesforce counts storage a while after a load, so less may be left than it says.',
        ),
      );
    }
  }
  lines.push(vscode.l10n.t('The records have been read, and nothing has been written yet.'));
  return lines;
}

/**
 * What the modal says of a run's question, in the user's language: before
 * it reads, what fires in the target as it inserts; before it writes, the
 * records per object and the storage they take. Exported so it can be tested.
 */
export function runQuestionDetail(question: RunConfirmation): string {
  return (
    question.stage === 'automation' ? automationQuestion(question) : writeQuestion(question)
  ).join('\n');
}

/**
 * Put a run's question to the user, in the modal the production confirmation
 * uses: the run goes on only when the user presses its button.
 */
export async function confirmRun(question: RunConfirmation): Promise<boolean> {
  // Compared against the same localized value it is shown with (see the
  // production confirmation below).
  const execute = vscode.l10n.t('Execute');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('SandForge: confirm this clone'),
    { modal: true, detail: runQuestionDetail(question) },
    execute,
  );
  return choice === execute;
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
 * Wire and enable OfflineManager connectivity probing. The 30 s probe only
 * ticks while an operation waits in the offline queue or the last probe found
 * the network down (see `OfflineManager.startProbing`), so an idle window
 * sends no request.
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
  // `safety.requireProdConfirmation` gates the modal confirmation shown before
  // any write to a production org. `safety.auditLogging` is read where the
  // decisions are kept, by the audit trail.
  const productionGuard = new ProductionGuard({
    isProdConfirmationRequired: () =>
      services.getSandforgeSetting('safety.requireProdConfirmation', true),
    requestConfirmation: async (impactSummary, orgTier) => {
      // The action label doubles as the equality check, so it MUST be the same
      // value on both sides — comparing against a hardcoded 'Execute' would
      // make the guard always-false (i.e. silently deny every prod write) as
      // soon as the UI runs in a translated locale.
      const execute = vscode.l10n.t('Execute');
      // Staging asks too, before a delete, a deployment or a large volume, and
      // was told it wrote data to a production org. The summary above the
      // sentence already names the tier and what the operation does.
      const production = orgTier === 'production';
      const choice = await vscode.window.showWarningMessage(
        production
          ? vscode.l10n.t('SandForge: production operation')
          : vscode.l10n.t('SandForge: operation to confirm'),
        {
          modal: true,
          detail: production
            ? vscode.l10n.t('{0}\n\nThis operation writes data to a PRODUCTION org.', impactSummary)
            : vscode.l10n.t(
                '{0}\n\nThis operation needs your confirmation before it runs.',
                impactSummary,
              ),
        },
        execute,
      );
      return choice === execute;
    },
    // A run's own questions — what fires as a clone inserts, what it is
    // about to write — go through the same kind of modal. No setting turns
    // them off: `safety.requireProdConfirmation` is the production one's.
    requestRunConfirmation: confirmRun,
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
 * What the native notification says of an operation that ended: one sentence
 * per way of ending, with and without the summary. Whole variants rather than
 * one string plus a glued-on suffix: the summary separator and word order are
 * not the translator's to guess.
 */
function endedLabel(
  type: 'completed' | 'failed' | 'aborted',
  module: string,
  summary: string | undefined,
): string {
  switch (type) {
    case 'completed':
      return summary
        ? vscode.l10n.t('SandForge: {0} completed — {1}', module, summary)
        : vscode.l10n.t('SandForge: {0} completed', module);
    case 'failed':
      return summary
        ? vscode.l10n.t('SandForge: {0} failed — {1}', module, summary)
        : vscode.l10n.t('SandForge: {0} failed', module);
    case 'aborted':
      return summary
        ? vscode.l10n.t('SandForge: {0} cancelled — {1}', module, summary)
        : vscode.l10n.t('SandForge: {0} cancelled', module);
  }
}

/**
 * Wire BackgroundOperationRegistry events to stateSync + native notifications.
 * Must be called after the panel manager exists (notifications deep-link into
 * the Monitor panel).
 *
 * An operation stopped through the registry (Cancel in Live Operations, a
 * pipeline run stopped, a cancelled snapshot) ends with an `aborted` event,
 * which used to be passed over: the operations the panels were sent still
 * listed it as running, and nothing said it had stopped.
 */
export function wireBackgroundNotifications(deps: BackgroundNotificationDeps): void {
  const { backgroundRegistry, stateSync, panelManager } = deps;

  backgroundRegistry.onEvent((operationId, type, operation) => {
    if (type === 'completed' || type === 'failed' || type === 'aborted') {
      stateSync.setActiveOperations(backgroundRegistry.getActiveOperations());

      // Native VSCode notification if no SandForge panel is visible
      if (!panelManager.isAnyPanelVisible() && !operation.notifiedNatively) {
        backgroundRegistry.markNotifiedNatively(operationId);
        const label = endedLabel(type, operation.module, operation.resultSummary);
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
