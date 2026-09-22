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
 * @param refresh - The refresh noticed.
 * @param orgManager - Resolves the aliases the user knows the orgs by.
 */
export function sandboxRefreshNotice(
  refresh: DetectedSandboxRefresh,
  orgManager: OrgManager,
): string {
  const aliasOf = (orgId: string): string => orgManager.getOrg(orgId)?.alias ?? orgId;
  if (refresh.evidence === 'production') {
    return vscode.l10n.t(
      'SandForge: sandbox {0} finished a refresh, according to the refresh history of {1}. SandForge dropped what it had cached about it.',
      aliasOf(refresh.orgId),
      refresh.reportedBy === undefined ? '' : aliasOf(refresh.reportedBy),
    );
  }
  return vscode.l10n.t(
    'SandForge: sandbox {0} was refreshed and is now a new org — what was written to it before the refresh is gone. SandForge dropped what it had cached about it.',
    aliasOf(refresh.orgId),
  );
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
 * @returns What stops both the observing and the notices.
 */
export function wireSandboxRefreshDetection(
  detector: SandboxRefreshDetector,
  orgManager: OrgManager,
): { dispose(): void } {
  observeValidatedIdentities((orgId, identity) => {
    detector.observe(orgId, { organizationId: identity.organizationId }, 'connection');
  });
  const stop = detector.onRefreshDetected((refresh) => {
    void vscode.window.showWarningMessage(sandboxRefreshNotice(refresh, orgManager));
  });
  return {
    dispose: () => {
      observeValidatedIdentities(undefined);
      stop();
    },
  };
}
