import { LANDING_COMMAND } from './moduleCommands';

/**
 * The editor command that shows SandForge's side panel: the one VS Code
 * generates for the `sandforge` view container of the activity bar.
 */
export const SIDE_PANEL_COMMAND = 'workbench.view.extension.sandforge';

/** What {@link openOnStartup} reads and runs. */
export interface StartupOpenDeps {
  /** The `sandforge.openOnStartup` setting. */
  wanted: () => boolean;
  /**
   * Whether no version of SandForge ran in this profile before. Read before
   * any panel opens: the first one records the version.
   */
  isFirstLaunch: () => boolean;
  /** Runs an editor command; in VS Code, `vscode.commands.executeCommand`. */
  executeCommand: (command: string) => PromiseLike<unknown>;
  /** The output channel's log line. */
  log: (line: string) => void;
}

/**
 * Show the side panel and Home when a window starts.
 *
 * A window opened SandForge's views only when someone clicked its icon, so a
 * window started on a sandbox showed nothing of it: the launcher, the hero
 * that says a refresh was seen, and Home with What's New after an upgrade
 * all waited behind the activity bar.
 *
 * The first start after install opens the side panel alone: VS Code opens
 * the Get Started walkthrough then, the one first-run script, and Home would
 * cover it. A command the editor refuses is logged; activation goes on.
 */
export async function openOnStartup(deps: StartupOpenDeps): Promise<void> {
  if (!deps.wanted()) return;
  const firstLaunch = deps.isFirstLaunch();
  const commands = firstLaunch ? [SIDE_PANEL_COMMAND] : [SIDE_PANEL_COMMAND, LANDING_COMMAND];
  for (const command of commands) {
    try {
      await deps.executeCommand(command);
    } catch (err: unknown) {
      deps.log(
        `[startup] Could not run ${command}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
