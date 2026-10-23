import * as vscode from 'vscode';
import { observeValidatedIdentities } from '../core/connection/ConnectionHelper';
import type { OrgManager } from '../core/connection/OrgManager';
import type {
  DetectedSandboxRefresh,
  SandboxRefreshDetector,
} from '../modules/monitor/SandboxRefreshDetector';

/**
 * The notice a refresh is announced with, in the editor's language.
 *
 * A native notification rather than a toast in a panel: the refresh is most
 * often noticed by the startup check of every registered org, before any panel
 * is open, and the panels only render the English text the host sends.
 *
 * The checkpoints this machine keeps of the org before the refresh are
 * named with it: they are of another org now, which no rewind reaches, and
 * the Checkpoints page lists them as such, to be deleted.
 *
 * @param refresh - The refresh noticed.
 * @param orgManager - Resolves the aliases the user knows the orgs by.
 * @param checkpointsKept - The checkpoints kept of the org before the refresh.
 */
export function sandboxRefreshNotice(
  refresh: DetectedSandboxRefresh,
  orgManager: OrgManager,
  checkpointsKept = 0,
): string {
  const aliasOf = (orgId: string): string => orgManager.getOrg(orgId)?.alias ?? orgId;
  const notice =
    refresh.evidence === 'production'
      ? vscode.l10n.t(
          'SandForge: sandbox {0} finished a refresh, according to the refresh history of {1}. SandForge dropped what it had cached about it.',
          aliasOf(refresh.orgId),
          refresh.reportedBy === undefined ? '' : aliasOf(refresh.reportedBy),
        )
      : vscode.l10n.t(
          'SandForge: sandbox {0} was refreshed and is now a new org — what was written to it before the refresh is gone. SandForge dropped what it had cached about it.',
          aliasOf(refresh.orgId),
        );
  if (checkpointsKept <= 0) return notice;
  return `${notice} ${vscode.l10n.t(
    'Its {0} checkpoint(s) kept on this machine are of the org before the refresh: they can only be deleted.',
    checkpointsKept,
  )}`;
}

/**
 * Notice sandbox refreshes from the sandboxes themselves, and tell the user.
 *
 * Every connection is validated by an identity check whose answer names the
 * org it reached; each answer is handed to the detector, which reports a
 * sandbox that now answers as another org. Side-effecting by design — call
 * once from `activate()`, and dispose on deactivate.
 *
 * @param detector - The detector the handlers read from.
 * @param orgManager - Resolves aliases for the notice.
 * @param checkpointsKept - How many checkpoints this machine keeps of the org
 *   a sandbox was before its refresh, which the notice names; not asked
 *   without it. One that cannot be counted names none.
 * @returns What stops both the observing and the notices.
 */
export function wireSandboxRefreshDetection(
  detector: SandboxRefreshDetector,
  orgManager: OrgManager,
  checkpointsKept?: (refresh: DetectedSandboxRefresh) => Promise<number>,
): { dispose(): void } {
  observeValidatedIdentities((orgId, identity) => {
    detector.observe(orgId, { organizationId: identity.organizationId }, 'connection');
  });
  const stop = detector.onRefreshDetected((refresh) => {
    if (!checkpointsKept) {
      void vscode.window.showWarningMessage(sandboxRefreshNotice(refresh, orgManager));
      return;
    }
    void checkpointsKept(refresh)
      .catch(() => 0)
      .then((kept) =>
        vscode.window.showWarningMessage(sandboxRefreshNotice(refresh, orgManager, kept)),
      );
  });
  return {
    dispose: () => {
      observeValidatedIdentities(undefined);
      stop();
    },
  };
}
