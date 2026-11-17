/**
 * The `sandforge` npm package as a plugin of the Salesforce CLI: `sf
 * sandforge clone …` is `npx sandforge clone …`, the same script with the same
 * line, guards, questions and exit codes.
 *
 * Each command of the plugin is a class the package's build writes in
 * `lib/sf/sandforge/`, with no `@oclif/core` behind it: oclif takes for a
 * command whatever has a static `run`, and calls it with the words after the
 * command's id. The class refuses a Node older than the package's floor (sf
 * 2.140 and older still start on Node 18), then hands the words to `runTool`.
 *
 * The script runs in the process of sf, not in a child of it. sf listens for no
 * stop signal: at Ctrl-C the terminal signals the whole group, sf dies at
 * once, and a child would go on writing after the shell's prompt; had sf
 * passed the signal on, the child would get it twice, and a script takes the
 * second one as "end at once", its summary of what it wrote lost. In the one
 * process there is one signal, and the script's own handling of it.
 */

import { extname, join } from 'node:path';
import { main, type Tool } from './sandforge.js';

/** How the line reaches the dispatcher: `main` of `sandforge.ts` by default. */
export type Dispatcher = (argv: readonly string[]) => Promise<void>;

/**
 * The dispatcher's file beside this one, with this file's extension:
 * `lib/sandforge.mjs` packaged, `sandforge.ts` from a checkout.
 */
export function dispatcherFile(folder: string = __dirname, file: string = __filename): string {
  return join(folder, `sandforge${extname(file)}`);
}

/**
 * Run a command of `sandforge` with the words sf hands the command's class:
 * the line `bin/sandforge.mjs` would hand the dispatcher, nothing taken out
 * of it and nothing added, `--` and `--help` included.
 *
 * @param tool - The command; `''` for `sf sandforge` alone.
 * @param argv - The words after the command's id, as sf hands them.
 */
export async function runTool(
  tool: Tool | '',
  argv: readonly string[],
  dispatch: Dispatcher = main,
  folder: string = __dirname,
  file: string = __filename,
): Promise<void> {
  await dispatch([
    process.execPath,
    dispatcherFile(folder, file),
    ...(tool === '' ? [] : [tool]),
    ...argv,
  ]);
}

/** An entry of a menu of the sfdx-hardis VS Code extension. */
export interface HardisCommand {
  id: string;
  label: string;
  command: string;
  tooltip: string;
  helpUrl: string;
  vscodeIcon: string;
  sldsIcon: string;
}

/** A menu of the sfdx-hardis VS Code extension: a card of its Welcome page, a section of its Commands panel. */
export interface HardisMenu {
  id: string;
  label: string;
  description: string;
  vscodeIcon: string;
  sldsIcon: string;
  commands: readonly HardisCommand[];
}

const DOCS = 'https://github.com/StephaneBerthoz/sandforge/blob/master';

/**
 * The menu `sf sandforge:hardis-commands --json` gives the sfdx-hardis VS Code
 * extension, which asks each plugin it finds installed for one. sfdx-hardis
 * runs an entry in the background, with no terminal: no question could be
 * answered there, and a write asks for its org's alias typed. Each entry
 * reads no org and writes nothing; every other command is run in a terminal.
 */
export const HARDIS_MENUS: readonly HardisMenu[] = [
  {
    id: 'sandforge',
    label: 'SandForge',
    description:
      'Test data between Salesforce orgs: what SandForge holds on this machine, read without ' +
      'reaching an org; every other command runs in a terminal, sf sandforge <command>.',
    vscodeIcon: 'database',
    sldsIcon: 'utility:database',
    commands: [
      {
        id: 'sandforge-help',
        label: 'Commands and their help',
        command: 'sf sandforge --help',
        tooltip:
          "SandForge's commands; sf sandforge <command> --help gives a command's options and exit codes",
        helpUrl: `${DOCS}/packages/cli/README.md`,
        vscodeIcon: 'question',
        sldsIcon: 'utility:help',
      },
      {
        id: 'sandforge-templates',
        label: 'Seed templates',
        command: 'sf sandforge seed --list-templates',
        tooltip: 'Name the built-in templates Seed fills an org from; reaches no org',
        helpUrl: `${DOCS}/docs/modules/seed.md`,
        vscodeIcon: 'list-unordered',
        sldsIcon: 'utility:list',
      },
      {
        id: 'sandforge-yaml-validate',
        label: 'Validate sandforge.yaml',
        command: 'sf sandforge env validate',
        tooltip:
          "Check this folder's sandforge.yaml offline: its schema, each resource, their order, " +
          'the variables it names; reaches no org',
        helpUrl: `${DOCS}/docs/environments.md`,
        vscodeIcon: 'check',
        sldsIcon: 'utility:check',
      },
      {
        id: 'sandforge-yaml-state',
        label: 'Environments on this machine',
        command: 'sf sandforge env state',
        tooltip: 'List the sandforge.yaml environments this machine keeps; reaches no org',
        helpUrl: `${DOCS}/docs/environments.md`,
        vscodeIcon: 'list-tree',
        sldsIcon: 'utility:database',
      },
    ],
  },
];

/** Where `hardisCommands` writes: stdout and stderr by default. */
export interface Writers {
  out: (text: string) => void;
  err: (text: string) => void;
}

const STD: Writers = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/**
 * `sf sandforge:hardis-commands`: with `--json`, the one document sfdx-hardis
 * reads (`result.customCommands`), alone on stdout; without it, the entries
 * for a reader. Any other word is refused on 2, as every command refuses a
 * flag it does not read.
 *
 * @returns The exit code.
 */
export function hardisCommands(argv: readonly string[], write: Writers = STD): number {
  const strange = argv.find((word) => word !== '--json');
  if (strange !== undefined) {
    write.err(
      `"${strange}" is not a flag sandforge:hardis-commands reads: --json, or nothing. ` +
        'Nothing was run.\n',
    );
    return 2;
  }
  if (argv.includes('--json')) {
    write.out(`${JSON.stringify({ status: 0, result: { customCommands: HARDIS_MENUS } })}\n`);
    return 0;
  }
  const entries = HARDIS_MENUS.flatMap((menu) => menu.commands);
  const width = Math.max(...entries.map((entry) => entry.label.length));
  write.out(
    'The entries SandForge adds to the menus of the sfdx-hardis VS Code extension, ' +
      'each reaching no org:\n' +
      entries.map((entry) => `  ${entry.label.padEnd(width)}  ${entry.command}\n`).join(''),
  );
  return 0;
}
