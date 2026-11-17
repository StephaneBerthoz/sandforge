/**
 * The `init` hook of the `sandforge` plugin of the Salesforce CLI: `sf
 * sandforge clone --help` prints the help of `npx sandforge clone --help`,
 * word for word.
 *
 * oclif answers `--help` and `-h` itself, before it looks for the command,
 * from what the plugin's manifest says of the command. Its formatter wraps
 * every line with its indentation trimmed: the 821 lines of clone's help came
 * out with the columns of its options and the table of its exit codes
 * flattened, `-h` under sf kept its usage alone, and the help of a verb
 * (`pipeline plan --help`) could not be reached. oclif runs the `init` hooks
 * before it reads the help flags: for a command of this plugin asked for its
 * help, the hook runs the package's own `bin/sandforge.mjs` with the line, its
 * output the terminal's, then ends the process on its exit code. bin/ refuses
 * a Node older than the package's floor with the sentence it always says.
 *
 * It is loaded by every `sf` command of whoever installed the plugin: it
 * imports nothing of the scripts, and leaves every other line to sf.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PLUGIN = 'sandforge';

/** A command as oclif finds it: from the manifest, for any plugin. */
export interface FoundCommand {
  id: string;
  pluginName?: string;
  hidden?: boolean;
}

/** What oclif hands a hook as `this`: the CLI's configuration, which finds a command by any id it answers to. */
export interface HookContext {
  config: { findCommand(id: string): FoundCommand | undefined };
}

/** What oclif hands an `init` hook: the command's id as typed, and the words after it. */
export interface InitOptions {
  id?: string;
  argv?: readonly string[];
}

/** The flags oclif reads for help: its own and the one sf adds. */
const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * The words `bin/sandforge.mjs` is run with for this line, or undefined when
 * the line is sf's: a command of another plugin, a hidden one, or no help
 * flag before `--`, the rule oclif reads its help flags by.
 *
 * @param id - The id as sf normalized the line; its words in another order
 *   find the same command under sf's flexible taxonomy.
 */
export function helpLineOf(
  config: HookContext['config'],
  id: string | undefined,
  argv: readonly string[],
): string[] | undefined {
  if (id === undefined) return undefined;
  const command = config.findCommand(id);
  if (command === undefined || command.pluginName !== PLUGIN || command.hidden === true) {
    return undefined;
  }
  const end = argv.indexOf('--');
  const before = end === -1 ? argv : argv.slice(0, end);
  if (!before.some((word) => HELP_FLAGS.has(word))) return undefined;
  const tool = command.id === PLUGIN ? [] : [command.id.slice(PLUGIN.length + 1)];
  return [...tool, ...argv];
}

/** How the hook runs bin/ and ends: a child on the terminal, then the process's exit. */
export interface HookIo {
  spawn: (file: string, args: readonly string[]) => number | null;
  exit: (code: number) => void;
  bin: string;
}

/** The package's `bin/sandforge.mjs`, from the folder of the bundled hook (`lib/`). */
export function binFile(folder: string = __dirname): string {
  return join(folder, '..', 'bin', 'sandforge.mjs');
}

/** The hook, with how it runs bin/ and ends given. */
export function helpHook(io: HookIo) {
  return async function sandforgeHelp(this: HookContext, options: InitOptions): Promise<void> {
    const words = helpLineOf(this.config, options.id, options.argv ?? []);
    if (words === undefined) return;
    // A child ended by a signal has no status: the help was not printed.
    io.exit(io.spawn(io.bin, words) ?? 1);
  };
}

export default helpHook({
  spawn: (file, args) => spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' }).status,
  exit: (code) => process.exit(code),
  bin: binFile(),
});
