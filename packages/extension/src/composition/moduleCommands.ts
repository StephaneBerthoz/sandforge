/**
 * Module-open command descriptors — single source of truth for both the
 * `sandforge.open*` command registrations (./commandsComposition.ts) and the
 * sidebar route→command map (../providers/SidebarViewProvider.ts), so the two
 * can never drift apart.
 *
 * Deliberately free of any `vscode` import so it can be consumed from
 * providers and tests without a VSCode runtime.
 */
export interface ModuleCommand {
  /** Command id registered with `vscode.commands`. */
  command: string;
  /** Module id — doubles as the webview route and the `sandforge.<moduleId>` viewType suffix. */
  moduleId: string;
  /** English module name used in the panel title (`SandForge: <title>`). */
  title: string;
  /**
   * Whether the panel's page is released while the panel is hidden, and
   * rebuilt from its shell when it is shown again (`WebviewPanelManager`).
   *
   * Every panel was kept alive once hidden, so the memory of the editor grew
   * with each module opened: each holds its own copy of the shared bundle,
   * its React tree and the catalogue of its language. A page is released only
   * when nothing it holds is lost and nothing it should hear is missed: VS
   * Code delivers a message only to a live page, so a Sync, Seed, Forge or
   * DataOps panel in a background tab would miss the progress and the end of
   * the run it started, and a half-filled wizard would come back empty. Help
   * and Reports hold neither: Help is static, Reports reads its data again as
   * it opens. And only while the page shows its own module with no overlay
   * open, since a panel's page can route to any other module.
   *
   * What the others need replayed before they can be released too, each of
   * which a page now receives only while it is alive:
   * - Organizations: the `state:sync` and `org:selected` broadcasts (a rebuilt
   *   page asks `org:list` again, but the global selection and a connection
   *   under way reach it only by broadcast), the device-code login in progress
   *   (`org:device-code`, posted once, with the `org:connect` it answers), and
   *   the import or browser sign-in a command opened the page on.
   * - Settings: the unsaved edits of its forms, which only its Save buttons
   *   write (the General tab, a typed AI key), and a profile import or export
   *   still waiting on its answer.
   * - AI: the answer still on its way, correlated to a request of the released
   *   page and shown by nothing else, and the question being typed. The
   *   conversations themselves are kept by the host and listed again.
   */
  rebuiltWhenHidden?: true;
}

/** All `sandforge.open*` module commands, in sidebar navigation order. */
export const MODULE_COMMANDS: readonly ModuleCommand[] = [
  { command: 'sandforge.openHome', moduleId: 'home', title: 'Home' },
  { command: 'sandforge.openMonitor', moduleId: 'monitor', title: 'Monitor' },
  { command: 'sandforge.openSeed', moduleId: 'seed', title: 'Seed' },
  { command: 'sandforge.openSync', moduleId: 'sync', title: 'Sync' },
  { command: 'sandforge.openForge', moduleId: 'forge', title: 'Forge' },
  { command: 'sandforge.openFrozen', moduleId: 'frozen', title: 'Frozen Dataset' },
  { command: 'sandforge.openGrappe', moduleId: 'grappe', title: 'Grappe' },
  { command: 'sandforge.openAutopilot', moduleId: 'autopilot', title: 'Autopilot' },
  { command: 'sandforge.openCompare', moduleId: 'compare', title: 'Compare' },
  { command: 'sandforge.openDataOps', moduleId: 'dataops', title: 'DataOps' },
  { command: 'sandforge.openAutomation', moduleId: 'automation', title: 'Automation' },
  { command: 'sandforge.openMigration', moduleId: 'migration', title: 'Migration' },
  { command: 'sandforge.openAI', moduleId: 'ai', title: 'AI Assistant' },
  { command: 'sandforge.openOrgs', moduleId: 'orgs', title: 'Organizations' },
  {
    command: 'sandforge.openReports',
    moduleId: 'reports',
    title: 'Reports',
    rebuiltWhenHidden: true,
  },
  { command: 'sandforge.openSettings', moduleId: 'settings', title: 'Settings' },
  { command: 'sandforge.openHelp', moduleId: 'help', title: 'Help', rebuiltWhenHidden: true },
];

/** Whether a module's panel is released while hidden: see {@link ModuleCommand.rebuiltWhenHidden}. */
export function isRebuiltWhenHidden(moduleId: string): boolean {
  return MODULE_COMMANDS.some((entry) => entry.moduleId === moduleId && entry.rebuiltWhenHidden);
}

/**
 * Sidebar route → command map, derived from MODULE_COMMANDS.
 *
 * `home` used to be an alias for Monitor: Home had no command of its own, so
 * Open Full UI and the status bar landed on API limits, and the one card that
 * says "this org is empty, fill it" sat on a page nothing opened.
 */
export const SIDEBAR_ROUTE_COMMANDS: Readonly<Record<string, string>> = Object.fromEntries(
  MODULE_COMMANDS.map(({ moduleId, command }) => [moduleId, command]),
);

/** The page a route the map does not know, Open Full UI and the status bar open. */
export const LANDING_COMMAND = 'sandforge.openHome';
