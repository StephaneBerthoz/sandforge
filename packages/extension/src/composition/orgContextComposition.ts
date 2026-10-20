import type { OrgManager } from '../core/connection/OrgManager';

/**
 * The context key that says an org is registered, which the Get Started
 * walkthrough's Connect step completes on.
 *
 * The step completed on the command that opens the Organizations page, so
 * opening the page ticked "Connect your first org" with no org connected,
 * and the walkthrough went on to fill an org nobody had.
 */
export const HAS_ORG_CONTEXT = 'sandforge.hasOrg';

/** Runs an editor command; in VS Code, `vscode.commands.executeCommand`. */
export type ExecuteCommand = (command: string, ...args: unknown[]) => unknown;

/**
 * Keep {@link HAS_ORG_CONTEXT} true while at least one org is registered and
 * false once the last is removed: set now, from the orgs already loaded, and
 * again on every change of the registry. A change that leaves the answer as
 * it was — a status, a rename — sets nothing.
 *
 * @param orgManager - The registered orgs.
 * @param executeCommand - Runs the editor's `setContext` command.
 * @returns What stops the updates.
 */
export function wireHasOrgContext(
  orgManager: OrgManager,
  executeCommand: ExecuteCommand,
): { dispose(): void } {
  let said: boolean | undefined;
  const say = (): void => {
    const hasOrg = orgManager.getAllOrgs().length > 0;
    if (hasOrg === said) return;
    said = hasOrg;
    // A context the editor failed to set leaves the step as it was; it must
    // not reach the host as an unhandled rejection.
    void Promise.resolve(executeCommand('setContext', HAS_ORG_CONTEXT, hasOrg)).catch(
      () => undefined,
    );
  };
  say();
  const stop = orgManager.onOrgChange(say);
  return { dispose: stop };
}
