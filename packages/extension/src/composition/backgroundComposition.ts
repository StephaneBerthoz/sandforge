import * as vscode from 'vscode';
import { PerformanceTracker } from '../core/engine/PerformanceTracker';
import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import { OfflineManager } from '../core/connection/OfflineManager';
import { ProductionGuard } from '../core/precheck/ProductionGuard';
import type {
  AutomationConfirmation,
  FiredOnInsert,
  ReadConfirmation,
  RehearsalConfirmation,
  RunConfirmation,
  RunUpdateStep,
  WriteConfirmation,
} from '../core/precheck/ProductionGuard';
import { PIIDetector } from '../core/precheck/PIIDetector';
import type { ForgeRemovalRisk } from '@sandforge/shared';
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

/** One line per Flow, process, workflow rule and trigger that fires, as many as a question lists. */
function firedLines(fired: readonly FiredOnInsert[]): string[] {
  const lines = fired
    .slice(0, LISTED_IN_A_QUESTION)
    .map((entry) =>
      entry.kind === 'flow'
        ? vscode.l10n.t('• {0}: Flow "{1}"', entry.objectApiName, entry.name)
        : entry.kind === 'process'
          ? vscode.l10n.t('• {0}: process "{1}"', entry.objectApiName, entry.name)
          : entry.kind === 'workflowRule'
            ? vscode.l10n.t('• {0}: workflow rule "{1}"', entry.objectApiName, entry.name)
            : vscode.l10n.t('• {0}: Apex trigger {1}', entry.objectApiName, entry.name),
    );
  if (fired.length > LISTED_IN_A_QUESTION) {
    lines.push(vscode.l10n.t('• and {0} more', fired.length - LISTED_IN_A_QUESTION));
  }
  return lines;
}

/** What could not be read of the target's automation, one line per part. */
function unreadLines(unread: AutomationConfirmation['unread'], org: string): string[] {
  return unread.map(({ part, reason }) =>
    part === 'flows'
      ? vscode.l10n.t('The Flows of {0} could not be read ({1}).', org, reason)
      : part === 'triggers'
        ? vscode.l10n.t('The Apex triggers of {0} could not be read ({1}).', org, reason)
        : part === 'processes'
          ? vscode.l10n.t(
              'The Process Builder processes of {0} could not be read ({1}).',
              org,
              reason,
            )
          : part === 'workflowRules'
            ? vscode.l10n.t('The workflow rules of {0} could not be read ({1}).', org, reason)
            : vscode.l10n.t('The automation of {0} could not be read ({1}).', org, reason),
  );
}

/** Why the clone writes a record it inserted a second time, as a question says it. */
function updateStepWords(step: RunUpdateStep): string {
  switch (step) {
    case 'lookups':
      return vscode.l10n.t('a lookup filled in once its record exists');
    case 'statuses':
      return vscode.l10n.t(
        'an order or a contract given back its status after it went in as a draft',
      );
    case 'invitees':
      return vscode.l10n.t('an invitee of an event given its answer');
    case 'retry':
      return vscode.l10n.t('a lookup the run it retries left empty filled in');
    case 'upsert':
      return vscode.l10n.t('a record the target holds written over');
  }
}

/**
 * What a question says of each bypass the user the clone writes as does not
 * hold: the permission set that holds it and the command that assigns it,
 * which the modal's button copies; or that none holds it.
 */
function assignLines(question: AutomationConfirmation): string[] {
  return question.assign.flatMap((entry) => {
    if (entry.command && entry.permissionSet) {
      return [
        entry.others.length > 0
          ? vscode.l10n.t(
              '{0} is the smallest permission set of {1} that holds {2} ({3} hold it too). Assigned to the user the clone writes as, it keeps quiet what {2} excludes:',
              entry.permissionSet,
              question.org,
              entry.permission,
              entry.others.join(', '),
            )
          : vscode.l10n.t(
              '{0} is the smallest permission set of {1} that holds {2}. Assigned to the user the clone writes as, it keeps quiet what {2} excludes:',
              entry.permissionSet,
              question.org,
              entry.permission,
            ),
        entry.command,
      ];
    }
    return entry.noneHolds
      ? [
          vscode.l10n.t(
            'No permission set of {0} holds {1}: an admin creates one that includes it, and assigns it to the user the clone writes as.',
            question.org,
            entry.permission,
          ),
        ]
      : [];
  });
}

/** The commands a question's button copies: one per bypass a permission set holds. */
function assignCommands(question: RunConfirmation): string[] {
  return question.stage === 'automation'
    ? question.assign.flatMap((entry) => (entry.command ? [entry.command] : []))
    : [];
}

/**
 * What a run's question says of what fires in the target as the run inserts
 * and updates. One asked only for what may refuse a removal — a run started
 * with Clone directly, which never showed Review — says first that nothing
 * fires: the lines that follow are the whole of why it asks.
 */
function automationQuestion(question: AutomationConfirmation): string[] {
  const lines: string[] = [];
  if (
    question.fired.length === 0 &&
    question.firedOnUpdate.length === 0 &&
    question.unread.length === 0
  ) {
    lines.push(
      vscode.l10n.t(
        '{0} runs no automation as this clone inserts and updates its records.',
        question.org,
      ),
    );
  }
  if (question.fired.length > 0) {
    lines.push(
      vscode.l10n.t('{0} runs automation on the records this clone inserts:', question.org),
    );
    lines.push(...firedLines(question.fired));
    lines.push(
      vscode.l10n.t(
        'They run on every record the clone inserts, and what they send goes out as it would for a record created by hand.',
      ),
    );
  }
  if (question.firedOnUpdate.length > 0) {
    lines.push(
      vscode.l10n.t(
        '{0} runs automation as this clone updates records it inserted ({1}):',
        question.org,
        question.updateSteps.map(updateStepWords).join('; '),
      ),
    );
    lines.push(...firedLines(question.firedOnUpdate));
  }
  if (question.bypass.length > 0 && question.fired.length + question.firedOnUpdate.length > 0) {
    lines.push(
      vscode.l10n.t(
        'A user who holds {0} does not start some of these Flows: assign it to the user the clone writes as to keep them quiet.',
        question.bypass.join(', '),
      ),
    );
    lines.push(...assignLines(question));
  }
  lines.push(...unreadLines(question.unread, question.org));
  if (question.unread.length > 0) {
    lines.push(vscode.l10n.t('What fires as the clone inserts its records is not known.'));
  }
  if (assignCommands(question).length > 0) {
    lines.push(
      vscode.l10n.t(
        'Copy the command copies it and cancels the clone: SandForge never runs it. Run it, then execute the clone again.',
      ),
    );
  }
  lines.push(...removalRiskLines(question.removal ?? []));
  lines.push(vscode.l10n.t('Nothing has been read or written yet.'));
  return lines;
}

/**
 * What may refuse the removal of the records the clone creates, one line per
 * object and cause, as many as a question lists: said before the run, where
 * the user decides on it, not when a removal is refused.
 */
function removalRiskLines(risks: readonly ForgeRemovalRisk[]): string[] {
  if (risks.length === 0) return [];
  const lines = [vscode.l10n.t('A removal of the records this clone creates may be refused:')];
  for (const { objectApiName, kind, name = '' } of risks.slice(0, LISTED_IN_A_QUESTION)) {
    lines.push(
      kind === 'flow'
        ? vscode.l10n.t(
            '• {0}: Flow "{1}" runs before a record is deleted, and can refuse the delete',
            objectApiName,
            name,
          )
        : kind === 'trigger'
          ? vscode.l10n.t(
              '• {0}: Apex trigger {1} runs on a delete, and can refuse it',
              objectApiName,
              name,
            )
          : kind === 'packageTrigger'
            ? vscode.l10n.t(
                '• {0}: Apex trigger {1}, installed by a managed package, runs on a delete and can refuse it; no one in the org can change it',
                objectApiName,
                name,
              )
            : vscode.l10n.t(
                '• {0}: once activated, a record locks the records under it, which a removal then takes only with it, or once it is back in Draft',
                objectApiName,
              ),
    );
  }
  if (risks.length > LISTED_IN_A_QUESTION) {
    lines.push(vscode.l10n.t('• and {0} more', risks.length - LISTED_IN_A_QUESTION));
  }
  return lines;
}

/**
 * What a run's question says of the source tables it reads with no cap past
 * the ceiling, before it reads them: the rows each holds, and why that many
 * may be too many to hold at once.
 */
function readQuestion(question: ReadConfirmation): string[] {
  const lines = [
    vscode.l10n.t(
      'This clone reads these tables of {0} with no cap per object, and each holds more than {1} records:',
      question.source,
      question.ceiling,
    ),
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
  lines.push(
    vscode.l10n.t(
      'The clone holds every record it reads of an object until it writes them: past {0} records of one object, VS Code may run out of memory. A clone of one record reads only what its record reaches of each table. To read fewer, set Records per object on the Forge page.',
      question.ceiling,
    ),
    vscode.l10n.t('Nothing has been read or written yet.'),
  );
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
  // The daily email limits the records take the target past: the rest of
  // them would be refused one by one, as the flow that sends fails.
  for (const over of question.emails ?? []) {
    const perRecord = over.objects
      .map(({ objectApiName, perRecord }) => `${objectApiName} ${perRecord}`)
      .join(', ');
    lines.push(
      over.limit === 'SingleEmail'
        ? vscode.l10n.t(
            'These records make the flows of {0} send about {1} single emails, more than the {2} of {3} it has left today (emails per record: {4}). Past them, a record whose flow fails in the save is refused.',
            question.org,
            over.emails,
            over.remaining,
            over.max,
            perRecord,
          )
        : vscode.l10n.t(
            'These records make the flows of {0} send about {1} workflow emails, more than the {2} of {3} it has left today (emails per record: {4}). Past them, a record whose flow fails in the save is refused.',
            question.org,
            over.emails,
            over.remaining,
            over.max,
            perRecord,
          ),
    );
  }
  lines.push(vscode.l10n.t('The records have been read, and nothing has been written yet.'));
  return lines;
}

/**
 * What a rehearsal's question says: the records it creates, the updates it
 * makes of them and the calls it costs, what the target runs as they are
 * created and updated, and what a rollback takes back and what it does not.
 */
function rehearsalQuestion(question: RehearsalConfirmation): string[] {
  const lines = [
    vscode.l10n.t(
      'This rehearsal creates {0} of the {1} records this clone would create in {2}, and rolls each call back whole.',
      question.sampled,
      question.rows,
      question.org,
    ),
  ];
  if (question.updates > 0) {
    lines.push(
      vscode.l10n.t(
        'It also makes {0} of the updates the clone makes after its inserts, each in the call that creates its record.',
        question.updates,
      ),
    );
  }
  lines.push(
    vscode.l10n.t(
      'It costs {0} composite API calls, {1} at most if a call stops at a refused record.',
      question.calls,
      question.maxCalls,
    ),
  );
  if (question.fired.length > 0) {
    lines.push(
      vscode.l10n.t('{0} runs automation on the records this rehearsal creates:', question.org),
    );
    lines.push(...firedLines(question.fired));
  }
  // An order given back its status in a client's sandbox started a flow that
  // sent it to an external system: inside a call, a callout already made is
  // not taken back.
  if (question.firedOnUpdate.length > 0) {
    lines.push(
      vscode.l10n.t(
        '{0} runs automation as this rehearsal updates the records it creates:',
        question.org,
      ),
    );
    lines.push(...firedLines(question.firedOnUpdate));
  }
  lines.push(...unreadLines(question.unread, question.org));
  if (question.unread.length > 0) {
    lines.push(vscode.l10n.t('What fires as the rehearsal creates its records is not known.'));
  }
  // Read on a trap org (the trap kit's probe 16): after a rolled-back insert,
  // only the event published at once was delivered, and its subscriber's
  // write kept; the queued and future jobs, the event published after commit,
  // and the Flow's path after commit and its path scheduled zero minutes on
  // never ran, where the same insert committed ran all six.
  lines.push(
    vscode.l10n.t(
      'Rolled back with each call, and never sent: emails, @future and Queueable jobs, platform events published after commit, and the asynchronous paths of Flows.',
    ),
    vscode.l10n.t(
      'Not rolled back: platform events published immediately, and callouts already made.',
    ),
    vscode.l10n.t(
      'The records have been read, and nothing has been sent to {0} yet.',
      question.org,
    ),
  );
  return lines;
}

/**
 * What the modal says of a run's question, in the user's language: before
 * it reads, what fires in the target as it inserts, and the tables it reads
 * past the ceiling; before it writes, the records per object and the storage
 * they take; before a rehearsal's first call, what it creates and what still
 * goes out. Exported so it can be tested.
 */
export function runQuestionDetail(question: RunConfirmation): string {
  return (
    question.stage === 'automation'
      ? automationQuestion(question)
      : question.stage === 'read'
        ? readQuestion(question)
        : question.stage === 'rehearsal'
          ? rehearsalQuestion(question)
          : writeQuestion(question)
  ).join('\n');
}

/**
 * Put a run's question to the user, in the modal the production confirmation
 * uses: the run goes on only when the user presses its button.
 */
export async function confirmRun(question: RunConfirmation): Promise<boolean> {
  // Compared against the same localized value it is shown with (see the
  // production confirmation below).
  const rehearsal = question.stage === 'rehearsal';
  const go = rehearsal ? vscode.l10n.t('Rehearse') : vscode.l10n.t('Execute');
  // A modal's text cannot be selected everywhere: the command that would
  // assign a bypass goes to the clipboard from a button of its own. It
  // cancels the clone, which the user runs again once the command ran.
  const commands = assignCommands(question);
  const copy = vscode.l10n.t('Copy the command');
  const choice = await vscode.window.showWarningMessage(
    rehearsal
      ? vscode.l10n.t('SandForge: confirm this rehearsal')
      : vscode.l10n.t('SandForge: confirm this clone'),
    { modal: true, detail: runQuestionDetail(question) },
    ...(commands.length > 0 ? [go, copy] : [go]),
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(commands.join('\n'));
    return false;
  }
  return choice === go;
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
