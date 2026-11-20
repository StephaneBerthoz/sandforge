import { LANDING_COMMAND } from './moduleCommands';

/**
 * The editor command that shows SandForge's side panel: the one VS Code
 * generates for the `sandforge` view container of the activity bar.
 */
export const SIDE_PANEL_COMMAND = 'workbench.view.extension.sandforge';

/** What {@link openOnStartup} reads and runs. */
export interface StartupOpenDeps {
  /** The `sandforge.showWhatsNew` setting: the opening after an update is there to show it. */
  whatsNewWanted: () => boolean;
  /**
   * Whether no version of SandForge ran in this profile before. Read before
   * any panel opens: the first one records the version.
   */
  isFirstLaunch: () => boolean;
  /**
   * Whether this start follows an update What's New tells of
   * ({@link bringsWhatsNew}). Read before any panel opens, for the same reason.
   */
  isUpdate: () => boolean;
  /** Runs an editor command; in VS Code, `vscode.commands.executeCommand`. */
  executeCommand: (command: string) => PromiseLike<unknown>;
  /** The output channel's log line. */
  log: (line: string) => void;
}

/**
 * Show the side panel and Home as a window starts after an update, and the
 * side panel alone on the first start after install. Any other start opens
 * nothing: 1.84.0 opened both at every start, which took the editor over each
 * time VS Code opened.
 *
 * After an update to a new minor or major version, Home opens on What's New,
 * so `sandforge.showWhatsNew` off opens nothing; a patch, which What's New
 * lists nothing of, opens nothing either. The first start after install opens the side panel alone:
 * VS Code opens the Get Started walkthrough then, and Home would cover it. A
 * command the editor refuses is logged; activation goes on.
 */
export async function openOnStartup(deps: StartupOpenDeps): Promise<void> {
  let commands: string[];
  if (deps.isFirstLaunch()) commands = [SIDE_PANEL_COMMAND];
  else if (deps.isUpdate() && deps.whatsNewWanted())
    commands = [SIDE_PANEL_COMMAND, LANDING_COMMAND];
  else return;
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

const SEMVER = /^(\d+)\.(\d+)\.\d+/;

/**
 * Whether going from `lastSeen` to `running` is an update What's New lists a
 * release of: a later minor or major version. A patch, a downgrade, the same
 * version or a version that does not read as one is not.
 */
export function bringsWhatsNew(lastSeen: string | undefined, running: string): boolean {
  const from = lastSeen === undefined ? null : SEMVER.exec(lastSeen);
  const to = SEMVER.exec(running);
  if (!from || !to) return false;
  const [fromMajor, fromMinor] = [Number(from[1]), Number(from[2])];
  const [toMajor, toMinor] = [Number(to[1]), Number(to[2])];
  return toMajor > fromMajor || (toMajor === fromMajor && toMinor > fromMinor);
}

/**
 * How long after the side panel's provider registers a showing of it is the
 * one VS Code restores with the window: a side bar left on SandForge when the
 * last window closed comes back as the next one starts, which is no click.
 */
export const RESTORED_VIEW_MS = 3_000;

/** One showing of the side panel can be told twice: resolved, then visible. */
const SAME_SHOWING_MS = 1_000;

/** What {@link homeOnSidePanelShown} reads and runs. */
export interface SidePanelShownDeps {
  /** The clock, in milliseconds; read once as the provider registers. */
  now: () => number;
  /** Runs an editor command; in VS Code, `vscode.commands.executeCommand`. */
  executeCommand: (command: string) => PromiseLike<unknown>;
  /** The output channel's log line. */
  log: (line: string) => void;
}

/**
 * What the side panel calls each time it is shown: a click on SandForge's
 * icon opens Home beside the launcher. The showing VS Code restores with the
 * window opens nothing, nor does the second notice of one showing.
 */
export function homeOnSidePanelShown(deps: SidePanelShownDeps): () => void {
  const registeredAt = deps.now();
  let lastOpened = Number.NEGATIVE_INFINITY;
  return () => {
    const at = deps.now();
    if (at - registeredAt < RESTORED_VIEW_MS) return;
    if (at - lastOpened < SAME_SHOWING_MS) return;
    lastOpened = at;
    Promise.resolve(deps.executeCommand(LANDING_COMMAND)).catch((err: unknown) => {
      deps.log(
        `[sidebar] Could not run ${LANDING_COMMAND}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
}
