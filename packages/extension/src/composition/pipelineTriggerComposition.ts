import * as vscode from 'vscode';
import * as path from 'node:path';
import type { TriggerReport } from '../modules/automation/PipelineTriggerScheduler';
import { fileTriggerClaims } from '../modules/automation/TriggerClaims';
import type { PipelineTriggerWiring } from '../bridge/handlers/AutomationHandler';

/** A date and time in the editor's language. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(vscode.env.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** How many starts were missed: the count, or at least the count. */
function howMany(count: number, atLeast: boolean | undefined): string {
  return atLeast ? `${count}+` : String(count);
}

/**
 * What the user is told of a trigger, in the editor's language.
 *
 * A native notification rather than a toast in a panel: a start missed while
 * VS Code was closed is found at launch, before any panel is open, and a run a
 * trigger starts is watched by nobody.
 *
 * @param report - What the trigger did not do, or the run it started that failed.
 */
export function pipelineTriggerNotice(report: TriggerReport): string {
  const name = report.pipelineName;
  if (report.kind === 'failed') {
    return report.triggeredBy === 'sandbox_refresh'
      ? vscode.l10n.t(
          'SandForge: pipeline "{0}", started by the refresh of sandbox {1}, failed: {2}',
          name,
          report.sandboxName ?? '',
          report.error,
        )
      : vscode.l10n.t(
          'SandForge: pipeline "{0}", started by its schedule, failed: {1}',
          name,
          report.error,
        );
  }

  const { missed } = report;
  if (missed.reason === 'cannotRun') {
    return vscode.l10n.t(
      'SandForge: the refresh of sandbox {0} did not start pipeline "{1}", which holds a step that cannot run: {2}',
      report.sandboxName ?? '',
      name,
      missed.detail ?? '',
    );
  }
  if (missed.reason === 'busy') {
    return report.triggeredBy === 'sandbox_refresh'
      ? vscode.l10n.t(
          'SandForge: the refresh of sandbox {0} did not start pipeline "{1}": the run started at {2} was still going. A pipeline never runs twice at once.',
          report.sandboxName ?? '',
          name,
          when(missed.busySince ?? report.dueAt),
        )
      : vscode.l10n.t(
          'SandForge: pipeline "{0}" was due at {1} and did not start: the run started at {2} was still going. A pipeline never runs twice at once.',
          name,
          when(report.dueAt),
          when(missed.busySince ?? report.dueAt),
        );
  }
  if (missed.count > 1) {
    return missed.reason === 'closed'
      ? vscode.l10n.t(
          'SandForge: pipeline "{0}" missed {1} scheduled starts, from {2} to {3}, while VS Code was closed. None was made late; the schedule goes on.',
          name,
          howMany(missed.count, missed.atLeast),
          when(report.dueAt),
          when(missed.lastDueAt ?? report.dueAt),
        )
      : vscode.l10n.t(
          'SandForge: pipeline "{0}" missed {1} scheduled starts, from {2} to {3}: SandForge could not look at its schedule in time, as when the computer sleeps. None was made late; the schedule goes on.',
          name,
          howMany(missed.count, missed.atLeast),
          when(report.dueAt),
          when(missed.lastDueAt ?? report.dueAt),
        );
  }
  return missed.reason === 'closed'
    ? vscode.l10n.t(
        'SandForge: pipeline "{0}" was due at {1}, while VS Code was closed. It was not started late; the schedule goes on.',
        name,
        when(report.dueAt),
      )
    : vscode.l10n.t(
        'SandForge: pipeline "{0}" was due at {1}, and SandForge could not look at its schedule in time, as when the computer sleeps. It was not started late; the schedule goes on.',
        name,
        when(report.dueAt),
      );
}

/**
 * Start the schedule and sandbox refresh triggers of the saved pipelines, and
 * tell the user what they do not do. Side-effecting by design — call once from
 * `activate()`, and dispose on deactivate.
 *
 * @param start - Starts the triggers (`ExtensionHandlers.startPipelineTriggers`).
 * @param stop - Stops them (`ExtensionHandlers.stopPipelineTriggers`).
 * @param storageDir - The extension's global storage directory: every window
 *   of the machine reaches it, so the windows share their claims there.
 * @param log - The output channel.
 * @returns What stops the triggers.
 */
export function wirePipelineTriggers(
  start: (wiring: PipelineTriggerWiring) => void,
  stop: () => void,
  storageDir: string,
  log: (message: string) => void,
): { dispose(): void } {
  start({
    claims: fileTriggerClaims(path.join(storageDir, 'pipeline-triggers'), { log }),
    report: (report) => {
      const message = pipelineTriggerNotice(report);
      log(`[pipeline-triggers] ${message}`);
      if (report.kind === 'failed') {
        void vscode.window.showErrorMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
    },
  });
  return { dispose: stop };
}
