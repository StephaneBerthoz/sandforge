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
}

/** All `sandforge.open*` module commands, in sidebar navigation order. */
export const MODULE_COMMANDS: readonly ModuleCommand[] = [
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
  { command: 'sandforge.openReports', moduleId: 'reports', title: 'Reports' },
  { command: 'sandforge.openSettings', moduleId: 'settings', title: 'Settings' },
  { command: 'sandforge.openHelp', moduleId: 'help', title: 'Help' },
];

/**
 * Sidebar route → command map, derived from MODULE_COMMANDS. `home` is an
 * alias for the Monitor module (the sidebar landing route has no module of
 * its own).
 */
export const SIDEBAR_ROUTE_COMMANDS: Readonly<Record<string, string>> = {
  home: 'sandforge.openMonitor',
  ...Object.fromEntries(MODULE_COMMANDS.map(({ moduleId, command }) => [moduleId, command])),
};
