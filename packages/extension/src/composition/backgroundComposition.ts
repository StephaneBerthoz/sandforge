import * as vscode from 'vscode';
import { PerformanceTracker } from '../core/engine/PerformanceTracker';
import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry';
import { OfflineManager } from '../core/connection/OfflineManager';
import {
  ProductionGuard,
  RELATED_RECORDS_ALSO_WRITTEN,
  checkpointQuestionLines,
  inQuestionOrder,
  type CheckpointQuestionWords,
  type QuestionWords,
  type SafetyTier,
} from '../core/precheck/ProductionGuard';
import type {
  AutomationConfirmation,
  FiredOnInsert,
  ReadConfirmation,
  RehearsalConfirmation,
  RunConfirmation,
  RunUpdateStep,
  WholeOrgConfirmation,
  WholeOrgConfirmationSample,
  WriteConfirmation,
} from '../core/precheck/ProductionGuard';
import { PIIDetector } from '../core/precheck/PIIDetector';
import {
  DATA_STORAGE_NOT_TOLD,
  type EmailSender,
  type ForgeRemovalRisk,
  type RunDeliverability,
} from '@sandforge/shared';
import { formatMB } from '../modules/forge/ForgeRunGate';
import { uiLocaleOf } from '../core/i18n/catalogueText';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { WebviewStateSync } from '../bridge/WebviewStateSync';
import type { WebviewPanelManager } from '../providers/WebviewPanelManager';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type {
  CheckpointFileDialogs,
  ReplacedOrgRestoreQuestion,
  UndeletableRemovalQuestion,
} from '../bridge/handlers/HandlerTypes';

/** Inputs required to build the infrastructure/background service layer. */
export interface BackgroundCompositionDeps {
  configStore: ConfigStore;
  /** The alias of a registered org, which the production question names it by. */
  orgNameOf?: (orgId: string) => string | undefined;
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

/**
 * What a removal asks before its first write when the user SandForge connects
 * as may not delete the records of some objects of the run: remove the rest,
 * leaving those, or stop with nothing removed. A modal, as the restore's: the
 * removal deleted the children, then had every parent refused, and nothing
 * said so before it began.
 *
 * @returns Whether the user chose to remove the rest.
 */
export async function confirmRemovalLeavingUndeletable(
  question: UndeletableRemovalQuestion,
): Promise<boolean> {
  const removeTheRest = vscode.l10n.t('Remove the rest');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('SandForge: some records of the run cannot be removed'),
    { modal: true, detail: undeletableQuestionDetail(question) },
    removeTheRest,
  );
  return choice === removeTheRest;
}

/** The lines of {@link confirmRemovalLeavingUndeletable}'s question. */
function undeletableQuestionDetail(question: UndeletableRemovalQuestion): string {
  return [
    vscode.l10n.t(
      'The user SandForge connects as may not delete the records of these objects in {0}, so they stay whatever you choose:',
      question.org,
    ),
    // Names and counts alone: nothing in them to translate.
    ...question.objects.map(({ objectApiName, records }) => `• ${objectApiName}: ${records}`),
    vscode.l10n.t(
      'Remove the rest removes every other record of the run, and keeps these with the records they hang from. Cancel removes nothing.',
    ),
  ].join('\n');
}

/** The extension a checkpoint file is saved with, without its dot. */
const CHECKPOINT_FILE_EXTENSION = 'sfcheckpoint';

/**
 * The path on this machine's disk of a place a dialog picked, or a refusal in
 * words: a checkpoint's file is written and read with the disk's own calls,
 * which reach no other file system the dialog offers.
 */
function diskPathOf(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') {
    throw new Error(
      vscode.l10n.t(
        'SandForge writes and reads a checkpoint file on the disk of the machine it runs on: pick a folder there.',
      ),
    );
  }
  return uri.fsPath;
}

/**
 * The save and open dialogs a checkpoint's Export… and Import… pick their
 * file in. The save dialog opens in the home folder, never a workspace's:
 * an encrypted checkpoint saved into a repository is one commit away from
 * being pushed with it.
 *
 * @param sandforgeVersion - This SandForge's version, which an export names.
 * @param homeDir - Where the save dialog opens.
 */
export function checkpointFileDialogs(
  sandforgeVersion: string,
  homeDir: string,
): CheckpointFileDialogs {
  const filters = (): Record<string, string[]> => ({
    [vscode.l10n.t('SandForge checkpoint')]: [CHECKPOINT_FILE_EXTENSION],
  });
  return {
    sandforgeVersion,
    pickExportFile: async (suggestedName) => {
      const uri = await vscode.window.showSaveDialog({
        title: vscode.l10n.t('Export the checkpoint, encrypted'),
        saveLabel: vscode.l10n.t('Export'),
        defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homeDir), suggestedName),
        filters: filters(),
      });
      return uri ? diskPathOf(uri) : undefined;
    },
    pickImportFile: async () => {
      const picked = await vscode.window.showOpenDialog({
        title: vscode.l10n.t('Import a checkpoint file'),
        openLabel: vscode.l10n.t('Import'),
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        // A file sent through a chat or a drive can come back renamed.
        filters: { ...filters(), [vscode.l10n.t('All files')]: ['*'] },
      });
      const uri = picked?.[0];
      return uri ? diskPathOf(uri) : undefined;
    },
  };
}

/**
 * Browse… on the Migration page: the window's open dialog, for one SFDMU
 * export.json, opened in the first workspace folder or else the home folder,
 * where the import takes a file from. The page had only a field to type an
 * absolute path in, its examples Windows paths on every system.
 *
 * @param homeDir - Where the dialog opens when no folder is open.
 * @returns The path picked on this machine's disk, or undefined when the
 *   dialog was closed; a refusal in words for a file the import cannot read.
 */
export function migrationExportPicker(homeDir: string): () => Promise<string | undefined> {
  return async () => {
    const picked = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Import an SFDMU export.json'),
      openLabel: vscode.l10n.t('Import'),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homeDir),
      filters: {
        [vscode.l10n.t('SFDMU export.json')]: ['json'],
        [vscode.l10n.t('All files')]: ['*'],
      },
    });
    const uri = picked?.[0];
    if (!uri) return undefined;
    // The import reads it with the disk's own calls, which reach no other
    // file system the dialog offers.
    if (uri.scheme !== 'file') {
      throw new Error(
        vscode.l10n.t(
          'SandForge reads an SFDMU export.json from the disk of the machine it runs on: pick a file there.',
        ),
      );
    }
    return uri.fsPath;
  };
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

/** A sender of emails as the question lists it, by its kind and why it counts. */
function senderLine({ objectApiName, kind, name, why }: EmailSender): string {
  if (kind === 'assignmentRule') {
    return vscode.l10n.t(
      '• {0}: assignment rule "{1}", which can mail the owner it assigns',
      objectApiName,
      name,
    );
  }
  if (why === 'notRead') {
    return kind === 'flow'
      ? vscode.l10n.t('• {0}: Flow "{1}", whose definition was not read', objectApiName, name)
      : kind === 'process'
        ? vscode.l10n.t('• {0}: process "{1}", whose definition was not read', objectApiName, name)
        : vscode.l10n.t(
            '• {0}: workflow rule "{1}", whose definition was not read',
            objectApiName,
            name,
          );
  }
  return kind === 'flow'
    ? vscode.l10n.t('• {0}: Flow "{1}"', objectApiName, name)
    : kind === 'process'
      ? vscode.l10n.t('• {0}: process "{1}"', objectApiName, name)
      : vscode.l10n.t('• {0}: workflow rule "{1}"', objectApiName, name);
}

/**
 * What a run's question says first, when the target delivers the emails what
 * still runs sends, or would not say whether it does: that it does, who sends
 * them, and where they go — not only to the records the run writes. Nothing
 * when it delivers none of them, or nothing sends: the question then has no
 * such block. Its answer is "Execute and send the emails".
 */
function deliverabilityLines(question: {
  org: string;
  deliverability?: RunDeliverability;
}): string[] {
  const said = question.deliverability;
  if (said === undefined || ('level' in said.reading && said.reading.level === 'withheld')) {
    return [];
  }
  const { org } = question;
  const lines = [
    'unread' in said.reading
      ? vscode.l10n.t(
          'Whether {0} delivers the emails its automation sends could not be read ({1}), and what still runs as the records go in may send some:',
          org,
          said.reading.unread,
        )
      : vscode.l10n.t(
          '{0} delivers every email its automation sends (Setup > Deliverability: All email), and what still runs as the records go in may send some:',
          org,
        ),
  ];
  lines.push(...said.senders.slice(0, LISTED_IN_A_QUESTION).map(senderLine));
  if (said.senders.length > LISTED_IN_A_QUESTION) {
    lines.push(vscode.l10n.t('• and {0} more', said.senders.length - LISTED_IN_A_QUESTION));
  }
  // A part of the automation that sends emails refused whole lists nothing,
  // which is not the same as sending nothing.
  if (said.sendersUnread !== undefined) {
    lines.push(
      vscode.l10n.t('• what could not be read of its automation: {0}', said.sendersUnread),
    );
  }
  lines.push(
    said.keepsAddresses
      ? vscode.l10n.t(
          'They go to the addresses the records and the alerts name: those of the records the run writes, as they hold them, the owners of the records, the records already in {0}, and an address an alert names.',
          org,
        )
      : vscode.l10n.t(
          'They go to the addresses the records and the alerts name: those of the records the run writes are under .invalid, but not those of the owners of the records, of the records already in {0}, nor an address an alert names.',
          org,
        ),
  );
  if ('unread' in said.reading) {
    lines.push(
      vscode.l10n.t(
        'On System email only or No access (Setup > Deliverability), none of them goes out.',
      ),
    );
  }
  lines.push(vscode.l10n.t('Execute and send the emails lets them go out.'));
  return lines;
}

/**
 * What a run's question says of what fires in the target as the run inserts
 * and updates. One asked only for what may refuse a removal — a run started
 * with Clone directly, which never showed Review — says first that nothing
 * fires: the lines that follow are the whole of why it asks. Whether the
 * target delivers the emails of what still runs comes first, what leaves the
 * org before what runs in it.
 */
function automationQuestion(question: AutomationConfirmation): string[] {
  const lines: string[] = [...deliverabilityLines(question)];
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
      'A clone of whole tables reads and writes them page by page, holding one page at a time, and reads {0} records of one object at most, saying the rest was not read; a clone of one record holds every record it reads, and reads only what its record reaches of each table. To read fewer, set Records per object on the Forge page; to read more, raise sandforge.forge.maxRecordsPerObject.',
      question.ceiling,
    ),
    vscode.l10n.t('Nothing has been read or written yet.'),
  );
  return lines;
}

/**
 * What a run's question says first, of what leaves the org: whether the
 * target delivers the emails of what still runs, the daily email limits the
 * records take the target past, those it did not say it has left of, and the
 * emails no read counted.
 */
function leavesTheOrgLines(question: WriteConfirmation): string[] {
  const lines: string[] = [...deliverabilityLines(question)];
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
    // A Developer Edition counts its email alerts against its single emails:
    // counted against the workflow emails alone, a clone said it fitted.
    if (over.alertsCounted) {
      lines.push(
        vscode.l10n.t(
          '{0} counts its email alerts against its single emails too, as a Developer Edition does: they are among them.',
          question.org,
        ),
      );
    }
  }
  // The emails the records make the target send that it did not say it has
  // left of: whether they fit is not known.
  for (const unread of question.emailsUnread ?? []) {
    lines.push(
      unread.limit === 'SingleEmail'
        ? vscode.l10n.t(
            'These records make the flows of {0} send about {1} single emails. What it has left today could not be read ({2}), so whether they fit is not known.',
            question.org,
            unread.emails,
            unread.unread,
          )
        : vscode.l10n.t(
            'These records make the flows of {0} send about {1} workflow emails. What it has left today could not be read ({2}), so whether they fit is not known.',
            question.org,
            unread.emails,
            unread.unread,
          ),
    );
  }
  // What the target runs could not be read: no email of its flows was counted.
  if (question.emailsUncounted !== undefined) {
    lines.push(
      vscode.l10n.t(
        'What {0} runs on these objects could not be read ({1}), so the emails its flows send as the records go in were not counted against its daily limits.',
        question.org,
        question.emailsUncounted,
      ),
    );
  }
  return lines;
}

/**
 * The words of the checkpoint's block, in the user's language: its cost and
 * what it keeps where; why an object is added or left out is the engine's
 * sentence, put in as it is.
 */
const HOST_CHECKPOINT_WORDS: CheckpointQuestionWords = {
  cost: ({ records, objects, requests, seconds, megabytes, keepDays }) =>
    keepDays === 0
      ? vscode.l10n.t(
          'Checkpoint first: about {0} records of {1} objects, {2} API requests, {3} s, {4} MB on this machine, unencrypted, and no storage in the org, kept until you delete it.',
          records,
          objects,
          requests,
          seconds,
          megabytes,
        )
      : vscode.l10n.t(
          'Checkpoint first: about {0} records of {1} objects, {2} API requests, {3} s, {4} MB on this machine, unencrypted, and no storage in the org, kept {5} days.',
          records,
          objects,
          requests,
          seconds,
          megabytes,
          keepDays,
        ),
  added: (objectApiName, reason) => vscode.l10n.t('Added: {0} — {1}', objectApiName, reason),
  notHeld: (objectApiName, reason) =>
    vscode.l10n.t('Not in the checkpoint: {0} — {1}', objectApiName, reason),
  more: (count) => vscode.l10n.t('• and {0} more', count),
  get unknown() {
    return vscode.l10n.t(
      'What an Apex trigger, or automation that could not be read, creates as the run writes is not known: a rewind leaves those records as they are.',
    );
  },
};

/**
 * What a run's question says last, of the target's limits: the data storage
 * the rows take against what it has left, and the day's API requests the run
 * would leave it short of, each part beside the run's own named.
 */
function limitsLines(question: WriteConfirmation): string[] {
  const lines: string[] = [];
  const { storage } = question;
  if ('unread' in storage && storage.unread === DATA_STORAGE_NOT_TOLD) {
    // A Standard User's limits leave the storage out: said in the question's
    // language, not in the English reason the command line prints.
    lines.push(
      vscode.l10n.t(
        'They take about {0} MB of data storage. {1} does not tell the user the run writes as what it has left, so whether they fit is not known.',
        formatMB(storage.estimateMB),
        question.org,
      ),
    );
  } else if ('unread' in storage) {
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
  // A limit the org would not give: the user it answers needs View Setup.
  if ('unread' in question.storage || (question.emailsUnread ?? []).length > 0) {
    lines.push(
      vscode.l10n.t(
        '{0} gives its limits only to a user with View Setup and Configuration: the user SandForge connects as may not have it.',
        question.org,
      ),
    );
  }
  // The day's API requests the run would leave the org short of, and what
  // of them is not the run's own: the checkpoint taken first, the read-backs.
  // A clone of the whole org says them whatever is left, among its own lines.
  const api = question.wholeOrg ? undefined : question.apiRequests;
  if (api) {
    lines.push(
      vscode.l10n.t(
        'The run takes about {0} API requests, and {1} has {2} of its {3} daily requests left: it would leave the org with less than a tenth of them.',
        api.estimate,
        question.org,
        api.remaining,
        api.max,
      ),
    );
    const { checkpoint = 0, mute = 0, readBack = 0, deliverability = 0, fit = 0 } = api.parts ?? {};
    if (checkpoint > 0) {
      lines.push(vscode.l10n.t('{0} of them are for the checkpoint taken first.', checkpoint));
    }
    if (mute > 0) {
      lines.push(
        vscode.l10n.t(
          '{0} of them assign and take back the permission sets that mute the automation of the target.',
          mute,
        ),
      );
    }
    if (readBack > 0) {
      lines.push(
        vscode.l10n.t(
          '{0} of them read back the record type the target gave the records created without one.',
          readBack,
        ),
      );
    }
    if (deliverability > 0) {
      lines.push(
        vscode.l10n.t('{0} of them read whether the target delivers its emails.', deliverability),
      );
    }
    if (fit > 0) lines.push(vscode.l10n.t('{0} of them fit the run to the storage.', fit));
  }
  return lines;
}

/**
 * One of an org's allowances of the day, as a clone of the whole org's
 * question says it: what the run takes, what the org has left of it, and
 * whether that would leave it short; or that what is left is not known.
 */
function allowanceLines(
  allowance: WholeOrgConfirmation['targetApi'],
  words: {
    told: (estimate: number, remaining: number, max: number) => string;
    unread: (estimate: number, unread: string | undefined) => string;
    near: () => string;
  },
): string[] {
  const { estimate, remaining, max } = allowance;
  if (remaining === undefined || max === undefined) {
    return [words.unread(estimate, allowance.unread)];
  }
  return allowance.near
    ? [words.told(estimate, remaining, max), words.near()]
    : [words.told(estimate, remaining, max)];
}

/** A share of the roots of each object, as a percentage of two figures. */
function percentOf(share: number): string {
  return String(Number((share * 100).toPrecision(2)));
}

/** The bound that held a sample, as its question says it. */
function sampleLimitWords(
  limitedBy: WholeOrgConfirmationSample['limitedBy'],
  question: WriteConfirmation,
  source: string,
): string {
  switch (limitedBy) {
    case 'storage':
      return vscode.l10n.t('the data storage {0} has left', question.org);
    case 'within':
      return vscode.l10n.t('the MB asked');
    case 'maxTotal':
      return vscode.l10n.t('the records asked');
    case 'targetRequests':
      return vscode.l10n.t('the daily API requests of {0}', question.org);
    case 'bulkBatches':
      return vscode.l10n.t('the daily Bulk API batches of {0}', question.org);
    case 'sourceRequests':
      return vscode.l10n.t('the daily API requests of {0}', source);
    case 'heavyRoots':
      return vscode.l10n.t(
        'the records set aside, each past a tenth of the room {0} has: every other root fits',
        question.org,
      );
    case 'whole':
      return vscode.l10n.t(
        'nothing: every record fits, and copying the whole org is the better run',
      );
  }
}

/**
 * What the question of a sample of the whole org says of it before the lines
 * of any clone of the whole org: what it keeps of what the source holds and
 * the storage it takes of what it may; its seed, draw and share, and what
 * held it; when and by what its plan was drawn, the simulation's with its
 * age, and why the run drew its own when it did; what an optional lookup
 * outside it becomes and the children a record brings; the lookups written
 * empty, the roots set aside, the objects it keeps none of; the objects
 * copied whole as asked.
 */
function sampleLines(
  question: WriteConfirmation,
  wholeOrg: WholeOrgConfirmation,
  sample: WholeOrgConfirmationSample,
): string[] {
  const lines = [
    vscode.l10n.t(
      'The sample keeps {0} of the {1} records {2} holds of these objects: about {3} MB of the {4} MB it may take.',
      sample.rows,
      sample.sourceRows,
      wholeOrg.source,
      formatMB(sample.storageMB),
      formatMB(sample.budgetMB),
    ),
    // What the target's automation creates under its records, said apart: a
    // sample took 1.65 MB of tasks a flow opens under its contacts, and only
    // its total said them.
    ...(sample.automationMB !== undefined
      ? [
          vscode.l10n.t(
            'Of it, about {0} MB for what the automation of the target creates under its records.',
            formatMB(sample.automationMB),
          ),
        ]
      : []),
    vscode.l10n.t(
      'Drawn with seed {0}, {1}: {2} % of the roots of each object, with the records they reach; held by {3}.',
      sample.seed,
      sample.draw === 'recent'
        ? vscode.l10n.t('the newest first')
        : vscode.l10n.t('spread over the org'),
      percentOf(sample.share),
      sampleLimitWords(sample.limitedBy, question, wholeOrg.source),
    ),
    // Read newest by their ids, an object with no creation date to sort by
    // has its roots drawn, or its children kept under the cap, by an order
    // that follows the making of records within a load only: said, as the
    // newest are not quite what the word says there.
    ...(sample.newestByIds && sample.newestByIds.length > 0
      ? [
          vscode.l10n.t(
            'Newest by the order of their ids, having no creation date the org sorts by, which ids follow within a load only: {0}.',
            sample.newestByIds.slice(0, LISTED_IN_A_QUESTION).join(', ') +
              (sample.newestByIds.length > LISTED_IN_A_QUESTION ? ', …' : ''),
          ),
        ]
      : []),
    sample.drawnBy === 'dryRun' && sample.minutesBefore !== undefined
      ? vscode.l10n.t(
          'Drawn by the simulation {0} minutes before; the run takes up its plan.',
          sample.minutesBefore,
        )
      : vscode.l10n.t('Drawn by this run.'),
  ];
  if (sample.drawnAgain === 'tooOld') {
    lines.push(
      vscode.l10n.t('The plan of the simulation was more than a day old: the run drew its own.'),
    );
  } else if (sample.drawnAgain === 'setUpOtherwise') {
    lines.push(
      vscode.l10n.t(
        'The plan of the simulation was drawn for another setup: the run drew its own.',
      ),
    );
  } else if (sample.drawnAgain === 'planGone') {
    lines.push(
      vscode.l10n.t(
        'The plan of the run this one retries was gone: the run drew its own with the same options.',
      ),
    );
  }
  lines.push(
    sample.parents === 'required'
      ? vscode.l10n.t('An optional lookup to a record outside the sample is written empty.')
      : vscode.l10n.t(
          'A record outside the sample that an optional lookup names is copied, without its children.',
        ),
    sample.children === 'all'
      ? vscode.l10n.t('A record brings every child it has.')
      : vscode.l10n.t(
          'A record brings at most {0} children per relation, the newest; a master record brings every detail.',
          sample.children,
        ),
  );
  if (sample.leftEmpty !== undefined && sample.leftEmpty > 0) {
    lines.push(
      vscode.l10n.t(
        'Lookups written empty, their record outside the sample: {0}.',
        sample.leftEmpty,
      ),
    );
  }
  if (sample.heavyRoots !== undefined && sample.heavyRoots > 0) {
    lines.push(
      vscode.l10n.t(
        'Records set aside, each of which would have brought in more than a tenth of the room {1} has: {0}. The simulation names them.',
        sample.heavyRoots,
        question.org,
      ),
    );
  }
  if (sample.noRecordDrawn !== undefined && sample.noRecordDrawn > 0) {
    lines.push(
      vscode.l10n.t(
        'Objects of {0} none of whose records the sample keeps: {1}.',
        wholeOrg.source,
        sample.noRecordDrawn,
      ),
    );
  }
  const whole = wholeOrg.carried?.sample?.whole ?? [];
  if (whole.length > 0) {
    lines.push(
      vscode.l10n.t(
        'Copied whole as asked: {0}.',
        whole.slice(0, LISTED_IN_A_QUESTION).join(', ') +
          (whole.length > LISTED_IN_A_QUESTION ? ', …' : ''),
      ),
    );
  }
  return lines;
}

/**
 * What a clone of the whole org says besides its rows and their data storage,
 * as its question is always put: what it leaves out and what it was set to
 * that narrows it; the API requests it takes of both orgs, its Bulk API jobs
 * and the target's batches they take, each said short when it would run
 * short; how long it writes and what goes by REST; the files it copies; the
 * objects of managed packages it writes, whose own automation no mute
 * reaches; the phone numbers that go in empty; the personal fields it copies
 * as they are; who owns a record whose owner the target holds inactive; and
 * that a removal takes it back.
 */
function wholeOrgLines(question: WriteConfirmation, wholeOrg: WholeOrgConfirmation): string[] {
  const lines: string[] = wholeOrg.sample ? sampleLines(question, wholeOrg, wholeOrg.sample) : [];
  if (wholeOrg.leftOut > 0) {
    lines.push(
      vscode.l10n.t(
        'Left out: {0} objects that are empty or unreadable in {1}, missing from {2}, or that the API cannot create or a removal cannot take back there, setup, history, sharing and system objects among them. Review names them.',
        wholeOrg.leftOut,
        wholeOrg.source,
        question.org,
      ),
    );
  }
  // What the run was set to that narrows it: carried over from a template
  // or a run, or set on Review, which the configuration does not tell apart.
  const { carried } = wholeOrg;
  if (carried && carried.filters.length > 0) {
    lines.push(
      vscode.l10n.t('Read through a filter rather than whole: {0}.', carried.filters.join(', ')),
    );
  }
  if (carried && carried.excluded.length > 0) {
    lines.push(
      vscode.l10n.t(
        'Carried over from the template or run this clone started from, left out by name: {0}.',
        carried.excluded.join(', '),
      ),
    );
  }
  if (carried && carried.heldBack.length > 0) {
    lines.push(
      vscode.l10n.t(
        'Copied without the rows a decision on Gaps holds back: {0}.',
        carried.heldBack.join(', '),
      ),
    );
  }
  if (carried && carried.fieldsLeftOut.length > 0) {
    lines.push(
      vscode.l10n.t('Copied without some of their fields: {0}.', carried.fieldsLeftOut.join(', ')),
    );
  }
  lines.push(
    ...allowanceLines(wholeOrg.targetApi, {
      told: (estimate, remaining, max) =>
        vscode.l10n.t(
          'API requests of {0}, to write: about {1}; it has {2} of its {3} daily requests left.',
          question.org,
          estimate,
          remaining,
          max,
        ),
      unread: () =>
        vscode.l10n.t(
          'What {0} has left of its daily API requests could not be read, so whether the writes fit is not known.',
          question.org,
        ),
      near: () =>
        vscode.l10n.t(
          'That would leave {0} with less than a tenth of its daily requests.',
          question.org,
        ),
    }),
    // The source is often a production org whose integrations draw on the
    // same requests.
    ...allowanceLines(wholeOrg.sourceApi, {
      told: (estimate, remaining, max) =>
        vscode.l10n.t(
          'API requests of {0}, to read: about {1}; it has {2} of its {3} daily requests left.',
          wholeOrg.source,
          estimate,
          remaining,
          max,
        ),
      unread: (_estimate, unread) =>
        vscode.l10n.t(
          'What {0} has left of its daily API requests could not be read ({1}), so whether the reads fit is not known.',
          wholeOrg.source,
          unread ?? '',
        ),
      near: () =>
        vscode.l10n.t(
          'That would leave {0} with less than a tenth of its daily requests.',
          wholeOrg.source,
        ),
    }),
  );
  const { bulk } = wholeOrg;
  if (bulk) {
    lines.push(
      vscode.l10n.t(
        'The records go in {0} Bulk API 2.0 jobs carrying {1} of them, one at a time, parents first; {2} go by REST calls of 200.',
        bulk.jobs,
        bulk.jobRows,
        bulk.restRows,
      ),
    );
  }
  if (bulk?.batches) {
    lines.push(
      ...allowanceLines(bulk.batches, {
        told: (estimate, remaining, max) =>
          vscode.l10n.t(
            'Bulk API batches of {0}: about {1}; it has {2} of its {3} daily batches left.',
            question.org,
            estimate,
            remaining,
            max,
          ),
        unread: (estimate) =>
          vscode.l10n.t(
            'Bulk API batches of {0}: about {1}. It did not say how many it has left today, so whether they fit is not known.',
            question.org,
            estimate,
          ),
        near: () =>
          vscode.l10n.t(
            'That would leave {0} with less than a tenth of its daily Bulk API batches.',
            question.org,
          ),
      }),
    );
  }
  // A minute or less, then in minutes up to two hours, then in hours to a
  // tenth in the window's own figures: a run of a whole org may write for a
  // night.
  const minutes = Math.max(1, Math.ceil(wholeOrg.durationSeconds / 60));
  lines.push(
    minutes === 1
      ? vscode.l10n.t('Duration: a minute or less.')
      : minutes < 120
        ? vscode.l10n.t('Duration: about {0} minutes.', minutes)
        : vscode.l10n.t(
            'Duration: about {0} hours.',
            (Math.ceil(minutes / 6) / 10).toLocaleString(vscode.env.language, {
              maximumFractionDigits: 1,
            }),
          ),
  );
  const rest = wholeOrg.restObjects;
  if (rest.length > 0) {
    const named = rest.slice(0, LISTED_IN_A_QUESTION).join(', ');
    lines.push(
      rest.length > LISTED_IN_A_QUESTION
        ? vscode.l10n.t(
            'Written by REST rather than in Bulk API jobs, for their size or what a job cannot do: {0}, and {1} more.',
            named,
            rest.length - LISTED_IN_A_QUESTION,
          )
        : vscode.l10n.t(
            'Written by REST rather than in Bulk API jobs, for their size or what a job cannot do: {0}.',
            named,
          ),
    );
  }
  // Counts as a figure after a colon: no plural to agree with a single file.
  const { fileStorage } = wholeOrg;
  if (fileStorage) {
    lines.push(
      vscode.l10n.t(
        'Files: {0}, taking about {1} MB; {2} has {3} MB of file storage left of {4} MB.',
        fileStorage.files,
        formatMB(fileStorage.estimateMB),
        question.org,
        fileStorage.remainingMB,
        fileStorage.maxMB,
      ),
    );
    if (fileStorage.near) {
      lines.push(vscode.l10n.t('That is more than 80% of the file storage left.'));
    }
    if (fileStorage.overCeiling > 0) {
      lines.push(
        vscode.l10n.t(
          'Files not copied, larger than the largest file the clone copies: {0}.',
          fileStorage.overCeiling,
        ),
      );
    }
  }
  // A package's triggers and flows run as its records go in: the mute takes
  // the org's own automation through its bypass, which no package reads.
  const managed = wholeOrg.managedPackages ?? [];
  if (managed.length > 0) {
    const named = managed.slice(0, LISTED_IN_A_QUESTION).join(', ');
    lines.push(
      managed.length > LISTED_IN_A_QUESTION
        ? vscode.l10n.t(
            'Objects of managed packages, copied as any other, whose package runs its own triggers and flows as they go in, muted or not: {0}, and {1} more.',
            named,
            managed.length - LISTED_IN_A_QUESTION,
          )
        : vscode.l10n.t(
            'Objects of managed packages, copied as any other, whose package runs its own triggers and flows as they go in, muted or not: {0}.',
            named,
          ),
    );
  }
  if (wholeOrg.contactPointsBlanked !== undefined && wholeOrg.contactPointsBlanked > 0) {
    lines.push(
      vscode.l10n.t(
        'Up to {0} phone numbers are written empty: past the 10000 fictional numbers the clone gives, none is left to replace them.',
        wholeOrg.contactPointsBlanked,
      ),
    );
  }
  // What a copy of a production org brings with it: said by count and
  // object, the fields named on Review's personal data tab.
  const asIs = wholeOrg.personalAsIs ?? [];
  if (asIs.length > 0) {
    const fields = asIs.reduce((sum, { fields: named }) => sum + named.length, 0);
    const objects = asIs
      .slice(0, LISTED_IN_A_QUESTION)
      .map(({ objectApiName, fields: named }) => `${objectApiName} (${named.length})`)
      .join(', ');
    lines.push(
      asIs.length > LISTED_IN_A_QUESTION
        ? vscode.l10n.t(
            'Personal fields copied as they are, not anonymized, {0} in all, per object: {1}, and {2} more objects.',
            fields,
            objects,
            asIs.length - LISTED_IN_A_QUESTION,
          )
        : vscode.l10n.t(
            'Personal fields copied as they are, not anonymized, {0} in all, per object: {1}.',
            fields,
            objects,
          ),
    );
  }
  // Said whatever the org holds, with no figure: telling how many owners the
  // target holds inactive would take a read of its users before the question,
  // and whether the user the run writes as may keep them a read of its
  // permissions.
  lines.push(
    vscode.l10n.t(
      'Records whose owner is inactive in {0} are written with you as their owner, unless you hold Update Records with Inactive Owners; owners mapped under Review → Controls come first.',
      question.org,
    ),
    vscode.l10n.t('Removing the run from Results takes back every record it created.'),
  );
  return lines;
}

/** What a run's question says of the rows it is about to write, and their storage. */
function writeQuestion(question: WriteConfirmation): string[] {
  const { wholeOrg } = question;
  const lines = [
    wholeOrg?.sample
      ? vscode.l10n.t(
          'This clone copies a sample of {0} into {1}: {2} objects, {3} records.',
          wholeOrg.source,
          question.org,
          question.objects.length,
          question.total,
        )
      : wholeOrg
        ? vscode.l10n.t(
            'This clone copies all the data of {0} into {1}: {2} objects, {3} records.',
            wholeOrg.source,
            question.org,
            question.objects.length,
            question.total,
          )
        : question.module === 'autopilot'
          ? vscode.l10n.t(
              'This Autopilot run is about to write {0} records to {1}:',
              question.total,
              question.org,
            )
          : question.module === 'seed'
            ? vscode.l10n.t(
                'This seed is about to write {0} records to {1}:',
                question.total,
                question.org,
              )
            : question.module === 'sync'
              ? vscode.l10n.t(
                  'This sync is about to write {0} records to {1}:',
                  question.total,
                  question.org,
                )
              : vscode.l10n.t(
                  'This clone is about to write {0} records to {1}:',
                  question.total,
                  question.org,
                ),
  ];
  // Names and counts alone: nothing in them to translate — save, once the
  // case was simulated, what the simulation counted of each object.
  const { simulated } = question;
  const simulatedRows = new Map(
    (simulated?.objects ?? []).map(({ objectApiName, rows }) => [objectApiName, rows]),
  );
  for (const { objectApiName, rows } of question.objects.slice(0, LISTED_IN_A_QUESTION)) {
    lines.push(
      simulated
        ? vscode.l10n.t(
            '• {0}: {1} (simulated: {2})',
            objectApiName,
            rows,
            simulatedRows.get(objectApiName) ?? 0,
          )
        : `• ${objectApiName}: ${rows}`,
    );
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
  // What the last simulation of the case counted: a clone whose dry run said
  // 37 records wrote 34 216, a parent added to its graph having widened what
  // was read of its children, and nothing set the two side by side.
  if (simulated) {
    lines.push(
      vscode.l10n.t(
        'The last simulation of this clone, {0} minutes ago, counted {1} records to write.',
        simulated.minutesBefore,
        simulated.total,
      ),
    );
    if (simulated.farAbove) {
      lines.push(
        vscode.l10n.t(
          'This clone writes far more than that: what it reads may have widened since, by a deeper discovery, a parent added to its graph, a cap raised or a filter taken off. Simulate it again to see where the records come from.',
        ),
      );
    }
  }
  const { leftOut } = question;
  if (leftOut && leftOut.writtenBefore > 0) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0} records the run it retries or resumes wrote, which it links to and does not write again.',
        leftOut.writtenBefore,
      ),
    );
  }
  // The objects the target takes none of: confirmed, the sync leaves them out.
  for (const { objectApiName, rows, why, key } of question.unwritable ?? []) {
    lines.push(
      why === 'notInTarget'
        ? vscode.l10n.t(
            'Left out: {0}, {1} records: {2} has no such object, or the user the sync writes as cannot see it.',
            objectApiName,
            rows,
            question.org,
          )
        : why === 'notCreateable'
          ? vscode.l10n.t(
              'Left out: {0}, {1} records: the user the sync writes as may not create its records in {2}.',
              objectApiName,
              rows,
              question.org,
            )
          : why === 'notUpdateable'
            ? vscode.l10n.t(
                'Left out: {0}, {1} records: the user the sync writes as may not edit its records in {2}.',
                objectApiName,
                rows,
                question.org,
              )
            : why === 'notAKey'
              ? vscode.l10n.t(
                  'Left out: {0}, {1} records: its upsert matches on {2}, neither an External ID nor an idLookup field in {3}.',
                  objectApiName,
                  rows,
                  key ?? '',
                  question.org,
                )
              : vscode.l10n.t(
                  'Left out: {0}, {1} records: {2} did not describe it, so what it takes could not be told.',
                  objectApiName,
                  rows,
                  question.org,
                ),
    );
  }
  // The rows whose lookup names a record left out, or one held back: the
  // question named the account it left out and not the contacts under it,
  // which the result then counted failed.
  const leftOutObjects = new Set((question.unwritable ?? []).map((o) => o.objectApiName));
  // One line per object and lookup, with its rows: named by the first alone,
  // 13 prices were said held back by Pricebook2Id where 9 were by Product2Id.
  const heldBy = (question.heldBack ?? []).flatMap(
    ({ objectApiName, rows, parent, field, parents }) =>
      (parents ?? [{ parent, field, rows }]).map((one) => ({ objectApiName, ...one })),
  );
  for (const { objectApiName, rows, parent, field } of heldBy) {
    lines.push(
      leftOutObjects.has(parent)
        ? vscode.l10n.t(
            'Held back: {0}, {1} records: their {2} names {3} records left out, so none of them is written and each counts as failed.',
            objectApiName,
            rows,
            field,
            parent,
          )
        : vscode.l10n.t(
            'Held back: {0}, {1} records: their {2} names {3} records held back, so none of them is written and each counts as failed.',
            objectApiName,
            rows,
            field,
            parent,
          ),
    );
  }
  for (const { objectApiName, rows } of leftOut?.heldBack ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records, held back for a record type closed to the user the run writes as.',
        objectApiName,
        rows,
      ),
    );
  }
  for (const { objectApiName, rows } of leftOut?.recordTypeNotInTarget ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records, held back for a record type the target has none of, which it would refuse.',
        objectApiName,
        rows,
      ),
    );
  }
  for (const { objectApiName, rows } of leftOut?.withoutParent ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records held back with a record they cannot be written without, held back itself.',
        objectApiName,
        rows,
      ),
    );
  }
  for (const { objectApiName, rows } of leftOut?.noParentInSource ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records left aside: a lookup they may not leave empty names a record the source does not hold, which no copy can write.',
        objectApiName,
        rows,
      ),
    );
  }
  // What the platform writes itself with a record the run creates: linked
  // to, never sent, as the line of each object says once written. An
  // email's task is counted, the run sending it for an email refused.
  for (const { objectApiName, rows } of leftOut?.byThePlatform ?? []) {
    lines.push(
      objectApiName === 'Contact'
        ? vscode.l10n.t(
            'Not counted: {0}, {1} records written by the platform with their person account, which the run links to and does not send.',
            objectApiName,
            rows,
          )
        : objectApiName === 'OpportunityContactRole'
          ? vscode.l10n.t(
              'Not counted: {0}, {1} records written by the platform with their opportunity, for its contact, which the run links to and does not send.',
              objectApiName,
              rows,
            )
          : vscode.l10n.t(
              'Not counted: {0}, {1} records written by the platform with their opportunity, for its owner, which the run links to and does not send.',
              objectApiName,
              rows,
            ),
    );
  }
  // What holds a unique value the target holds: its insert refused, the
  // write links it to the record the refusal names and creates none.
  for (const { objectApiName, rows, fields } of leftOut?.linkedByValue ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records the target holds under the same {2}, which the run links to and does not create.',
        objectApiName,
        rows,
        fields.join(', '),
      ),
    );
  }
  // The standard price book, matched to the target's and never written; the
  // prices in a currency the target lacks, written as the source's own price
  // in the currency they go in.
  for (const { objectApiName, rows } of leftOut?.linkedToTarget ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records, the standard price book: linked to the standard price book of the target, never written.',
        objectApiName,
        rows,
      ),
    );
  }
  for (const { objectApiName, rows } of leftOut?.currencyReplaced ?? []) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0}, {1} records in a currency the target lacks, replaced by the price the source holds in the currency written, for the same product and price book.',
        objectApiName,
        rows,
      ),
    );
  }
  if (question.alreadyCopied !== undefined && question.alreadyCopied > 0) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0} records an earlier run of this configuration copied, still in the target, which the sync leaves as they are.',
        question.alreadyCopied,
      ),
    );
  }
  if (question.alreadyLinked !== undefined && question.alreadyLinked > 0) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0} records an earlier run of this configuration linked to records the target held, which the sync leaves as they are.',
        question.alreadyLinked,
      ),
    );
  }
  if (question.rolesLinked !== undefined && question.rolesLinked > 0) {
    lines.push(
      vscode.l10n.t(
        'Not counted: {0} contact roles the platform writes itself with the opportunities the sync creates, for their contact, which the sync links to and does not send.',
        question.rolesLinked,
      ),
    );
  }
  if (question.overwrites !== undefined && question.overwrites > 0) {
    lines.push(
      vscode.l10n.t(
        'Of them, up to {0} are written by an update or an upsert over records {1} holds: the values those hold are read and kept on this machine first, and removing the run puts them back.',
        question.overwrites,
        question.org,
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
  // Counted in, where the gate could not tell them: said, as the command
  // line says them.
  if (question.rolesMayBeByThePlatform !== undefined) {
    const { rows, before } = question.rolesMayBeByThePlatform;
    lines.push(
      before === true
        ? vscode.l10n.t(
            'Of them, up to {0} contact roles the platform may have written with their opportunity, for its contact, in the run this one takes up, which the clone links to and does not send.',
            rows,
          )
        : vscode.l10n.t(
            'Of them, up to {0} contact roles the platform may write itself with their opportunity, for its contact, which the clone links to and does not send.',
            rows,
          ),
    );
  }
  if (question.pricesForLines !== undefined) {
    lines.push(
      vscode.l10n.t(
        'Of the price book entries, up to {0} are counted that the clone may read as it writes them: a price in the currency of the record its lines belong to, which the source holds beside the one read.',
        question.pricesForLines,
      ),
    );
  }
  // The blocks of the question, each in its place whatever order they are
  // made in: what leaves the org, the checkpoint taken first, then the
  // storage and the API requests.
  lines.push(
    ...inQuestionOrder({
      leavesTheOrg: leavesTheOrgLines(question),
      checkpoint: question.checkpoint
        ? checkpointQuestionLines(question.checkpoint, HOST_CHECKPOINT_WORDS)
        : [],
      limits: limitsLines(question),
    }),
  );
  if (wholeOrg) lines.push(...wholeOrgLines(question, wholeOrg));
  // The rows of a call the run resumed had under way when it stopped, which
  // the target may hold already: written only on the user's word. Those of a
  // Bulk API job the org has not ended are said with the job, and when to
  // resume again: run for real, a resume found the job open, nothing
  // processed, and was told the target held records it could not tell from
  // the rows.
  const ofJobs = new Map<string, number>();
  for (const job of question.jobsUnderway ?? []) {
    const said = jobUnderwayLine(job, question.org);
    if (said === undefined) continue;
    lines.push(said);
    ofJobs.set(job.objectApiName, (ofJobs.get(job.objectApiName) ?? 0) + job.rows);
  }
  for (const { objectApiName, rows: all } of question.mayBeInTarget ?? []) {
    const rows = all - (ofJobs.get(objectApiName) ?? 0);
    if (rows <= 0) continue;
    lines.push(
      vscode.l10n.t(
        '{0} {1} records may already be in {2}: the insert call that sent them was under way when the run stopped, and {2} holds records the resume cannot tell from them. Execute writes them all the same, and each may then be there twice.',
        rows,
        objectApiName,
        question.org,
      ),
    );
  }
  // A read stopped at Records per object leaves the rest of the source out:
  // said before the records go, where the results alone said it before.
  if (question.capped) {
    lines.push(
      vscode.l10n.t(
        'Stopped at {0} records per object for {1}: the source holds more, which are not cloned. Raise Records per object to clone them.',
        question.capped.perObject,
        question.capped.objects.join(', '),
      ),
    );
  }
  lines.push(
    question.counted
      ? vscode.l10n.t('The records have been counted, and nothing has been read or written yet.')
      : vscode.l10n.t('The records have been read, and nothing has been written yet.'),
  );
  return lines;
}

/**
 * What the question of a resume says of a Bulk API job the run had under way
 * that the org has not ended: the job, its state and what it processed, and
 * when to resume again — once its hour of grace is out, for one still open,
 * which a resume then aborts and writes the records of; once it has ended,
 * for one the org is writing. Undefined when the org did not say its state
 * and what it processed, or how long a job still open has left: the rows are
 * then said as any rows the target may hold.
 */
function jobUnderwayLine(
  job: NonNullable<WriteConfirmation['jobsUnderway']>[number],
  org: string,
): string | undefined {
  if (job.state === undefined || job.processed === undefined) return undefined;
  if (job.state === 'Open') {
    if (job.minutesLeft === undefined) return undefined;
    return vscode.l10n.t(
      '{0} {1} records went in Bulk API job {2}, which {3} holds open with {4} of its rows processed: the run stopped before it closed it, and closed, it would still write them. Resume again in about {5} minutes: the job is then aborted if it is still open, and the records written. Execute writes them now all the same, and each may then be there twice.',
      job.rows,
      job.objectApiName,
      job.jobId,
      org,
      job.processed,
      job.minutesLeft,
    );
  }
  return vscode.l10n.t(
    '{0} {1} records went in Bulk API job {2}, which {3} is still writing ({4}, {5} of its rows processed). Resume again once it has ended, in a minute or two: the resume then reads what the job wrote. Execute writes them now all the same, and each may then be there twice.',
    job.rows,
    job.objectApiName,
    job.jobId,
    org,
    job.state,
    job.processed,
  );
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
  // production confirmation below). A question that says the target delivers
  // the emails of what still runs is answered by sending them: no other
  // button stands for that.
  const rehearsal = question.stage === 'rehearsal';
  const sends =
    (question.stage === 'write' || question.stage === 'automation') &&
    deliverabilityLines(question).length > 0;
  // A sample of the whole org copies part of it: its button says so.
  const sampled = question.stage === 'write' && question.wholeOrg?.sample !== undefined;
  const go = rehearsal
    ? vscode.l10n.t('Rehearse')
    : sends
      ? vscode.l10n.t('Execute and send the emails')
      : sampled
        ? vscode.l10n.t('Copy the sample')
        : vscode.l10n.t('Execute');
  // A modal's text cannot be selected everywhere: the command that would
  // assign a bypass goes to the clipboard from a button of its own. It
  // cancels the clone, which the user runs again once the command ran.
  const commands = assignCommands(question);
  const copy = vscode.l10n.t('Copy the command');
  const choice = await vscode.window.showWarningMessage(
    rehearsal
      ? vscode.l10n.t('SandForge: confirm this rehearsal')
      : question.stage === 'write' && question.module === 'autopilot'
        ? vscode.l10n.t('SandForge: confirm this Autopilot run')
        : question.stage === 'write' && question.module === 'sync'
          ? vscode.l10n.t('SandForge: confirm this sync')
          : question.stage === 'write' && question.module === 'seed'
            ? vscode.l10n.t('SandForge: confirm this seed')
            : sampled
              ? vscode.l10n.t('SandForge: confirm this sample of the whole org')
              : question.stage === 'write' && question.wholeOrg
                ? vscode.l10n.t('SandForge: confirm this clone of the whole org')
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

/** An org's tier as the confirmation's question says it. */
function tierWord(tier: SafetyTier): string {
  switch (tier) {
    case 'production':
      return vscode.l10n.t('production');
    case 'staging':
      return vscode.l10n.t('staging');
    case 'development':
      return vscode.l10n.t('development');
    case 'scratch':
      return vscode.l10n.t('scratch');
  }
}

/**
 * Whether `count` takes the singular, by the plural rule of the language
 * whose bundle VS Code shows, as the status bar's count of orgs takes it
 * (`extension.ts`): French says "0 enregistrement" where English says
 * "0 records", and an editor in a language SandForge ships no bundle for is
 * shown the English strings, and English's rule.
 */
function takesSingular(count: number): boolean {
  return new Intl.PluralRules(uiLocaleOf(undefined, vscode.env.language)).select(count) === 'one';
}

/**
 * The confirmation's question in the UI language. Every piece is a whole
 * phrase with its placeholders, so a language orders the operation, the
 * records and the org its own way; the English keys are the guard's own words.
 */
export const L10N_QUESTION_WORDS: QuestionWords = {
  sentence: (operation, things, org) => {
    switch (operation) {
      case 'insert':
        return vscode.l10n.t('Insert {0} into {1}.', things, org);
      case 'update':
        return vscode.l10n.t('Update {0} in {1}.', things, org);
      case 'upsert':
        return vscode.l10n.t('Insert or update {0} in {1}.', things, org);
      case 'delete':
        return vscode.l10n.t('Delete {0} in {1}.', things, org);
      case 'hardDelete':
        return vscode.l10n.t('Permanently delete {0} in {1}.', things, org);
      case 'deploy':
        return vscode.l10n.t('Deploy {0} to {1}.', things, org);
    }
  },
  counted: (unit, count) => {
    if (unit === 'component') {
      if (count === 'unknown') return vscode.l10n.t('components');
      if (typeof count !== 'number') return vscode.l10n.t('at most {0} components', count.atMost);
      return takesSingular(count)
        ? vscode.l10n.t('{0} component', count)
        : vscode.l10n.t('{0} components', count);
    }
    if (count === 'unknown') return vscode.l10n.t('records');
    if (typeof count !== 'number') return vscode.l10n.t('at most {0} records', count.atMost);
    return takesSingular(count)
      ? vscode.l10n.t('{0} record', count)
      : vscode.l10n.t('{0} records', count);
  },
  besides: (counted, alsoWrites) =>
    vscode.l10n.t(
      '{0}, plus {1},',
      counted,
      alsoWrites === RELATED_RECORDS_ALSO_WRITTEN
        ? vscode.l10n.t('the related records the run adds')
        : alsoWrites,
    ),
  org: (tier, name, named) =>
    named
      ? vscode.l10n.t('the {0} org "{1}"', tierWord(tier), name)
      : vscode.l10n.t('the {0} org {1}', tierWord(tier), name),
  deployRefused: (org) =>
    vscode.l10n.t(
      'SandForge deploys metadata only to a sandbox, a scratch org or a Developer Edition org, not to {0}.',
      org,
    ),
  deleteRefused: (operation, org) =>
    operation === 'hardDelete'
      ? vscode.l10n.t('Permanently deleting records is not allowed in {0}.', org)
      : vscode.l10n.t('Deleting records is not allowed in {0}.', org),
};

/**
 * Build the infrastructure layer: perf tracker, production guard, offline
 * manager, PII detector, and the background operation registry.
 * Extracted from `activate()` — behaviour unchanged.
 */
export function createBackgroundComposition(
  deps: BackgroundCompositionDeps,
): BackgroundComposition {
  const { configStore } = deps;

  const performanceTracker = new PerformanceTracker();
  // Every write to a production org asks through the modal below, and no
  // setting turns that off: `safety.requireProdConfirmation` is no longer
  // read. `safety.auditLogging` is read where the decisions are kept, by the
  // audit trail.
  const productionGuard = new ProductionGuard({
    orgNameOf: deps.orgNameOf,
    questionWords: L10N_QUESTION_WORDS,
    requestConfirmation: async (impactSummary, orgTier, question) => {
      // The action label doubles as the equality check, so it MUST be the same
      // value on both sides — comparing against a hardcoded 'Execute' would
      // make the guard always-false (i.e. silently deny every prod write) as
      // soon as the UI runs in a translated locale.
      const execute = vscode.l10n.t('Execute');
      // Staging asks too, before a delete, a deployment or a large volume, and
      // was told it wrote data to a production org. The question above the
      // sentence already names the tier and what the operation does, the org
      // by its alias; the impact summary, with the org's id and the module
      // tag, is what is left when the org has no name to give.
      const production = orgTier === 'production';
      const asked = question ?? impactSummary;
      const choice = await vscode.window.showWarningMessage(
        production
          ? vscode.l10n.t('SandForge: production operation')
          : vscode.l10n.t('SandForge: operation to confirm'),
        {
          modal: true,
          detail: production
            ? vscode.l10n.t('{0}\n\nThis operation writes data to a PRODUCTION org.', asked)
            : vscode.l10n.t('{0}\n\nThis operation needs your confirmation before it runs.', asked),
        },
        execute,
      );
      return choice === execute;
    },
    // A run's own questions — what fires as a clone inserts, what it is
    // about to write — go through the same kind of modal. No setting turns
    // them off either.
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
